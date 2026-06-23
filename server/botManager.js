// server/botManager.js
// Owns the entire Playwright lifecycle for bots. Does not generate signatures
// and does not handle HTTP — it receives a fully-formed config and drives a
// headless Chromium instance per bot.

import { chromium } from 'playwright';

// ── Constants (no magic numbers) ──────────────────────────────────────────────
const HEADLESS = true;
const JOIN_TIMEOUT_MS = 30_000;
const STATUS_POLL_INTERVAL_MS = 2_000;
const MAX_LOG_ENTRIES = 500; // cap per-bot log so memory stays bounded

const CHROMIUM_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--use-fake-ui-for-media-stream', // grants mic/camera permission silently
  '--use-fake-device-for-media-stream', // virtual device so the SDK doesn't error
];

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
 * @param {string} config.botPageUrl - absolute http(s) URL to bot.html
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
    browser = await chromium.launch({ headless: HEADLESS, args: CHROMIUM_ARGS });
    record.browser = browser;

    const context = await browser.newContext({ permissions: MEDIA_PERMISSIONS });
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
      { signature, sdkKey, meetingNumber, password, userName, leaveAfterMs }
    );

    await page.goto(botPageUrl, { waitUntil: 'domcontentloaded' });

    // Wait for the bot to either join, be held, or fail.
    await page.waitForFunction(
      () =>
        window.__BOT_STATUS__ === 'in-meeting' ||
        window.__BOT_STATUS__ === 'error' ||
        window.__BOT_STATUS__ === 'waiting-room',
      undefined,
      { timeout: JOIN_TIMEOUT_MS }
    );

    setStatus(record, await readStatus(page));

    // Begin background lifecycle watching (do not await — runs until terminal).
    watchBotStatus(botId, page, browser);

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
