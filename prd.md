# PRD — Zoom Bot Platform (ZBP)
**Version:** 0.1.0  
**Status:** MVP  
**Author:** Sparsh  
**Last Updated:** 2026-06-22

---

## 1. Overview

Zoom Bot Platform (ZBP) is a web application that allows a user to dispatch headless browser-based bots into Zoom meetings. Each bot joins a meeting as a silent participant (mic muted, video off), attends for a configurable duration, and leaves automatically based on one of two exit strategies: a predefined timer or detection of meeting end.

The platform exposes a dashboard UI to launch, monitor, and stop bots in real time.

---

## 2. Problem Statement

There is no simple, self-hosted tool to programmatically send a silent observer bot into a Zoom meeting without requiring the Zoom desktop client or native C++ SDK. Developers and power users need a lightweight web-based solution that leverages the Zoom Web Meeting SDK inside a headless Chromium browser, managed from a single UI.

---

## 3. Goals

- Bot can join any Zoom meeting given a meeting number and optional password
- Bot joins with mic muted and video off — completely silent
- Bot exits via one of two configurable modes:
  - **Timer mode:** leave after N milliseconds
  - **Meeting-end mode:** leave when host ends the meeting (connection-change Closed event)
- Dashboard UI to launch, view status of, and manually stop bots
- Each bot runs in an isolated Playwright Chromium instance
- Backend manages all bot lifecycle; frontend is read-only observer + control panel

---

## 4. Non-Goals (MVP)

- Audio/video recording or transcription
- Screen sharing or video playback by the bot
- Multi-user authentication (single-operator tool for now)
- Bot joining Google Meet or Microsoft Teams
- Persistent database (in-memory state is acceptable for MVP)
- Waiting room auto-admission (bot will report stuck status if held in waiting room)

---

## 5. Users

**Primary user (MVP):** The developer/operator — a single person who runs the server and uses the dashboard to manage bots. No login required.

**Future user:** End users on a SaaS platform who connect their Zoom accounts via OAuth and dispatch bots into their own meetings.

---

## 6. Core Features

### 6.1 Bot Launch
- Input: meeting number, password (optional), leave mode, duration (if timer mode)
- Backend generates SDK JWT signature server-side
- Playwright launches headless Chromium with fake audio/video devices
- Bot page loads Zoom Web SDK (Component View), joins meeting
- Immediately mutes mic and stops video after join

### 6.2 Leave Mode A — Timer
- After joining, `setTimeout(leave, N_ms)` fires
- Bot calls `client.leave()`
- Bot status updates to `left-timer`
- Playwright browser closes

### 6.3 Leave Mode B — Meeting End
- Bot listens to `connection-change` event from Zoom SDK
- When `payload.state === 'Closed'`, bot status updates to `left-meeting-ended`
- Playwright browser closes
- Safety cap: always leave after 3 hours regardless of mode

### 6.4 Dashboard
- Form: meeting number, password, leave mode selector, duration input
- Bot list: shows botId, meeting number, status, start time, stop button
- Auto-refreshes every 3 seconds via polling `/api/bots`
- Manual stop button calls `/api/bot/:id/stop`

### 6.5 Bot Status States
| Status | Meaning |
|---|---|
| `joining` | Playwright launched, SDK initializing |
| `waiting-room` | Bot held in waiting room |
| `in-meeting` | Joined successfully, attending |
| `left-timer` | Left after timer expired |
| `left-meeting-ended` | Left because host ended meeting |
| `left-manual` | Stopped manually from dashboard |
| `left-removed` | Kicked by host |
| `error` | SDK join failed |

---

## 7. Technical Constraints

- Zoom Web SDK version: `@zoom/meetingsdk` latest (v6.2.0 at time of writing)
- Headless Chromium must be launched with `--use-fake-ui-for-media-stream` and `--use-fake-device-for-media-stream` flags — without these, SDK fails to initialize in headless mode
- SDK JWT must be generated server-side only — Client Secret must never reach the browser
- Bot page must be served from localhost (not file://) due to SDK CORS restrictions
- Zoom development credentials only work for meetings hosted on the developer's own account

---

## 8. Success Metrics (MVP)

- Bot successfully joins a self-hosted test meeting within 15 seconds of launch
- Bot correctly leaves in both timer and meeting-end modes
- Dashboard accurately reflects bot status within 6 seconds of any state change
- Zero client-secret exposure in browser network tab

---

## 9. Future Roadmap

| Phase | Feature |
|---|---|
| v0.2 | Waiting room detection + timeout handling |
| v0.3 | Zoom OAuth login — bot joins meetings on user's account |
| v0.4 | Raw audio capture → Deepgram/Whisper transcription |
| v0.5 | Post-meeting transcript storage + summary via LLM |
| v1.0 | Multi-user SaaS, persistent DB, Docker deployment |
