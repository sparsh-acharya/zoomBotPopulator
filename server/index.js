// server/index.js
// Express app: route definitions, request validation, response shaping.
// No business logic here — Playwright lives in botManager.js, JWTs in signature.js.

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';

import { generateSignature, ROLE_PARTICIPANT, ROLE_HOST } from './signature.js';
import { launchBot, stopBot, listActiveBots, listBotHistory, hasBot, getBotStatus } from './botManager.js';
import { generateNames } from './names.js';
import {
    getAuthorizeUrl,
    exchangeCode,
    isConnected,
    getMe,
    getZak,
    createMeeting,
} from './zoomApi.js';
import {
    onFire,
    onRemove,
    setBotStatusResolver,
    schedule,
    listJobs,
    getJob,
    cancel as cancelJob,
    remove as removeJob,
} from './scheduler.js';
import { startTunnel } from './tunnel.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ── Uploaded-video cleanup helpers ────────────────────────────────────────────
// Resolve a stored videoUrl (/uploads/<name>) to an absolute path, guarding
// against path traversal by keeping only the basename.
function uploadPathFromUrl(videoUrl) {
    if (!videoUrl) return null;
    return path.join(UPLOADS_DIR, path.basename(videoUrl));
}

// Best-effort delete; ENOENT (already gone) is fine and stays quiet.
function deleteUploadFile(filePath) {
    if (!filePath) return;
    fs.promises.unlink(filePath).catch((err) => {
        if (err.code !== 'ENOENT') console.error(`[Uploads] delete failed ${filePath}: ${err.message}`);
    });
}

// Remove a just-uploaded file when the request fails before a job owns it.
function cleanupOrphan(req) {
    if (req.file?.path) deleteUploadFile(req.file.path);
}

// On startup, delete every uploaded file: schedules live only in memory, so any
// file on disk after a restart is unreferenced. Also passed a set of names to
// keep (empty at boot) for future-proofing if persistence is added.
function sweepUploads(keep = new Set()) {
    let names;
    try {
        names = fs.readdirSync(UPLOADS_DIR);
    } catch {
        return;
    }
    let removed = 0;
    for (const name of names) {
        if (keep.has(name)) continue;
        deleteUploadFile(path.join(UPLOADS_DIR, name));
        removed += 1;
    }
    if (removed) console.log(`[Uploads] Swept ${removed} orphaned file(s) on startup`);
}

// ── Video upload (multer, disk storage) ───────────────────────────────────────
const ALLOWED_VIDEO_EXT = new Set(['.mp4', '.webm', '.ogg', '.mov', '.m4v']);
const MAX_VIDEO_BYTES = 500 * 1024 * 1024; // 500 MB
const uploadStorage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, `${uuidv4()}${ALLOWED_VIDEO_EXT.has(ext) ? ext : '.mp4'}`);
    },
});
const uploadVideo = multer({
    storage: uploadStorage,
    limits: { fileSize: MAX_VIDEO_BYTES },
    fileFilter: (_req, file, cb) => cb(null, ALLOWED_VIDEO_EXT.has(path.extname(file.originalname).toLowerCase())),
}).single('video');

const PORT = process.env.PORT || 3000;
const ZOOM_SDK_KEY = process.env.ZOOM_SDK_KEY;
const ZOOM_SDK_SECRET = process.env.ZOOM_SDK_SECRET;

const DIGITS_ONLY = /^\d+$/;
const BOT_ID_LENGTH = 8;
// What a presenter bot does once the clip finishes (chosen per schedule):
// loop = replay until duration; hold = freeze until duration; end = leave now.
const END_BEHAVIORS = new Set(['loop', 'hold', 'end']);
// Each bot is a separate headless Chromium (~200-500MB RAM), so cap how many
// a single launch request may spawn.
const MAX_BOTS_PER_REQUEST = 10;

// Matches the meeting id in Zoom join links: /j/<id>, /wc/<id>, or /s/<id>.
const ZOOM_URL_MEETING_ID = /\/(?:j|wc|s)\/(\d+)/;

/**
 * Parse a Zoom join URL into { meetingNumber, password }.
 * Note: the `pwd` query param is Zoom's encrypted passcode token, which the
 * Web SDK accepts for joining. For meetings where it doesn't, use the manual
 * meeting-number + passcode fields instead.
 * @throws if the URL is malformed or has no meeting number.
 */
function parseMeetingUrl(rawUrl) {
    let url;
    try {
        url = new URL(String(rawUrl).trim());
    } catch {
        throw new Error('Invalid meeting URL');
    }
    const match = url.pathname.match(ZOOM_URL_MEETING_ID);
    if (!match) {
        throw new Error('Could not find a meeting number in the URL');
    }
    return { meetingNumber: match[1], password: url.searchParams.get('pwd') || '' };
}

