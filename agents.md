# Agents — Zoom Bot Platform (ZBP)
**Version:** 0.1.0  
**Last Updated:** 2026-06-22

This file defines the standards, constraints, and workflow for any AI coding agent working on this codebase. Read this in full before writing a single line of code.

---

## 1. Project Identity

- **Name:** Zoom Bot Platform (ZBP)
- **Stack:** Node.js + Express (backend), Playwright (bot runner), Vanilla HTML/JS (frontend)
- **Runtime:** Node.js 20+
- **Package manager:** npm
- **Entry point:** `server/index.js`
- **Port:** `process.env.PORT` (default 3000)

---

## 2. Architecture Laws (Never Violate)

1. **The Client Secret never leaves the server.** `ZOOM_SDK_SECRET` is used only in `server/signature.js`. It must not appear in any API response, log output, or client-side file.

2. **One browser instance per bot.** `botManager.launchBot()` always creates a fresh `chromium.launch()`. Never reuse a browser across bots.

3. **Bot state is read through `window.__BOT_STATUS__`.** Playwright polls this value. Do not invent alternative state channels (no IPC, no files, no websockets from bot to server in MVP).

4. **Bot page config is injected then reloaded.** The sequence is always: `page.goto` → `page.evaluate(inject config)` → `page.reload()`. Never pass config via URL params or query strings.

5. **`listBots()` must return serializable data only.** Never include `browser` or `page` refs in API responses. BotRecord internal fields vs API-safe fields are separate concerns.

6. **The safety cap timer always runs.** Every bot always has a `setTimeout(leave, 3h)` regardless of leave mode. This is non-negotiable.

---

## 3. File Responsibilities

| File | Owns | Must Not |
|---|---|---|
| `server/index.js` | Route definitions, request validation, response shaping | Contain business logic, touch Playwright directly |
| `server/signature.js` | JWT generation only | Make network calls, read .env directly (receive values as args) |
| `server/botManager.js` | All Playwright lifecycle | Generate signatures, handle HTTP |
| `public/bot.html` | SDK init, join, mute, leave events, status reporting | Make API calls back to server, read .env |
| `public/dashboard.html` | UI rendering, polling, form handling | Contain server logic, generate signatures |

---

## 4. Coding Standards

### General
- Use `async/await` throughout. No raw `.then()/.catch()` chains.
- All async functions must have try/catch. Unhandled promise rejections will silently kill bot processes.
- Use `const` by default. `let` only when reassignment is necessary. Never `var`.
- No magic numbers. Extract to named constants at top of file.
- All `console.log` in bot context must be prefixed: `[Bot ${botId}]`
- All `console.log` in server context must be prefixed: `[Server]` or `[BotManager]`

### Express Routes
- Validate all required fields before calling any business logic
- Return consistent error shape: `{ error: string }`
- Return consistent success shape: `{ botId, status }` or `{ success: true }`
- No 200 responses with error payloads

### Playwright
- Always pass `--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage` in headless mode
- Always pass `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream` — SDK will fail without these
- Always grant `['microphone', 'camera']` permissions on the browser context
- `waitForFunction` must always have an explicit timeout (30_000ms for join)
- Always close browser in `watchBotStatus` when status is terminal. Memory leaks are a hard failure.

### Bot Page (bot.html)
- `window.__BOT_CONFIG__` must be checked before SDK init. If undefined, set status to `error` and return.
- SDK must be imported as ESM module
- All SDK calls after join must be wrapped in try/catch — `getMediaStream()` can throw if SDK is not fully ready
- Status string values must exactly match the enum in `prd.md` Section 6.5. No variations.

---

## 5. Status String Enum

These are the only valid values for `window.__BOT_STATUS__`. Use exact strings, no variations.

```js
'joining'            // initial state, before SDK init
'waiting-room'       // SDK joined but held in waiting room
'in-meeting'         // joined and attending
'left-timer'         // exited via timer
'left-meeting-ended' // exited via connection-change Closed
'left-manual'        // exited via dashboard stop
'left-removed'       // kicked by host (user-removed event)
'error'              // any unhandled failure
```

