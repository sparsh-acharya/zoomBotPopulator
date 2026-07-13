// server/transcode.js
// Turn an uploaded video into a WebM the presenter bot can actually decode.
//
// The presenter bot runs Playwright's BUNDLED Chromium, which is built WITHOUT
// proprietary codecs — no H.264, no AAC. A normal .mp4 (H.264/AAC) therefore
// fails to play in the bot's <video> ("no supported source was found") and the
// screen share is a black, silent frame. VP8 video + Opus audio in a WebM
// container play natively in that Chromium, fixing both video and audio.
//
// We also downscale to <=720p / 30fps: the headless ARM VM must RE-ENCODE the
// captured surface for Zoom in real time, and 1080p60 chokes it. 720p30 is
// plenty for a shared clip and keeps the pipeline smooth. Encoding runs once,
// at upload, so its cost never touches playback.
//
// Built for multi-GB files:
//  - Sources that are ALREADY WebM-compatible (VP8/VP9/AV1 + Opus/Vorbis) are
//    remuxed with -c copy — seconds, regardless of size.
//  - There is NO fixed overall timeout (a 4 GB file legitimately encodes for a
//    long time on the ARM VM). Instead a watchdog kills ffmpeg only when it
//    STALLS — out_time stops advancing — plus an absolute backstop scaled to
//    the clip's duration as a last resort.
//  - Progress (0-99%) is reported via onProgress so the library UI can show it.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

// Overridable in case the binaries aren't on PATH (e.g. a custom install).
const FFMPEG_BIN = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE_BIN = process.env.FFPROBE_PATH || 'ffprobe';

// Kill ffmpeg only when output time stops advancing for this long. Generous on
// purpose: demuxing/analyzing a multi-GB file can take a while before the
// first frames flow.
const STALL_TIMEOUT_MS = 2 * 60 * 1000;
const STALL_CHECK_INTERVAL_MS = 10 * 1000;
// Absolute backstop: 8x the clip's duration, floored at 30 min. When probing
// couldn't determine a duration, fall back to a large fixed ceiling — the
// stall watchdog is the real protection.
const ABSOLUTE_CAP_MIN_MS = 30 * 60 * 1000;
const ABSOLUTE_CAP_DURATION_MULTIPLE = 8;
const ABSOLUTE_CAP_UNKNOWN_MS = 6 * 60 * 60 * 1000;
// Keep only the tail of ffmpeg's (verbose) stderr for error messages.
const STDERR_KEEP_BYTES = 8_000;
const PROBE_TIMEOUT_MS = 60 * 1000;
const ENCODE_THREADS = Math.max(1, os.cpus().length);

// Codecs the bot's Chromium already decodes inside a WebM container — these
// sources are remuxed, never re-encoded.
const WEBM_VIDEO_CODECS = new Set(['vp8', 'vp9', 'av1']);
const WEBM_AUDIO_CODECS = new Set(['opus', 'vorbis']);

/**
 * Probe a media file's duration and codecs with ffprobe.
 * Best-effort: resolves nulls for anything it can't determine and never
 * rejects — a broken file surfaces its real error in the transcode itself.
 *
 * @param {string} inputPath
 * @returns {Promise<{ durationSec: number|null, videoCodec: string|null, audioCodec: string|null }>}
 */
export function probeMedia(inputPath) {
  const args = [
    '-v', 'error',
    '-show_entries', 'format=duration:stream=codec_type,codec_name',
    '-of', 'json',
    inputPath,
  ];
  const empty = { durationSec: null, videoCodec: null, audioCodec: null };
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(FFPROBE_BIN, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return resolve(empty);
    }
    let out = '';
    const timer = setTimeout(() => proc.kill('SIGKILL'), PROBE_TIMEOUT_MS);
    proc.stdout.on('data', (d) => { out += d; });
    proc.on('error', () => { clearTimeout(timer); resolve(empty); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve(empty);
      try {
        const parsed = JSON.parse(out);
        const duration = Number(parsed.format?.duration);
        const streams = parsed.streams || [];
        const video = streams.find((s) => s.codec_type === 'video');
        const audio = streams.find((s) => s.codec_type === 'audio');
        resolve({
          durationSec: Number.isFinite(duration) && duration > 0 ? duration : null,
          videoCodec: video?.codec_name || null,
          audioCodec: audio?.codec_name || null,
        });
      } catch {
        resolve(empty);
      }
    });
  });
}

// Extract the LAST "out_time=HH:MM:SS.micro" in a -progress chunk as seconds
// (a single data event can carry several progress blocks).
function parseOutTimeSec(text) {
  let sec = null;
  for (const m of text.matchAll(/out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)) {
    sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  }
  return sec;
}

/**
 * Run ffmpeg with stall detection instead of a fixed timeout.
 * @param {string[]} args ffmpeg args (without the -progress/-nostats prefix)
 * @param {{ durationSec?: number|null, onProgress?: (pct:number)=>void, label?: string }} opts
 */
