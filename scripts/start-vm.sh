#!/usr/bin/env bash
#
# Start the bot platform on a headless Linux VM (e.g. Oracle Ubuntu).
#
# Presenter bots play a video and screen-SHARE it into the meeting. Two things a
# bare server lacks that this script provides:
#
#   1. A virtual audio device (PulseAudio null sink). The Zoom Web SDK only
#      transmits shared audio when capturing a browser TAB, and Chromium can
#      only produce that tab-audio track if an audio OUTPUT device exists.
#      Without one, getDisplayMedia fails with "could not start audio source"
#      and the shared clip is silent.
#   2. A virtual display (Xvfb). The presenter Chromium runs headed so it has
#      real pixels to capture; a headless server has no X server otherwise.
#
# Prerequisites (run once):
#   sudo apt-get update && sudo apt-get install -y pulseaudio pulseaudio-utils xvfb
#
# Usage:
#   npm run start:vm        (or: bash scripts/start-vm.sh)
set -euo pipefail

# Chromium (spawned by Playwright) connects to PulseAudio via XDG_RUNTIME_DIR,
# so the daemon and the browser must agree on it.
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/xdg-runtime}"
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

# ── Virtual audio device ─────────────────────────────────────────────────────
# pulseaudio --start is a no-op if a daemon is already running.
pulseaudio --start --exit-idle-time=-1 || true

# Wait briefly for the control socket, then add a null sink if not already there.
for _ in $(seq 1 20); do pactl info >/dev/null 2>&1 && break; sleep 0.25; done
if ! pactl list short sinks 2>/dev/null | grep -q '\bvspeaker\b'; then
  pactl load-module module-null-sink sink_name=vspeaker \
    sink_properties=device.description=VirtualSpeaker >/dev/null
fi
pactl set-default-sink vspeaker >/dev/null 2>&1 || true
echo "[start:vm] PulseAudio virtual sink ready (default sink: vspeaker)"

# ── Virtual display + app ────────────────────────────────────────────────────
# -a picks a free display number; the screen size only needs to be large enough
# for the kiosk-fullscreen presenter window.
echo "[start:vm] Launching under Xvfb…"
exec xvfb-run -a --server-args="-screen 0 1280x720x24" node server/index.js