Terminal states (browser should be closed after these):
```js
['left-timer', 'left-meeting-ended', 'left-manual', 'left-removed', 'error']
```

---

## 6. Environment Variables

```env
ZOOM_SDK_KEY=        # Required. Client ID from Zoom Marketplace
ZOOM_SDK_SECRET=     # Required. Client Secret. Never expose.
PORT=3000            # Optional. Default 3000.
```

Agent must check for `ZOOM_SDK_KEY` and `ZOOM_SDK_SECRET` on server startup. If missing, log a clear error and exit with code 1.

---

## 7. Forbidden Actions

- ❌ Do not log `ZOOM_SDK_SECRET` anywhere, even partially
- ❌ Do not add `console.log(config)` in bot.html if config contains the signature (truncate or omit)
- ❌ Do not use `eval()` anywhere
- ❌ Do not use `innerHTML` with user-supplied data (XSS risk in dashboard)
- ❌ Do not add a database in MVP phase — in-memory Map only
- ❌ Do not add authentication/login in MVP phase
- ❌ Do not use `file://` protocol for bot.html — must be served over HTTP
- ❌ Do not install `@zoom/meetingsdk` as a server dependency — it's CDN-only in bot.html for MVP
- ❌ Do not call `client.leave()` more than once per bot — wrap with a `hasLeft` flag

---

## 8. The `hasLeft` Guard Pattern

Every bot must use this guard to prevent double-leave errors:

```js
let hasLeft = false;

async function leave(reason) {
  if (hasLeft) return;
  hasLeft = true;
  try {
    await client.leave();
  } catch (e) {
    console.error('[Bot] Leave error:', e);
  }
  window.__BOT_STATUS__ = reason;
}
```

Use `leave('left-timer')`, `leave('left-meeting-ended')`, etc. everywhere.

---

## 9. Definition of Done

A task is complete only when ALL of the following are true:

- [ ] Code written and saved to correct file path per directory structure
- [ ] No hardcoded secrets or API keys
- [ ] All async functions have try/catch
- [ ] `hasLeft` guard used wherever `client.leave()` is called
- [ ] No console.log leaks of sensitive data
- [ ] Status strings match enum exactly
- [ ] Manually tested: launch a bot, verify it appears in Zoom, verify it leaves correctly
- [ ] Dashboard reflects correct status within 6 seconds of state change

---

## 10. Task Execution Order

Always implement in this order. Do not skip ahead.

```
T-001 → T-007   (project setup)
T-010           (signature.js — needed by everything)
T-011           (index.js routes — skeleton first)
T-012 → T-015  (botManager.js — core logic)
T-020 → T-027  (bot.html — SDK integration)
T-030 → T-035  (dashboard.html — UI)
T-040 → T-046  (integration testing)
```

Do not implement the dashboard before the backend is tested. Do not implement the bot page before `botManager.js` can spawn a browser.

---

## 11. Testing Checklist (Run Before Marking Any Phase Done)

```
Phase 1 done when:
  curl -X POST http://localhost:3000/api/signature \
    -H "Content-Type: application/json" \
    -d '{"meetingNumber":"123456789","role":0}'
  → returns { signature: "eyJ...", sdkKey: "..." }

Phase 2 done when:
  Bot page loads in regular Chrome (non-headless)
  SDK initializes without errors in browser console
  Bot appears in a Zoom test meeting with mic muted and video off

Phase 3 done when:
  Full flow works: launch → join → leave (both modes) → dashboard updates
```

---

## 12. Reference Links

- Zoom Web SDK docs: https://developers.zoom.us/docs/meeting-sdk/web/
- Zoom SDK Component View reference: https://marketplacefront.zoom.us/sdk/meeting/web/components/index.html
- Playwright docs: https://playwright.dev/docs/api/class-browser
- JWT generation reference: https://developers.zoom.us/docs/meeting-sdk/auth/
- Known issue — headless leave events: https://devforum.zoom.us/t/zoom-sdk-may-not-trigger-leave-events-for-bot-on-ubuntu-headless/132512
