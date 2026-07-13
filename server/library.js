// server/library.js
// A PERSISTENT video library: users upload videos once, we transcode each to a
// WebM the presenter bot can decode, and keep them on disk to be reused for any
// number of scheduled presentations.
//
// This is the app's only on-disk persisted state. It lives in its own directory
// (LIBRARY_DIR), deliberately separate from the ephemeral `uploads/` dir so the
// startup sweep and per-job cleanup in index.js never touch a library video.
//
// Upload is NON-BLOCKING: the HTTP handler saves the raw file and returns
// immediately with a `queued` item; a single background worker (concurrency 1)
// transcodes items one at a time. Serial on purpose — transcode.js notes the ARM
// VM chokes when several ffmpeg encodes run at once.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { v4 as uuidv4 } from 'uuid';

import { transcodeToWebm } from './transcode.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The predefined location every library video is saved to.
export const LIBRARY_DIR = path.join(__dirname, '..', 'library');
const MANIFEST_BASENAME = 'library.json';
const MANIFEST_PATH = path.join(LIBRARY_DIR, MANIFEST_BASENAME);

// item: { id, name, status, webmFile, sizeBytes, createdAt, error, rawPath }
//   status: 'queued' | 'transcoding' | 'ready' | 'error'
//   rawPath is transient (the source file awaiting/undergoing transcode) and is
//   never serialized or persisted.
const items = new Map();

// FIFO of item ids waiting to be transcoded, drained by pump().
const queue = [];
let pumping = false;

// ── Chunked uploads ───────────────────────────────────────────────────────────
// Large files are uploaded in chunks so each request stays under the ~100 MB
// per-request cap of the CDN in front of the app; the server appends them back
// into one raw file, then feeds it into the same transcode queue.
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024; // 4 GB total per video
export const UPLOAD_CHUNK_BYTES = 80 * 1024 * 1024;     // recommended client chunk size
const UPLOAD_SESSION_TTL_MS = 60 * 60 * 1000;           // drop idle sessions after 1h
// uploadId -> { id, name, filePath, receivedBytes, lastActivity }
const uploads = new Map();

// Best-effort delete; ENOENT (already gone) is fine and stays quiet.
function safeUnlink(filePath) {
  if (!filePath) return Promise.resolve();
  return fs.promises.unlink(filePath).catch((err) => {
    if (err.code !== 'ENOENT') console.error(`[Library] delete failed ${filePath}: ${err.message}`);
  });
}

// Public (serializable) view of an item — drops the transient rawPath.
function toPublic(item) {
  return {
    id: item.id,
    name: item.name,
    status: item.status,
    webmFile: item.webmFile || null,
    sizeBytes: item.sizeBytes ?? null,
    createdAt: item.createdAt,
    error: item.error || null,
    // 0-99 while transcoding (null when unknown/not applicable) — long encodes
    // of multi-GB files are visible in the UI instead of an opaque spinner.
    progress: item.status === 'transcoding' ? (item.progress ?? null) : null,
  };
}

// Write the manifest with only the ready items — in-flight/errored items live in
// memory only, so a restart naturally forgets interrupted work.
function persist() {
  const ready = Array.from(items.values())
    .filter((it) => it.status === 'ready')
    .map((it) => ({
      id: it.id,
      name: it.name,
      webmFile: it.webmFile,
      sizeBytes: it.sizeBytes,
      createdAt: it.createdAt,
    }));
  try {
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify({ items: ready }, null, 2));
  } catch (err) {
    console.error(`[Library] Failed to write manifest: ${err.message}`);
  }
}

/**
 * Prepare the library dir and reconcile it with the manifest.
 * Reloads ready items whose .webm still exists, and deletes any other file
 * (leftover raw uploads / orphaned webm from a transcode interrupted by a crash).
 */
