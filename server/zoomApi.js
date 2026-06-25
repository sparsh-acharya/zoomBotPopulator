// server/zoomApi.js
// Zoom OAuth (Authorization Code) + REST helpers for the "current user" flow.
//
// Scope of this module: it owns the single connected Zoom user's OAuth tokens
// and the few REST calls we need — fetching a ZAK (to START a meeting as host)
// and creating a scheduled meeting on that user's account. It makes no
// assumptions about HTTP routing (index.js wires the routes) and never touches
// Playwright.
//
// "Current user only": we store exactly one token set in memory. Connecting a
// second time simply replaces it. Tokens are NOT persisted, so a server restart
// requires re-connecting — acceptable for this single-operator tool.
//
// A Zoom "General App" uses the same Client ID/Secret for both OAuth and the
// Meeting SDK signature, which is why these default to ZOOM_SDK_KEY/SECRET.

const AUTHORIZE_URL = 'https://zoom.us/oauth/authorize';
const TOKEN_URL = 'https://zoom.us/oauth/token';
const API_BASE = 'https://api.zoom.us/v2';

// Refresh a little before the real expiry so a call never races the boundary.
const EXPIRY_SKEW_MS = 60_000;
// Zoom scheduled meeting type (2 = scheduled, with a fixed start_time).
const MEETING_TYPE_SCHEDULED = 2;

const CLIENT_ID = process.env.ZOOM_OAUTH_CLIENT_ID || process.env.ZOOM_SDK_KEY;
const CLIENT_SECRET = process.env.ZOOM_OAUTH_CLIENT_SECRET || process.env.ZOOM_SDK_SECRET;
const REDIRECT_URI = process.env.ZOOM_OAUTH_REDIRECT_URI;

// In-memory token store for the one connected user.
// { accessToken, refreshToken, expiresAt(ms epoch) } | null
let tokens = null;

function basicAuthHeader() {
  const raw = `${CLIENT_ID}:${CLIENT_SECRET}`;
  return `Basic ${Buffer.from(raw).toString('base64')}`;
}

/** True once a user has connected their Zoom account this process lifetime. */
export function isConnected() {
  return tokens !== null;
}

/** Forget the connected user (used by a "disconnect" action). */
export function disconnect() {
  tokens = null;
}

/**
 * Build the Zoom consent URL to redirect the operator to. After they approve,
 * Zoom redirects back to REDIRECT_URI with ?code=...
 */
export function getAuthorizeUrl() {
  if (!CLIENT_ID || !REDIRECT_URI) {
    throw new Error('ZOOM OAuth not configured: need client id + ZOOM_OAUTH_REDIRECT_URI');
  }
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

/** Exchange an authorization code for tokens and store them. */
export async function exchangeCode(code) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }
  storeTokenResponse(await res.json());
}

/** Use the refresh token to obtain a fresh access token. */
async function refresh() {
  if (!tokens?.refreshToken) throw new Error('Not connected to Zoom');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    // A failed refresh means the grant is dead — force a reconnect.
    tokens = null;
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }
  storeTokenResponse(await res.json());
}

function storeTokenResponse(data) {
  tokens = {
    accessToken: data.access_token,
    // Zoom rotates the refresh token on each refresh; always take the latest.
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + Number(data.expires_in) * 1000,
  };
}

/** Return a valid access token, refreshing first if it's near expiry. */
async function accessToken() {
  if (!tokens) throw new Error('Not connected to Zoom');
  if (Date.now() >= tokens.expiresAt - EXPIRY_SKEW_MS) {
    await refresh();
  }
  return tokens.accessToken;
}

async function apiGet(pathAndQuery) {
  const token = await accessToken();
  const res = await fetch(`${API_BASE}${pathAndQuery}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET ${pathAndQuery} failed (${res.status}): ${text}`);
  }
  return res.json();
}

async function apiPost(pathAndQuery, payload) {
  const token = await accessToken();
  const res = await fetch(`${API_BASE}${pathAndQuery}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST ${pathAndQuery} failed (${res.status}): ${text}`);
  }
  return res.json();
}

/** Basic profile of the connected user (for the dashboard "connected as" line). */
export async function getMe() {
  const me = await apiGet('/users/me');
  return { id: me.id, email: me.email, displayName: `${me.first_name || ''} ${me.last_name || ''}`.trim() };
}

/**
 * Fetch the connected user's ZAK token. This is what lets the Meeting SDK
 * START (not just join) a meeting as that user. ZAKs are short-lived, so fetch
 * one right before launching the bot.
 */
export async function getZak() {
  const data = await apiGet('/users/me/token?type=zak');
  if (!data.token) throw new Error('ZAK response had no token');
  return data.token;
}

/**
 * Create a scheduled meeting owned by the connected user.
 * @param {object} opts
 * @param {string} opts.topic
 * @param {string} opts.startTime - ISO8601 (e.g. 2026-06-25T18:30:00Z)
 * @param {number} opts.durationMinutes
 * @param {string} [opts.timezone]
 * @returns {Promise<{meetingNumber:string,password:string,joinUrl:string,startTime:string}>}
 */
export async function createMeeting({ topic, startTime, durationMinutes, timezone }) {
  const data = await apiPost('/users/me/meetings', {
    topic: topic || 'Scheduled presentation',
    type: MEETING_TYPE_SCHEDULED,
    start_time: startTime,
    duration: durationMinutes,
    timezone: timezone || 'UTC',
    settings: {
      host_video: true,
      participants_video: false,
      join_before_host: false,
      waiting_room: false,
      mute_upon_entry: true,
    },
  });
  return {
    meetingNumber: String(data.id),
    password: data.password || '',
    joinUrl: data.join_url || '',
    startTime: data.start_time || startTime,
  };
}
