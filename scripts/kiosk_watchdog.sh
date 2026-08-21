#!/usr/bin/env bash
# Lightweight health check: restart API or display if they died; heal remount-ro USB.
set -uo pipefail

API_URL="${KIOSK_URL:-http://127.0.0.1:5000/}"
APP_ROOT="${APP_ROOT:-/opt/kiosk}"
INTERNAL_USB_PATH="${INTERNAL_USB_PATH:-/media/usb_internal}"
LOG_TAG="kiosk-watchdog"

log() { echo "$LOG_TAG: $*" >&2; }

api_ok() {
  curl -sf --connect-timeout 2 --max-time 4 "$API_URL" >/dev/null 2>&1
}

display_ok() {
  pgrep -f '/usr/lib/xorg/Xorg :0' >/dev/null 2>&1 \
    && pgrep -f '/usr/lib/chromium/chromium.*--app=' >/dev/null 2>&1
}

usb_needs_repair() {
  if ! mountpoint -q "$INTERNAL_USB_PATH" 2>/dev/null; then
    return 0
  fi
  local opts probe
  opts="$(findmnt -n -o OPTIONS --target "$INTERNAL_USB_PATH" 2>/dev/null || true)"
  case ",${opts}," in
    *,ro,*) return 0 ;;
  esac
  probe="${INTERNAL_USB_PATH}/.kiosk_write_probe"
  if touch "$probe" 2>/dev/null; then
    rm -f "$probe" 2>/dev/null || true
    return 1
  fi
  return 0
}

if usb_needs_repair; then
  log "USB remount-ro / missing — running repair"
  /bin/bash "$APP_ROOT/scripts/kiosk_usb_health_watchdog.sh" || true
fi

if ! api_ok; then
  log "API down — restarting kiosk-bridge.service"
  systemctl restart kiosk-bridge.service || true
  sleep 3
fi

if ! display_ok; then
  log "Display down — re-hardening getty/display then restarting"
  /bin/bash /opt/kiosk/scripts/kiosk_harden_display.sh --quick --repair --quiet || true
fi

exit 0
