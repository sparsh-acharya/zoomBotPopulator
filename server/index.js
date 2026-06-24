// server/index.js
// Express app: route definitions, request validation, response shaping.
// No business logic here — Playwright lives in botManager.js, JWTs in signature.js.

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';

import { generateSignature, ROLE_PARTICIPANT } from './signature.js';
import { launchBot, stopBot, listActiveBots, listBotHistory, hasBot } from './botManager.js';
import { generateNames } from './names.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const PORT = process.env.PORT || 3000;
const ZOOM_SDK_KEY = process.env.ZOOM_SDK_KEY;
const ZOOM_SDK_SECRET = process.env.ZOOM_SDK_SECRET;

const DIGITS_ONLY = /^\d+$/;
const BOT_ID_LENGTH = 8;
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

app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] Zoom Bot Platform listening on http://localhost:${PORT}`);
    console.log(`[Server] Dashboard: http://localhost:${PORT}/dashboard.html`);
    console.log(`[Server] Ubuntu VM: http://80.225.245.78:${PORT}/dashboard.html`);
});
