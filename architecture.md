# Architecture — Zoom Bot Platform (ZBP)
**Version:** 0.1.0  
**Status:** MVP  
**Last Updated:** 2026-06-22

---

## 1. System Overview

```
┌─────────────────────────────────────────────────────────┐
│                  Dashboard (dashboard.html)              │
│   Static HTML/JS served by Express                      │
│   Polls /api/bots every 3s · POST to launch/stop        │
└───────────────────────┬─────────────────────────────────┘
                        │ HTTP REST
┌───────────────────────▼─────────────────────────────────┐
│              Express Server (server/index.js)            │
│                                                         │
│  POST /api/bot/launch  → botManager.launchBot()         │
│  POST /api/bot/:id/stop → botManager.stopBot()          │
│  GET  /api/bots         → botManager.listBots()         │
│  POST /api/signature    → signature.generateSignature() │
│  GET  /bot.html         → serves bot page (static)      │
│                                                         │
│  In-memory store: Map<botId, BotRecord>                 │
└───────────────────────┬─────────────────────────────────┘
                        │ spawns
┌───────────────────────▼─────────────────────────────────┐
│            botManager.js (Playwright controller)         │
│                                                         │
│  chromium.launch({ headless: true, args: [fake-media] })│
│  page.goto('/bot.html')                                 │
│  page.evaluate() → injects BOT_CONFIG                   │
│  page.reload()   → SDK boots with config                │
│  polls __BOT_STATUS__ every 2s                          │
│  closes browser on terminal status                      │
└───────────────────────┬─────────────────────────────────┘
                        │ controls
┌───────────────────────▼─────────────────────────────────┐
│           Headless Chromium (per bot instance)           │
│                                                         │
│  Loads: public/bot.html                                 │
│  Runs:  @zoom/meetingsdk/embedded (Component View)      │
│  Flow:  init → join → muteAudio → stopVideo             │
│         → listen connection-change / setTimeout         │
│         → client.leave() on trigger                     │
│  Exposes: window.__BOT_STATUS__ (read by Playwright)    │
└───────────────────────┬─────────────────────────────────┘
                        │ WebRTC / WSS
                 ┌──────▼──────┐
                 │  Zoom Cloud  │
                 └─────────────┘
```

---

## 2. Directory Structure

```
zoom-bot-platform/
├── server/
│   ├── index.js          # Express app, route definitions
│   ├── signature.js      # JWT generator (HS256, server-only)
│   └── botManager.js     # Playwright lifecycle manager
├── public/
│   ├── bot.html          # Bot page loaded by Playwright
│   └── dashboard.html    # Operator UI
├── .env                  # ZOOM_SDK_KEY, ZOOM_SDK_SECRET, PORT
├── package.json
└── docs/
    ├── prd.md
    ├── architecture.md
    ├── tasks.md
    └── agents.md
```

---

## 3. Component Breakdown

### 3.1 Express Server (`server/index.js`)
- Serves static files from `/public`
- Exposes REST API for dashboard and bot management
- Holds in-memory `Map<botId, BotRecord>` as state store
- Does NOT store any secrets in responses — signature generated internally

**BotRecord shape:**
```js
{
  browser: Browser,       // Playwright browser instance
  page: Page,             // Playwright page instance
  status: string,         // current bot status string
  meetingNumber: string,
  startedAt: string,      // ISO timestamp
  leaveAfterMs: number | null,
}
```

### 3.2 Signature Generator (`server/signature.js`)
- Generates Meeting SDK JWT using `jsonwebtoken` (HS256)
- Payload: `{ appKey, mn, role, iat, exp, tokenExp }`
- `role: 0` = participant (never host for MVP)
- Token valid for 2 hours
- **Secret never leaves the server**

### 3.3 Bot Manager (`server/botManager.js`)
- `launchBot(config)` — spawns Chromium, injects config, waits for `in-meeting` status
- `stopBot(botId)` — closes browser, sets status to `left-manual`
- `listBots()` — returns serializable array of all BotRecords (no browser/page refs)
- `watchBotStatus(botId, page, browser)` — polls `window.__BOT_STATUS__` every 2s, closes browser on terminal state

**Chromium launch flags (required):**
```
--no-sandbox
--disable-setuid-sandbox
--disable-dev-shm-usage
--use-fake-ui-for-media-stream      ← grants mic/camera permission silently
--use-fake-device-for-media-stream  ← provides virtual device so SDK doesn't error
```

