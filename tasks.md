# Tasks — Zoom Bot Platform (ZBP)
**Version:** 0.1.0  
**Last Updated:** 2026-06-22

---

## Status Legend
- `[ ]` Not started  
- `[~]` In progress  
- `[x]` Done  
- `[!]` Blocked  

---

## Phase 0 — Project Setup

- [x] `T-001` Init Node.js project (`package.json`, ESM)
- [x] `T-002` Install dependencies: `express cors dotenv jsonwebtoken playwright uuid`
- [x] `T-003` Run `npx playwright install chromium`
- [~] `T-004` Create `.env` with `ZOOM_SDK_KEY`, `ZOOM_SDK_SECRET`, `PORT=3000` — `.env.example` provided; copy to `.env` and fill in real creds
- [x] `T-005` Create directory structure: `server/`, `public/`
- [x] `T-006` Add `.gitignore` — exclude `.env`, `node_modules/`
- [~] `T-007` Verify credentials work — endpoint verified with dummy creds (returns valid JWT); needs real creds for live test

---

## Phase 1 — Backend Core

- [x] `T-010` Implement `server/signature.js`
  - `generateSignature(meetingNumber, role)` using HS256
  - Validate: meetingNumber must be digits only
  - Token expiry: 2 hours from now

- [x] `T-011` Implement `server/index.js` — Express app
  - Serve static files from `/public`
  - `POST /api/signature` → return `{ signature, sdkKey }`
  - `POST /api/bot/launch` → validate input, call botManager, return `{ botId, status }`
  - `POST /api/bot/:id/stop` → call botManager.stopBot()
  - `GET /api/bots` → return botManager.listBots()

- [x] `T-012` Implement `server/botManager.js` — launchBot()
  - Launch Chromium with correct flags (fake-media, no-sandbox)
  - Grant mic/camera permissions via context
  - `page.goto('/bot.html')`
  - Inject `window.__BOT_CONFIG__` via `page.evaluate()`
  - `page.reload()` to trigger SDK boot
  - `waitForFunction` for `in-meeting` or `error` status (30s timeout)
  - Add BotRecord to Map

- [x] `T-013` Implement `server/botManager.js` — watchBotStatus()
  - Poll `window.__BOT_STATUS__` every 2s
  - On terminal status: close browser, log exit reason

- [x] `T-014` Implement `server/botManager.js` — stopBot()
  - Validate botId exists
  - Set `window.__BOT_STATUS__ = 'left-manual'`
  - `browser.close()`

- [x] `T-015` Implement `server/botManager.js` — listBots()
  - Return serializable array (exclude browser/page refs)
  - Include: botId, status, meetingNumber, startedAt, leaveAfterMs

---

## Phase 2 — Bot Page

- [x] `T-020` Create `public/bot.html` skeleton
  - Hidden `#meetingSDKElement` div (off-screen CSS)
  - ESM script tag importing `@zoom/meetingsdk/embedded` via esm.sh

- [x] `T-021` Implement SDK init + join flow
  - Read `window.__BOT_CONFIG__`
  - `client.init({ zoomAppRoot, language, patchJsMedia, leaveOnPageUnload })`
  - `client.join({ signature, sdkKey, meetingNumber, password, userName })`
  - Set `window.__BOT_STATUS__ = 'joining'` before init

- [x] `T-022` Implement post-join media mute
  - `const stream = client.getMediaStream()`
  - `await stream.muteAudio()`
  - `await stream.stopVideo()`
  - Set `window.__BOT_STATUS__ = 'in-meeting'`

- [x] `T-023` Implement Leave Mode A (Timer)
  - If `config.leaveAfterMs !== null`: `setTimeout(() => client.leave(), config.leaveAfterMs)`
  - After leave: set status to `'left-timer'`

- [x] `T-024` Implement Leave Mode B (Meeting End)
  - `client.on('connection-change', handler)`
  - If `payload.state === 'Closed'`: set status to `'left-meeting-ended'`
  - Also handle `user-removed` event → status `'left-removed'`

- [x] `T-025` Implement safety cap timer
  - Always: `setTimeout(() => client.leave(), 3 * 60 * 60 * 1000)`
  - Regardless of leave mode