function runFfmpeg(args, { durationSec = null, onProgress = null, label = 'transcode' } = {}) {
  const absoluteCapMs = durationSec
    ? Math.max(ABSOLUTE_CAP_MIN_MS, durationSec * 1000 * ABSOLUTE_CAP_DURATION_MULTIPLE)
    : ABSOLUTE_CAP_UNKNOWN_MS;

  return new Promise((resolve, reject) => {
    // -progress pipe:1 emits machine-readable out_time lines on stdout;
    // -nostats keeps stderr to real errors only.
    const proc = spawn(FFMPEG_BIN, ['-nostats', '-progress', 'pipe:1', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    let lastOutTimeSec = -1;
    let lastAdvanceAt = Date.now();
    let settled = false;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearInterval(stallTimer);
      clearTimeout(capTimer);
      if (err) reject(err); else resolve();
    };
    const killWith = (message) => {
      proc.kill('SIGKILL');
      finish(new Error(message));
    };

    const stallTimer = setInterval(() => {
      if (Date.now() - lastAdvanceAt > STALL_TIMEOUT_MS) {
        killWith(`ffmpeg ${label} stalled — no progress for ${STALL_TIMEOUT_MS / 1000}s`);
      }
    }, STALL_CHECK_INTERVAL_MS);
    const capTimer = setTimeout(() => {
      killWith(`ffmpeg ${label} exceeded the absolute time cap (${Math.round(absoluteCapMs / 60_000)} min)`);
    }, absoluteCapMs);

    proc.stdout.on('data', (d) => {
      const sec = parseOutTimeSec(d.toString());
      if (sec != null && sec > lastOutTimeSec) {
        lastOutTimeSec = sec;
        lastAdvanceAt = Date.now();
        // Cap at 99 — only a successful exit means 100%.
        if (onProgress && durationSec) {
          onProgress(Math.min(99, Math.floor((sec / durationSec) * 100)));
        }
      }
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > STDERR_KEEP_BYTES) stderr = stderr.slice(-STDERR_KEEP_BYTES);
    });

    proc.on('error', (err) => finish(err)); // ENOENT when ffmpeg isn't installed
    proc.on('close', (code) => {
      if (code === 0) finish(null);
      else finish(new Error(`ffmpeg ${label} exited ${code}: ${stderr.slice(-500)}`));
    });
  });
}

/**
 * Convert `inputPath` to a sibling `.webm` (VP8 + Opus, <=720p30), remuxing
 * instead when the source codecs are already WebM-compatible. Never upscales:
 * sources at or below 720p keep their height.
 *
 * @param {string} inputPath absolute path to the source video
 * @param {{ onProgress?: (pct: number) => void }} [opts] 0-99 percent reporter
 * @returns {Promise<string>} absolute path to the produced .webm
 * @throws if ffmpeg is missing (ENOENT), stalls, or exits non-zero.
 */
export async function transcodeToWebm(inputPath, { onProgress } = {}) {
  // Swap the extension for .webm; guard the (rare) case the input already is one.
  const base = inputPath.replace(/\.[^.\\/]+$/, '');
  let target = `${base}.webm`;
  if (target === inputPath) target = `${base}-vp8.webm`;

  const { durationSec, videoCodec, audioCodec } = await probeMedia(inputPath);

  // Fast path: already-compatible codecs are stream-copied into a WebM in
  // seconds, no matter the file size. Map only the first video/audio stream —
  // WebM rejects other stream kinds (data/subtitles) a source might carry.
  const remuxable =
    WEBM_VIDEO_CODECS.has(videoCodec) &&
    (audioCodec == null || WEBM_AUDIO_CODECS.has(audioCodec));
  if (remuxable) {
    console.log(
      `[Transcode] ${videoCodec}/${audioCodec || 'no audio'} is already WebM-compatible — remuxing`
    );
    try {
      await runFfmpeg(
        ['-y', '-i', inputPath, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', target],
        { durationSec, onProgress, label: 'remux' }
      );
      return target;
    } catch (err) {
      // e.g. an exotic container quirk -c copy chokes on; the full encode
      // below (-y) overwrites whatever partial output the remux left.
      console.warn(`[Transcode] Remux failed (${err.message}) — falling back to a full encode`);
    }
  }

  const args = [
    '-y',
    '-i', inputPath,
    // Downscale to <=720 tall (even width, keep aspect) and cap 30fps. The
    // escaped comma keeps min(720,ih) inside the scale filter rather than being
    // read as a filterchain separator.
    '-vf', 'scale=-2:min(720\\,ih),fps=30',
    '-c:v', 'libvpx',
    '-b:v', '2M',
    // realtime + a high cpu-used trades quality for speed so multi-GB encodes
    // finish in a fraction of realtime even on the ARM box.
    '-deadline', 'realtime',
    '-cpu-used', '8',
    '-auto-alt-ref', '0',
    '-threads', String(ENCODE_THREADS),
    // Opus for audio; if the source has no audio track this simply produces a
    // video-only WebM (ffmpeg maps whatever streams exist).
    '-c:a', 'libopus',
    '-b:a', '128k',
    target,
  ];

  try {
    await runFfmpeg(args, { durationSec, onProgress, label: 'encode' });
  } catch (err) {
    // Don't leave a partial .webm on disk until the next restart sweep.
    await fs.promises.unlink(target).catch(() => {});
    throw err;
  }
  return target;
}