export function init() {
  fs.mkdirSync(LIBRARY_DIR, { recursive: true });

  let manifest = [];
  try {
    manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')).items || [];
  } catch {
    manifest = [];
  }

  const keep = new Set([MANIFEST_BASENAME]);
  for (const m of manifest) {
    if (!m.webmFile) continue;
    if (fs.existsSync(path.join(LIBRARY_DIR, m.webmFile))) {
      items.set(m.id, {
        id: m.id,
        name: m.name,
        status: 'ready',
        webmFile: m.webmFile,
        sizeBytes: m.sizeBytes ?? null,
        createdAt: m.createdAt,
        error: null,
        rawPath: null,
      });
      keep.add(m.webmFile);
    }
  }

  // Sweep anything not referenced by a ready item — stray raws and half-written
  // webm files from a transcode that a restart interrupted.
  let swept = 0;
  try {
    for (const name of fs.readdirSync(LIBRARY_DIR)) {
      if (keep.has(name)) continue;
      safeUnlink(path.join(LIBRARY_DIR, name));
      swept += 1;
    }
  } catch { /* dir just created / unreadable — nothing to sweep */ }

  if (swept) console.log(`[Library] Swept ${swept} orphaned file(s) on startup`);
  console.log(`[Library] Loaded ${items.size} ready video(s)`);
  persist(); // rewrite the manifest to reflect the reconciled state

  // Reap abandoned chunked-upload sessions periodically.
  setInterval(sweepUploadSessions, 10 * 60 * 1000);
}

/**
 * Register uploaded files (multer disk files, already written to LIBRARY_DIR as
 * "<id>.orig<ext>") as queued library items and kick off background transcoding.
 * Returns immediately with the created items — transcoding happens later.
 * @param {Array<{ filename: string, path: string, originalname: string, size: number }>} files
 * @returns {Array<object>} public views of the created items
 */
export function addUploads(files = []) {
  const created = [];
  for (const file of files) {
    // The multer filename is "<uuid>.orig<ext>"; the uuid is the item id.
    const id = file.filename.slice(0, file.filename.indexOf('.orig'));
    const item = {
      id,
      name: file.originalname,
      status: 'queued',
      webmFile: null,
      sizeBytes: file.size,
      createdAt: new Date().toISOString(),
      error: null,
      rawPath: file.path,
    };
    items.set(id, item);
    queue.push(id);
    created.push(toPublic(item));
  }
  if (created.length) pump();
  return created;
}

// Drain the transcode queue one item at a time.
async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (queue.length) {
      const id = queue.shift();
      const item = items.get(id);
      if (!item || item.status !== 'queued') continue; // deleted while queued

      item.status = 'transcoding';
      item.progress = 0;
      const rawPath = item.rawPath;
      try {
        const produced = await transcodeToWebm(rawPath, {
          onProgress: (pct) => { item.progress = pct; },
        });
        const webmFile = `${id}.webm`;
        const webmPath = path.join(LIBRARY_DIR, webmFile);
        await fs.promises.rename(produced, webmPath);
        await safeUnlink(rawPath);

        if (!items.has(id)) {
          // Deleted mid-transcode — discard the output we just produced.
          await safeUnlink(webmPath);
          continue;
        }
        const stat = await fs.promises.stat(webmPath);
        item.webmFile = webmFile;
        item.sizeBytes = stat.size;
        item.rawPath = null;
        item.status = 'ready';
        persist();
        console.log(`[Library] Ready: ${item.name} → ${webmFile}`);
      } catch (err) {
        await safeUnlink(rawPath);
        if (items.has(id)) {
          item.status = 'error';
          item.error = err.message;
          item.rawPath = null;
        }
        console.warn(`[Library] Transcode failed for ${item.name}: ${err.message}`);
      }
    }
  } finally {
    pumping = false;
  }
}

/** All library items, newest first (serializable, no rawPath). */
export function listItems() {
  return Array.from(items.values())
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map(toPublic);
}

/** A single item (live record), or null. */
export function getItem(id) {
  return items.get(id) || null;
}

/** A single item only if it has finished transcoding, else null. */
export function getReadyItem(id) {
  const item = items.get(id);
  return item && item.status === 'ready' ? item : null;
}

