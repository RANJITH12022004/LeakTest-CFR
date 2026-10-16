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
  local opt
  local IFS=','
  # shellcheck disable=SC2086
  set -- $opts
  for opt in "$@"; do
    if [ "$opt" = "ro" ]; then
      return 1
    fi
  done
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
  else
    _log "WARNING: USB still not writable after repair"
  fi
  exit 0
}

main "$@"
