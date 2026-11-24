#!/usr/bin/env bash
# Runtime USB health — uses shared /opt/kiosk repair.
set -u
INTERNAL_USB_PATH="${INTERNAL_USB_PATH:-/media/usb_internal}"
REPAIR_SCRIPT="/opt/kiosk/scripts/kiosk_repair_internal_usb.sh"
LOG_TAG="kiosk_usb_health"
_log() { echo "${LOG_TAG}: $*" >&2; }
_is_mounted() { mountpoint -q "$INTERNAL_USB_PATH" 2>/dev/null; }
_is_rw() {
  local opts probe opt
  _is_mounted || return 1
  opts="$(findmnt -n -o OPTIONS --target "$INTERNAL_USB_PATH" 2>/dev/null || true)"
  local IFS=','
  # shellcheck disable=SC2086
  set -- $opts
  for opt in "$@"; do [ "$opt" = "ro" ] && return 1; done
  probe="${INTERNAL_USB_PATH}/.kiosk_write_probe"
  if touch "$probe" 2>/dev/null; then rm -f "$probe" 2>/dev/null || true; return 0; fi
  return 1
}
if ! _is_mounted; then
  _log "USB not mounted — running repair/mount"
  /bin/bash "$REPAIR_SCRIPT" || true
  exit 0
fi
if _is_rw; then
  # Still apply fstab harden / option remount if stuck on remount-ro policy
  case "$(findmnt -n -o OPTIONS --target "$INTERNAL_USB_PATH" 2>/dev/null || true)" in
    *errors=remount-ro*) /bin/bash "$REPAIR_SCRIPT" || true ;;
  esac
  exit 0
fi
_log "USB remount-ro detected — repairing now"
/bin/bash "$REPAIR_SCRIPT" || true
exit 0
