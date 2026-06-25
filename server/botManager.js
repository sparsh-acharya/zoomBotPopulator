// server/botManager.js
// Owns the entire Playwright lifecycle for bots. Does not generate signatures
// and does not handle HTTP — it receives a fully-formed config and drives a
// headless Chromium instance per bot.

import { chromium } from 'playwright';

// ── Constants (no magic numbers) ──────────────────────────────────────────────
const HEADLESS = true;
// How long /launch blocks waiting for a bot to leave 'joining' before it returns
// to the HTTP caller. Hitting this is NOT a failure — the join may simply be slow
// (cloud VM → Zoom media servers can take 60s+); the background watcher keeps
// going and flips the bot to 'in-meeting' when it lands.
const JOIN_WAIT_MS = 90_000;
// Hard cap: if a bot is STILL 'joining' after this long, treat it as dead and
// close its browser. Generous because real joins have been observed at 60-70s.
const JOIN_HARD_CAP_MS = 180_000;
const STATUS_POLL_INTERVAL_MS = 2_000;
const MAX_LOG_ENTRIES = 500; // cap per-bot log so memory stays bounded

const CORE_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
];
// --use-fake-ui-for-media-stream auto-answers media prompts, but for
// getDisplayMedia it silently auto-picks the ENTIRE SCREEN (no picker, no
// audio) and overrides our tab-by-title selection — so presenter bots must NOT
// use it (it's why every share logged handleDesktopCapture). Attendee bots
// still need it. Media *permissions* are granted at the Playwright context
// level (newContext({ permissions })), so dropping the flag doesn't reintroduce
// a permission prompt; it just lets getDisplayMedia resolve via the tab flags.
const BASE_ARGS = [...CORE_ARGS, '--use-fake-ui-for-media-stream'];
// A fake camera/mic device so the SDK doesn't error when probing devices.
// NOTE: this flag ALSO replaces getDisplayMedia output with a green test
// pattern, so presenter bots must NOT use it (they screen-capture for real).
const FAKE_DEVICE_ARG = '--use-fake-device-for-media-stream';
const CHROMIUM_ARGS = [...BASE_ARGS, FAKE_DEVICE_ARG];

// Extra flags for a screen-sharing (presenter) bot. The Meeting SDK has no
// public API to start a share, so the bot clicks the SDK's "Share" button,
// which calls getDisplayMedia(). We MUST capture a Chromium TAB, not a window
// or the whole screen: the Meeting SDK only transmits shared audio when the
// captured surface is a browser tab ("share tab audio") — window/entire-screen
// shares carry no audio at all. Since the bot's own tab is fullscreen on the
// clip (--kiosk), capturing this tab gives both the video AND its sound.
//   --auto-select-tab-capture-source-by-title picks our tab in the picker
//   --auto-accept-this-tab-capture auto-grants the current-tab capture
// We deliberately DO NOT pass --auto-select-desktop-capture-source: that flag
// forces an (audio-less) screen capture and short-circuits tab selection, which
// is exactly why audio was missing. Same result on Windows and Xvfb on the VM.
const SCREEN_SHARE_TITLE = 'ZBP Presenter Bot'; // must match host-bot.html <title>
const SCREEN_SHARE_ARGS = [
  '--autoplay-policy=no-user-gesture-required',
  '--kiosk',
  '--start-fullscreen',
  '--window-position=0,0',
  `--auto-select-tab-capture-source-by-title=${SCREEN_SHARE_TITLE}`,
  '--auto-accept-this-tab-capture',
  '--enable-usermedia-screen-capturing',
];

// A presenter bot must actually render to a display for getDisplayMedia to have
// pixels to capture. Old headless Chromium can't screen-capture, so presenter
// bots run headed (on a server, wrap the process in `xvfb-run`). Toggle with
// HOST_BOT_HEADLESS=true only if your Chromium build supports headless capture.
const PRESENTER_HEADLESS = process.env.HOST_BOT_HEADLESS === 'true';

const MEDIA_PERMISSIONS = ['microphone', 'camera'];

// Status strings — must match the enum in agents.md §5 / prd.md §6.5 exactly.
const TERMINAL_STATUSES = new Set([
  'left-timer',
  'left-meeting-ended',
  'left-manual',
  'left-removed',
  'error',
]);

// A bot is "active" while it is still working toward / attending the meeting.
const ACTIVE_STATUSES = new Set(['joining', 'waiting-room', 'in-meeting']);

// In-memory store: Map<botId, BotRecord>. Lives here because BotRecords hold
// live Playwright refs (browser/page) that index.js must never touch.
// Records are kept after the bot ends so they remain available as history.
const bots = new Map();