// ── Fail fast if credentials are missing ──────────────────────────────────────
if (!ZOOM_SDK_KEY || !ZOOM_SDK_SECRET) {
    console.error(
        '[Server] FATAL: ZOOM_SDK_KEY and ZOOM_SDK_SECRET must be set in .env. Exiting.'
    );
    process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json());

// Cross-origin isolation for the bot pages ONLY. The Zoom Web SDK's audio
// encoder/decoder runs in a worker backed by SharedArrayBuffer, which the
// browser only exposes when the page is crossOriginIsolated. Without these
// headers, connecting computer audio fails with `OPERATION_TIMEOUT` (errorCode 1).
// COEP `credentialless` lets us still load the SDK from the esm.sh CDN without
// requiring it to send CORP headers. Scoped to the bot pages so the dashboard's
// cross-origin assets (Google Fonts, etc.) keep working.
const ISOLATED_PAGES = new Set(['/bot.html', '/host-bot.html']);
app.use((req, res, next) => {
    if (ISOLATED_PAGES.has(req.path)) {
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
    }
    next();
});

// Uploaded presentation videos. Same-origin with the host-bot page, so they
// load fine under COEP credentialless without extra CORP headers.
app.use('/uploads', express.static(UPLOADS_DIR));

app.use(express.static(PUBLIC_DIR));

// ── POST /api/signature ───────────────────────────────────────────────────────
// Returns a signature + public sdkKey. Secret never appears in the response.
app.post('/api/signature', (req, res) => {
    try {
        const meetingNumber = String(req.body?.meetingNumber ?? '').replace(/\s/g, '');
        const role = req.body?.role === 1 ? 1 : ROLE_PARTICIPANT;

        if (!DIGITS_ONLY.test(meetingNumber)) {
            return res.status(400).json({ error: 'meetingNumber must contain digits only' });
        }

        const signature = generateSignature(ZOOM_SDK_KEY, ZOOM_SDK_SECRET, meetingNumber, role);
        return res.json({ signature, sdkKey: ZOOM_SDK_KEY });
    } catch (err) {
        console.error('[Server] /api/signature error:', err.message);
        return res.status(500).json({ error: 'Failed to generate signature' });
    }
});

// ── POST /api/bot/launch ──────────────────────────────────────────────────────
app.post('/api/bot/launch', async (req, res) => {
    try {
        const leaveMode = req.body?.leaveMode; // 'timer' | 'meeting-end'

        // Primary path: a full Zoom join URL. Fallback: manual number + passcode.
        let meetingNumber;
        let password;
        const meetingUrl = req.body?.meetingUrl;
        if (meetingUrl && String(meetingUrl).trim()) {
            try {
                ({ meetingNumber, password } = parseMeetingUrl(meetingUrl));
            } catch (parseErr) {
                return res.status(400).json({ error: parseErr.message });
            }
        } else {
            meetingNumber = String(req.body?.meetingNumber ?? '').replace(/\s/g, '');
            password = String(req.body?.password ?? '');
        }

        if (!DIGITS_ONLY.test(meetingNumber)) {
            return res.status(400).json({ error: 'Provide a valid meeting URL or a digits-only meeting number' });
        }
        if (leaveMode !== 'timer' && leaveMode !== 'meeting-end') {
            return res.status(400).json({ error: "leaveMode must be 'timer' or 'meeting-end'" });
        }

        let leaveAfterMs = null;
        if (leaveMode === 'timer') {
            leaveAfterMs = Number(req.body?.leaveAfterMs);
            if (!Number.isFinite(leaveAfterMs) || leaveAfterMs <= 0) {
                return res.status(400).json({ error: 'leaveAfterMs must be a positive number in timer mode' });
            }
        }

        // Name mode: 'custom' fires exactly one bot with the given name; 'random'
        // assigns a random Indian name per bot and allows a count.
        const nameMode = req.body?.nameMode === 'custom' ? 'custom' : 'random';
        let count = 1;
        let customName = '';
        if (nameMode === 'custom') {
            customName = String(req.body?.customName ?? '').trim();
            if (!customName) {
                return res.status(400).json({ error: 'customName is required when nameMode is "custom"' });
            }
            count = 1; // a custom name always launches a single bot
        } else {
            count = Number(req.body?.count ?? 1);
            if (!Number.isInteger(count) || count < 1) count = 1;
            if (count > MAX_BOTS_PER_REQUEST) {
                return res.status(400).json({ error: `count must be between 1 and ${MAX_BOTS_PER_REQUEST}` });
            }
        }

        // Male ratio (0-100) for random names; defaults to 50.
        let maleRatio = Number(req.body?.maleRatio);
        if (!Number.isFinite(maleRatio)) maleRatio = 50;

        const botPageUrl = `http://localhost:${PORT}/bot.html`;

        // Pre-compute each bot's name: custom mode reuses the one name; random mode
        // spreads names across genders by maleRatio.
        const names =
            nameMode === 'custom'
                ? Array.from({ length: count }, () => customName)
                : generateNames(count, maleRatio);

        // Fire all bots concurrently with the same config; each gets its own id,
        // name, and signature. launchBot resolves (never rejects) per bot.
        const launches = names.map((userName) => {
            const botId = uuidv4().slice(0, BOT_ID_LENGTH);
            const signature = generateSignature(
                ZOOM_SDK_KEY,
                ZOOM_SDK_SECRET,
                meetingNumber,
                ROLE_PARTICIPANT
            );
            return launchBot({
                botId,
                signature,
                sdkKey: ZOOM_SDK_KEY,
                meetingNumber,
                password,
                userName,
                leaveAfterMs,
                botPageUrl,
            });
        });

        const bots = await Promise.all(launches);
        return res.json({ count: bots.length, bots });
    } catch (err) {
        console.error('[Server] /api/bot/launch error:', err.message);
        return res.status(500).json({ error: 'Failed to launch bot' });
    }
});