/**
 * Remove an item and its files. Safe to call while it is queued/transcoding —
 * the worker notices it is gone and discards its output.
 * @returns {boolean} whether an item was removed
 */
export function deleteItem(id) {
  const item = items.get(id);
  if (!item) return false;
  items.delete(id);
  if (item.webmFile) safeUnlink(path.join(LIBRARY_DIR, item.webmFile));
  if (item.rawPath) safeUnlink(item.rawPath);
  persist();
  return true;
}

// ── Chunked-upload API ────────────────────────────────────────────────────────

/**
 * Open a chunked-upload session. Returns an opaque uploadId the client posts
 * chunks to. The raw file is created empty and appended to, in order.
 * @param {{ name: string, filename?: string }} input
 *   name     - the display name the video is saved/searched under
 *   filename - the original filename, used only for the raw file's extension
 * @returns {{ uploadId: string }}
 */
export function beginUpload({ name, filename }) {
  fs.mkdirSync(LIBRARY_DIR, { recursive: true });
  const id = uuidv4();
  const uploadId = uuidv4();
  const ext = path.extname(String(filename || '')).toLowerCase() || '.mp4';
  const filePath = path.join(LIBRARY_DIR, `${id}.orig${ext}`);
  fs.writeFileSync(filePath, ''); // start empty; chunks append in order
  uploads.set(uploadId, { id, name, filePath, receivedBytes: 0, lastActivity: Date.now() });
  return { uploadId };
}

/**
 * Append one chunk (a readable stream) to the session's raw file, in order.
 * @param {string} uploadId
 * @param {import('node:stream').Readable} readable
 * @param {number} declaredBytes Content-Length of the chunk, for an early cap check
 * @returns {Promise<number>} total bytes received so far
 */
export function appendChunk(uploadId, readable, declaredBytes = 0) {
  const s = uploads.get(uploadId);
  if (!s) return Promise.reject(new Error('Unknown or expired upload session'));
  if (s.receivedBytes + declaredBytes > MAX_UPLOAD_BYTES) {
    abortUpload(uploadId);
    return Promise.reject(new Error('Upload exceeds the maximum allowed size'));
  }
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(s.filePath, { flags: 'a' });
    const fail = (err) => { ws.destroy(); reject(err); };
    readable.on('error', fail);
    ws.on('error', fail);
    ws.on('finish', () => {
      s.receivedBytes += ws.bytesWritten;
      s.lastActivity = Date.now();
      resolve(s.receivedBytes);
    });
    readable.pipe(ws);
  });
}

/**
 * Finalize a session: turn the reassembled raw file into a queued library item
 * and kick off transcoding. Returns the public item, or null if the session is
 * unknown or received no bytes.
 */
export function completeUpload(uploadId) {
  const s = uploads.get(uploadId);
  if (!s) return null;
  uploads.delete(uploadId);
  if (s.receivedBytes <= 0) {
    safeUnlink(s.filePath);
    return null;
  }
  const item = {
    id: s.id,
    name: s.name,
    status: 'queued',
    webmFile: null,
    sizeBytes: s.receivedBytes,
    createdAt: new Date().toISOString(),
    error: null,
    rawPath: s.filePath,
  };
  items.set(s.id, item);
  queue.push(s.id);
  pump();
  return toPublic(item);
}

/** Abandon a session, deleting its partial file. @returns {boolean} */
export function abortUpload(uploadId) {
  const s = uploads.get(uploadId);
  if (!s) return false;
  uploads.delete(uploadId);
  safeUnlink(s.filePath);
  return true;
}

// Drop upload sessions gone idle (client vanished mid-upload) so their partial
// files don't linger. Ready items and in-flight transcodes are unaffected.
function sweepUploadSessions() {
  const now = Date.now();
  for (const [uploadId, s] of uploads) {
    if (now - s.lastActivity > UPLOAD_SESSION_TTL_MS) {
      uploads.delete(uploadId);
      safeUnlink(s.filePath);
    }
  }
}