/**
 * Launch a bot: spawn Chromium, inject config, load the bot page, wait for join.
 *
 * @param {object} config
 * @param {string} config.botId
 * @param {string} config.signature
 * @param {string} config.sdkKey
 * @param {string} config.meetingNumber
 * @param {string} config.password
 * @param {string} config.userName
 * @param {number|null} config.leaveAfterMs - null = meeting-end mode
 * @param {string} config.botPageUrl - absolute http(s) URL to the bot page
 * @param {string} [config.zak] - host ZAK token; required to START a meeting
 * @param {string} [config.videoUrl] - server URL of the video to screen-share
 * @param {boolean} [config.screenShare] - presenter bot: play video as a share
 * @returns {Promise<{ botId: string, status: string }>}
 */
export async function launchBot(config) {
  const {
    botId,
    signature,
    sdkKey,
    meetingNumber,
    password,
    userName,
    leaveAfterMs,
    botPageUrl,
    zak = '',
    videoUrl = '',
    screenShare = false,
    endBehavior = 'loop',
  } = config;

  // Create the history record up front so even early failures are recorded.
  const record = {
    botId,
    browser: null,
    page: null,
    status: 'joining',
    userName,
    meetingNumber,
    leaveMode: leaveAfterMs == null ? 'meeting-end' : 'timer',
    startedAt: new Date().toISOString(),
    endedAt: null,
    leaveAfterMs,
    logs: [],
  };
  bots.set(botId, record);
  addLog(record, `Launching bot "${userName}" for meeting ${meetingNumber} (${record.leaveMode})`);

  let browser;
  try {
    const headless = screenShare ? PRESENTER_HEADLESS : HEADLESS;
    // Presenter bots omit the fake device (it would feed a green test pattern
    // into the share) AND --use-fake-ui-for-media-stream (it auto-picks the
    // entire screen for getDisplayMedia, killing tab selection + audio). They
    // use CORE_ARGS + the screen-capture flags so getDisplayMedia resolves to
    // the bot's tab via --auto-select-tab-capture-source-by-title.
    const args = screenShare ? [...CORE_ARGS, ...SCREEN_SHARE_ARGS] : CHROMIUM_ARGS;
    browser = await chromium.launch({ headless, args });
    record.browser = browser;

    const context = await browser.newContext({
      permissions: MEDIA_PERMISSIONS,
      // viewport:null lets the page fill the (kiosk-fullscreen) window so the
      // video covers the whole display — key to a clean "entire screen" capture.
      ...(screenShare ? { viewport: null } : {}),
    });
    const page = await context.newPage();
    record.page = page;

    // Capture the bot page's console output into this bot's log.
    page.on('console', (msg) => {
      addLog(record, `[page] ${msg.text()}`);
    });
    page.on('pageerror', (err) => {
      addLog(record, `[page error] ${err.message}`);
    });

    // Inject config as window.__BOT_CONFIG__ before any page script runs.
    // addInitScript guarantees the global is present on initial load (and any
    // reload), unlike evaluate() whose globals are wiped by navigation.
    await page.addInitScript(
      (cfg) => {
        window.__BOT_CONFIG__ = cfg;
      },
      { signature, sdkKey, meetingNumber, password, userName, leaveAfterMs, zak, videoUrl, screenShare, endBehavior }
    );

    await page.goto(botPageUrl, { waitUntil: 'domcontentloaded' });

    // Start watching from the very start. The watcher owns the browser lifecycle
    // from here on — including reaping a bot that never gets past 'joining' (see
    // JOIN_HARD_CAP_MS). This is what makes a slow-but-successful join survive:
    // we never close the browser just because the initial wait below elapsed.
    watchBotStatus(botId, page, browser);

    // Wait (NON-FATALLY) for the bot to leave 'joining'. A timeout here does not
    // mean failure: joins from a cloud VM to Zoom's media servers have been seen
    // to take 60s+, and racing a fixed timeout used to kill bots that were about
    // to join. If we time out, we just return 'joining' and let the watcher
    // report 'in-meeting' once it lands.
    try {
      await page.waitForFunction(
        () => window.__BOT_STATUS__ !== 'joining',
        undefined,
        { timeout: JOIN_WAIT_MS }
      );
      setStatus(record, await readStatus(page));
    } catch (waitErr) {
      addLog(
        record,
        `Still joining after ${JOIN_WAIT_MS}ms — continuing in background (not an error)`
      );
    }

    return { botId, status: record.status };
  } catch (err) {
    addLog(record, `launchBot failed: ${err.message}`);
    setStatus(record, 'error');
    if (browser) {
      await closeBrowserSafely(record, browser);
    }
    return { botId, status: 'error' };
  }
}