// ── POST /api/bot/:id/stop ────────────────────────────────────────────────────
app.post('/api/bot/:id/stop', async (req, res) => {
    try {
        const botId = req.params.id;
        if (!hasBot(botId)) {
            return res.status(404).json({ error: 'Bot not found' });
        }
        await stopBot(botId);
        return res.json({ success: true });
    } catch (err) {
        console.error('[Server] /api/bot/:id/stop error:', err.message);
        return res.status(500).json({ error: 'Failed to stop bot' });
    }
});

// ── GET /api/bots ───────────────────────────────────────────────────────────
// Active bots only (joining / waiting-room / in-meeting). Bots that have left
// or errored drop off here and live on in /api/bots/history.
app.get('/api/bots', (_req, res) => {
    return res.json(listActiveBots());
});

// ── GET /api/bots/history ─────────────────────────────────────────────────────
// Every bot ever launched (newest first), including per-bot logs.
app.get('/api/bots/history', (_req, res) => {
    return res.json(listBotHistory());
});

// ── Zoom OAuth (connect the current user) ─────────────────────────────────────
// /oauth/start sends the operator to Zoom's consent screen; Zoom redirects back
// to /oauth/callback with a code we exchange for tokens (stored in zoomApi).
app.get('/oauth/start', (_req, res) => {
    try {
        return res.redirect(getAuthorizeUrl());
    } catch (err) {
        return res.status(500).send(`OAuth not configured: ${err.message}`);
    }
});

app.get('/oauth/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.status(400).send('Missing authorization code');
    try {
        await exchangeCode(String(code));
        return res.redirect('/schedule.html?connected=1');
    } catch (err) {
        console.error('[Server] /oauth/callback error:', err.message);
        return res.status(500).send(`OAuth failed: ${err.message}`);
    }
});

// Connection status for the schedule page ("connected as ...").
app.get('/api/zoom/status', async (_req, res) => {
    if (!isConnected()) return res.json({ connected: false });
    try {
        return res.json({ connected: true, user: await getMe() });
    } catch {
        return res.json({ connected: true, user: null });
    }
});

// Upload constraints, so the UI can validate a file before sending it.
app.get('/api/config', (_req, res) => {
    return res.json({
        maxVideoBytes: MAX_VIDEO_BYTES,
        allowedExtensions: [...ALLOWED_VIDEO_EXT],
    });
});