- [x] `T-026` Implement waiting room detection
  - `client.on('onUserWaitingRoomStatusChanged', handler)`
  - Set `window.__BOT_STATUS__ = 'waiting-room'`

- [x] `T-027` Implement error handling
  - Wrap entire flow in try/catch
  - Set `window.__BOT_STATUS__ = 'error'` on any failure
  - `console.error('[Bot] Error:', err)` for Playwright log capture

---

## Phase 3 — Dashboard UI

- [x] `T-030` Create `public/dashboard.html` layout
  - Launch form: meetingNumber, password, leaveMode select, duration input
  - Bot list section with auto-refresh

- [x] `T-031` Implement `launchBot()` function
  - Validate meetingNumber (strip spaces, check digits)
  - `POST /api/bot/launch` with form data
  - Show alert on error, call `refreshBots()` on success

- [x] `T-032` Implement `refreshBots()` function
  - `GET /api/bots` every 3 seconds via `setInterval`
  - Render bot cards: botId, meeting, status badge, start time, stop button

- [x] `T-033` Implement `stopBot(botId)` function
  - `POST /api/bot/:id/stop`
  - Call `refreshBots()` after response

- [x] `T-034` Implement duration field toggle
  - Show duration input only when leaveMode === 'timer'
  - Default: 30 minutes

- [x] `T-035` Style status badges by state
  - `joining` → yellow
  - `in-meeting` → green
  - `waiting-room` → orange
  - `left-*` → grey
  - `error` → red

---

## Phase 4 — Integration Testing

- [x] `T-040` Start a test Zoom meeting on your own account
- [x] `T-041` Launch server: `node server/index.js`
- [~] `T-042` Open dashboard, launch bot with timer mode (60 seconds)
  - Mechanism shares the same leave path as meeting-end (verified); not yet run live with a stopwatch
- [x] `T-043` Launch bot with meeting-end mode
  - Verified live: bot joined, host ended meeting, status → `left-meeting-ended`, browser auto-closed
- [x] `T-044` Test manual stop
  - Verified live: Stop → status `left-manual`, browser closed
- [x] `T-045` Test error case
  - Verified: invalid/unreachable join → status `error`
- [x] `T-046` Check browser console logs via Playwright
  - Verified: bot console piped to server log; clean join/admit/leave sequence

### Live-test findings (Component View API corrections applied)

- SDK version is **6.1.0** (6.2.0 in PRD does not exist) — fixed esm.sh import
- Switched to guarded dynamic `import()` so a CDN failure reports `error` not a silent timeout
- `client.leave()` → **`client.leaveMeeting()`** (Component View name)
- `getMediaStream().muteAudio()/stopVideo()` do not exist → **`client.mute(true)`**; video is off by default (a headless bot never connects audio, so it is silent regardless)
- No `onUserWaitingRoomStatusChanged` event in Component View → detect via **`getCurrentUser().isHold`** + **`user-updated`** event; bot auto-proceeds once admitted
- Added meeting-URL parsing (`/api/bot/launch` accepts `meetingUrl`; dashboard URL-first)

---

## Phase 5 — Hardening (Post-MVP)

- [ ] `T-050` Add input sanitization on meetingNumber (strip all non-digits)
- [ ] `T-051` Add max concurrent bot limit (env var `MAX_BOTS`, default 5)
- [ ] `T-052` Add waiting room 90-second timeout + auto-abort
- [ ] `T-053` Add `GET /api/bot/:id` single bot status endpoint
- [ ] `T-054` Replace `setInterval` dashboard polling with WebSocket push
- [x] `T-055` Add Docker support (Dockerfile + docker-compose.yml)
  - Dockerfile on `mcr.microsoft.com/playwright:v1.61.0-jammy` (browsers + libs version-matched), runs as `pwuser`
  - compose: `.env` via env_file, host `PORT` mapping, `init: true`, `shm_size: 1gb`, `restart: unless-stopped`
  - `.dockerignore` excludes node_modules/.env/.git; `docker compose config` validated
- [ ] `T-056` Write README with setup, env vars, and usage instructions
