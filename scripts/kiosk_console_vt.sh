#!/usr/bin/env bash
# Keep the physical HDMI console on the kiosk X virtual terminal (vt2 for RealVNC),
# but allow the developer console on vt1 (Ctrl+Alt+F1) without yanking back.
set -euo pipefail

KIOSK_VT="${KIOSK_VT:-2}"
# Ctrl+Alt+F1 — login shell for maintenance. Do not force-chvt away from this VT.
DEV_VT="${DEV_VT:-1}"

switch_vt() {
  if command -v chvt >/dev/null 2>&1; then
    chvt "$KIOSK_VT" 2>/dev/null || true
  elif command -v openvt >/dev/null 2>&1; then
    openvt -f -s -w "$KIOSK_VT" -- true 2>/dev/null || true
  fi
}

# Leave the login tty immediately at boot (blank screen until X/Chromium is ready).
switch_vt

for _ in $(seq 1 240); do
  if [ -S /tmp/.X11-unix/X0 ]; then
    break
  fi
  sleep 0.5
done

switch_vt

# Production: return to kiosk if someone switches to an unused VT (F3–F6, etc.).
# Stay on DEV_VT so developers can work; Ctrl+Alt+F2 returns to the app.
while true; do
  sleep 2
  active="$(fgconsole 2>/dev/null || echo 0)"
  if [ "$active" = "$KIOSK_VT" ] || [ "$active" = "$DEV_VT" ]; then
    continue
  fi
  switch_vt
done
