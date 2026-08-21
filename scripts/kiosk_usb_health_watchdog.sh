#!/usr/bin/env bash
# Runtime USB health: detect remount-ro after power cut and heal without waiting for bridge restart.
# Intended to run as root via systemd timer (or sudo from kiosk-watchdog).
set -u

APP_ROOT="${APP_ROOT:-/opt/kiosk}"
INTERNAL_USB_PATH="${INTERNAL_USB_PATH:-/media/usb_internal}"
REPAIR_SCRIPT="${APP_ROOT}/scripts/kiosk_repair_internal_usb.sh"
LOG_TAG="kiosk_usb_health"

_log() { echo "${LOG_TAG}: $*" >&2; }

_is_mounted() {
  mountpoint -q "$INTERNAL_USB_PATH" 2>/dev/null
}

_is_rw() {
  local opts probe
  if ! _is_mounted; then
    return 1
  fi
  opts="$(findmnt -n -o OPTIONS --target "$INTERNAL_USB_PATH" 2>/dev/null || true)"
  case ",${opts}," in
    *,ro,*) return 1 ;;
  esac
  probe="${INTERNAL_USB_PATH}/.kiosk_write_probe"
  if touch "$probe" 2>/dev/null; then
    rm -f "$probe" 2>/dev/null || true
    return 0
  fi
  return 1
}

main() {
  if ! _is_mounted; then
    _log "USB not mounted — running repair/mount"
    /bin/bash "$REPAIR_SCRIPT" || true
    exit 0
  fi
  if _is_rw; then
    exit 0
  fi
  _log "USB remount-ro detected — repairing now"
  /bin/bash "$REPAIR_SCRIPT" || true
  if _is_rw; then
    _log "USB restored to rw"
    # Nudge API to re-bind STORAGE_DIR without full display restart when possible.
    if systemctl is-active --quiet kiosk-bridge.service 2>/dev/null; then
      # Soft signal: restart bridge so run_kiosk_app.sh reselects USB storage.
      systemctl try-restart kiosk-bridge.service 2>/dev/null || true
    fi
  else
    _log "WARNING: USB still not writable after repair"
  fi
  exit 0
}

main "$@"