// ── POST /api/schedule ────────────────────────────────────────────────────────
// multipart: a video file + { topic, startTime, durationMinutes }. Creates a
// Zoom meeting owned by the connected user and arms a job to start it on time.
app.post('/api/schedule', (req, res) => {
    uploadVideo(req, res, async (uploadErr) => {
        if (uploadErr) {
            return res.status(400).json({ error: `Upload failed: ${uploadErr.message}` });
        }
        try {
            if (!isConnected()) {
                cleanupOrphan(req);
                return res.status(401).json({ error: 'Connect your Zoom account first' });
            }
            if (!req.file) {
                return res.status(400).json({ error: 'A video file is required (mp4/webm/mov)' });
            }
            const topic = String(req.body?.topic ?? '').trim() || 'Scheduled presentation';
            const when = new Date(String(req.body?.startTime ?? ''));
            if (Number.isNaN(when.getTime())) {
                cleanupOrphan(req);
                return res.status(400).json({ error: 'Invalid start time' });
            }
            const durationMinutes = Number(req.body?.durationMinutes);
            if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
                cleanupOrphan(req);
                return res.status(400).json({ error: 'durationMinutes must be a positive number' });
            }
            // How the bot behaves once the clip finishes: loop/hold until the
            // duration elapses, or end the meeting immediately.
            const endBehavior = END_BEHAVIORS.has(req.body?.endBehavior) ? req.body.endBehavior : 'loop';

            const meeting = await createMeeting({
                topic,
                startTime: when.toISOString(),
                durationMinutes,
            });

            const job = schedule({
                topic,
                startTime: when.toISOString(),
                durationMinutes,
                endBehavior,
                videoUrl: `/uploads/${req.file.filename}`,
                meetingNumber: meeting.meetingNumber,
                password: meeting.password,
                joinUrl: meeting.joinUrl,
            });

            return res.json(job);
        } catch (err) {
            // e.g. createMeeting threw — the file is now an orphan, so remove it.
            cleanupOrphan(req);
            console.error('[Server] /api/schedule error:', err.message);
            return res.status(500).json({ error: err.message });
        }
    });
});

app.get('/api/schedule', (_req, res) => res.json(listJobs()));

app.post('/api/schedule/:id/cancel', (req, res) => {
    const ok = cancelJob(req.params.id);
    if (!ok) return res.status(400).json({ error: 'Job not found or no longer cancelable' });
    return res.json({ success: true });
});

// End a running presentation now: stop the bot (host leaving ends the meeting)
// and drop the job. Also works on a still-scheduled job (cancels it).
app.post('/api/schedule/:id/end', async (req, res) => {
    const job = getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    try {
        if (job.botId && hasBot(job.botId)) {
            await stopBot(job.botId);
        }
        removeJob(job.id);
        return res.json({ success: true });
    } catch (err) {
        console.error('[Server] /api/schedule/:id/end error:', err.message);
        return res.status(500).json({ error: err.message });
    }
});

// When a scheduled job's time arrives: fetch a fresh ZAK, build a host-role
// signature, and launch the presenter bot to START the meeting and play the
// video. Errors are recorded on the job by the scheduler.
// Lets the scheduler prune a running job once its bot has left/ended.
setBotStatusResolver(getBotStatus);

// Delete a job's uploaded video whenever the job leaves the store (ended,
// canceled, or pruned after the meeting finished).
onRemove((job) => deleteUploadFile(uploadPathFromUrl(job.videoUrl)));

onFire(async (job) => {
    const zak = await getZak();
    const botId = uuidv4().slice(0, BOT_ID_LENGTH);
    const signature = generateSignature(ZOOM_SDK_KEY, ZOOM_SDK_SECRET, job.meetingNumber, ROLE_HOST);
    // 'end' lets the clip's own end event close the meeting; loop/hold keep it
    // open for the full scheduled duration.
    const leaveAfterMs = job.endBehavior === 'end' ? null : job.durationMinutes * 60 * 1000;
    const result = await launchBot({
        botId,
        signature,
        sdkKey: ZOOM_SDK_KEY,
        meetingNumber: job.meetingNumber,
        password: job.password,
        userName: 'Presenter',
        leaveAfterMs,
        botPageUrl: `http://localhost:${PORT}/host-bot.html`,
        zak,
        videoUrl: job.videoUrl,
        endBehavior: job.endBehavior,
        screenShare: true,
    });
    job.botId = botId;
    if (result.status === 'error') {
        job.status = 'error';
        job.error = 'Bot failed to start the meeting';
    } else {
        job.status = 'running';
    }
});

// Schedules don't survive a restart, so any leftover upload is unreferenced.
sweepUploads();

app.listen(PORT, '0.0.0.0', async () => {
    const tunnelUrl = await startTunnel(PORT);
    if (tunnelUrl) {
        console.log(`[Server] Public tunnel: ${tunnelUrl}`);
        console.log(`[Server] OAuth callback: ${tunnelUrl}/oauth/callback`);
    }

    console.log(`[Server] Zoom Bot Platform listening on http://localhost:${PORT}`);
    console.log(`---------------------------------------------------------------`);
    console.log(`------------------------DashBoard------------------------------`);
    console.log(`---------------------------------------------------------------`);
    console.log(`[Local] Dashboard: http://localhost:${PORT}/dashboard.html`);
    console.log(`[Server] Ubuntu VM: http://80.225.245.78:${PORT}/dashboard.html`);
    console.log(`[Domain] CloudFair: https://fnxpopulator.qzz.io/home`);

    // Open the ngrok tunnel in-process so `npm start` is all that's needed for
    // Zoom OAuth to reach /oauth/callback. No-op unless NGROK_DOMAIN is set.

});