/**
 * Poll window.__BOT_STATUS__ until the bot reaches a terminal state, then
 * close the browser. Always closes the browser — leaked browsers are a hard
 * failure (each is ~200-500MB RAM).
 */
export function watchBotStatus(botId, page, browser) {
  const interval = setInterval(async () => {
    const record = bots.get(botId);
    if (!record) {
      clearInterval(interval);
      return;
    }

    let status;
    try {
      status = await readStatus(page);
    } catch (err) {
      // Page/browser gone — treat as terminal.
      addLog(record, `Status read failed: ${err.message}`);
      clearInterval(interval);
      if (!isTerminal(record.status)) setStatus(record, 'error');
      await closeBrowserSafely(record, browser);
      return;
    }

    if (status && status !== record.status) {
      setStatus(record, status);
    }

    // Reap a bot that never gets past 'joining'. 'waiting-room' is intentionally
    // exempt (admission is legitimately open-ended; the page's own safety cap
    // covers it). Only a stuck join is treated as dead here.
    if (
      record.status === 'joining' &&
      Date.now() - new Date(record.startedAt).getTime() > JOIN_HARD_CAP_MS
    ) {
      clearInterval(interval);
      addLog(record, `Join hard cap (${JOIN_HARD_CAP_MS}ms) exceeded; giving up`);
      setStatus(record, 'error');
      await closeBrowserSafely(record, browser);
      return;
    }

    if (isTerminal(record.status)) {
      clearInterval(interval);
      addLog(record, `Terminal status (${record.status}); closing browser`);
      await closeBrowserSafely(record, browser);
    }
  }, STATUS_POLL_INTERVAL_MS);
}

/**
 * Stop a bot manually: mark left-manual on the page, then close the browser.
 * @returns {Promise<{ success: true }>}
 */
export async function stopBot(botId) {
  const record = bots.get(botId);
  if (!record) {
    throw new Error(`Bot not found: ${botId}`);
  }

  addLog(record, 'Manual stop requested');
  try {
    // Ask the page to leave gracefully if it can, then mark manual.
    if (record.page) {
      await record.page.evaluate(() => {
        if (typeof window.__BOT_LEAVE__ === 'function') {
          window.__BOT_LEAVE__('left-manual');
        } else {
          window.__BOT_STATUS__ = 'left-manual';
        }
      });
    }
  } catch (err) {
    // Page may already be gone; that's fine — we still close below.
    addLog(record, `stopBot evaluate failed: ${err.message}`);
  }

  setStatus(record, 'left-manual');
  if (record.browser) await closeBrowserSafely(record, record.browser);
  return { success: true };
}

/**
 * Active bots only (still joining / waiting / attending). Serializable, no logs.
 * @returns {Array<object>}
 */
export function listActiveBots() {
  return Array.from(bots.values())
    .filter((r) => ACTIVE_STATUSES.has(r.status))
    .map(toSummary);
}

/**
 * Full bot history (every bot ever launched), newest first, with logs.
 * @returns {Array<object>}
 */
export function listBotHistory() {
  return Array.from(bots.values())
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
    .map((r) => ({ ...toSummary(r), logs: r.logs }));
}

/** True if a bot with this id exists. */
export function hasBot(botId) {
  return bots.has(botId);
}

/** Current status of a bot, or null if unknown. Used to prune finished jobs. */
export function getBotStatus(botId) {
  return bots.get(botId)?.status ?? null;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function toSummary(r) {
  return {
    botId: r.botId,
    status: r.status,
    userName: r.userName,
    meetingNumber: r.meetingNumber,
    leaveMode: r.leaveMode,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    leaveAfterMs: r.leaveAfterMs,
  };
}

function readStatus(page) {
  return page.evaluate(() => window.__BOT_STATUS__);
}

function isTerminal(status) {
  return TERMINAL_STATUSES.has(status);
}

function addLog(record, message) {
  const entry = { time: new Date().toISOString(), message };
  record.logs.push(entry);
  if (record.logs.length > MAX_LOG_ENTRIES) record.logs.shift();
  console.log(`[Bot ${record.botId}] ${message}`);
}

function setStatus(record, status) {
  if (!status || status === record.status) return;
  record.status = status;
  if (isTerminal(status) && !record.endedAt) record.endedAt = new Date().toISOString();
  addLog(record, `status → ${status}`);
}

async function closeBrowserSafely(record, browser) {
  try {
    await browser.close();
  } catch (err) {
    addLog(record, `Error closing browser: ${err.message}`);
  }
}