### 3.4 Bot Page (`public/bot.html`)
- Minimal HTML page, Zoom SDK UI hidden off-screen (`top: -9999px`)
- Imports `@zoom/meetingsdk/embedded` via ESM (esm.sh CDN or local bundle)
- Reads `window.__BOT_CONFIG__` injected by Playwright before page load
- Exposes `window.__BOT_STATUS__` for Playwright to poll
- Handles both leave modes internally (setTimeout vs connection-change event)
- Safety cap: `setTimeout(leave, 3 * 60 * 60 * 1000)` always active

**Bot page config shape (injected by Playwright):**
```js
window.__BOT_CONFIG__ = {
  signature:     string,   // JWT from server
  sdkKey:        string,   // Client ID
  meetingNumber: string,   // digits only
  password:      string,   // or ''
  userName:      string,   // 'Bot-{botId}'
  leaveAfterMs:  number | null,  // null = meeting-end mode
}
```

### 3.5 Dashboard (`public/dashboard.html`)
- Pure HTML/JS, no framework
- Polls `GET /api/bots` every 3 seconds
- Launch form → `POST /api/bot/launch`
- Stop button → `POST /api/bot/:id/stop`
- Status badge color-coded by state

---

## 4. Data Flow: Bot Launch

```
1. User fills form → POST /api/bot/launch
   { meetingNumber, password, leaveMode, leaveAfterMs }

2. Server generates botId (uuid v4 short)
3. Server calls generateSignature(meetingNumber, role=0)
4. Server calls botManager.launchBot({ botId, signature, ... })

5. Playwright: chromium.launch(headless + fake-media flags)
6. Playwright: page.goto('http://localhost:PORT/bot.html')
7. Playwright: page.evaluate() injects window.__BOT_CONFIG__
8. Playwright: page.reload() → ESM script reads config and runs

9. SDK: client.init({ zoomAppRoot }) → client.join({ signature, ... })
10. SDK: on success → stream.muteAudio() + stream.stopVideo()
11. Bot: window.__BOT_STATUS__ = 'in-meeting'

12. Playwright: waitForFunction(__BOT_STATUS__ === 'in-meeting')
13. Server: adds BotRecord to Map, returns { botId, status } to client

14. [Timer mode]  → setTimeout fires → client.leave() → status = 'left-timer'
    [End mode]    → connection-change 'Closed' → status = 'left-meeting-ended'
    [Manual stop] → POST /api/bot/:id/stop → browser.close() → status = 'left-manual'

15. watchBotStatus detects terminal status → browser.close()
```

---

## 5. Data Flow: Dashboard Refresh

```
Every 3 seconds:
  GET /api/bots
  → listBots() returns array of serializable BotRecords
  → Dashboard re-renders bot cards with current status
```

---

## 6. Key Technical Decisions

| Decision | Choice | Reason |
|---|---|---|
| SDK view | Component View (ZoomMtgEmbedded) | No full-page takeover; easier to hide UI |
| Headless browser | Playwright + Chromium | Reliable, good API for status polling, works headless on Linux |
| State store | In-memory Map | MVP simplicity; swap for Redis in v0.5+ |
| Auth | None (single operator) | MVP scope |
| Secret handling | Server-side only | Client Secret in .env, never in API responses |
| Bot username | `Bot-{botId}` | Identifiable in Zoom participant list |
| SDK import | ESM via esm.sh CDN | Avoids bundler setup for MVP bot.html |

---

## 7. Known Constraints & Risks

| Risk | Mitigation |
|---|---|
| Waiting room silently blocks bot | Listen to `onUserWaitingRoomStatusChanged`; set 90s timeout |
| `connection-change` unreliable on headless Ubuntu | Always run safety cap timer (3h max) |
| Dev credentials only work on own account | Use OAuth flow in v0.3 for external meetings |
| Zoom ToS: SDK "for human use only" | Accepted risk for dev/internal tooling at MVP stage |
| Memory leak if browsers not closed | `watchBotStatus` always closes browser on terminal state |
| Concurrent bot limit | Playwright + Chromium ~200-500MB RAM per instance; cap at ~5 bots locally |

---

## 8. Environment Variables

```env
ZOOM_SDK_KEY=your_client_id      # From Zoom Marketplace app credentials
ZOOM_SDK_SECRET=your_client_secret
PORT=3000
```

---

## 9. Dependencies

```json
{
  "express": "^4.x",
  "cors": "^2.x",
  "dotenv": "^16.x",
  "jsonwebtoken": "^9.x",
  "playwright": "^1.x",
  "uuid": "^9.x"
}
```

`@zoom/meetingsdk` is loaded via CDN in `bot.html` (not bundled server-side).
