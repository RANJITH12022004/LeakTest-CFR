#!/usr/bin/env bash
# Ensure internal pendrive is mounted at /media/usb_internal and project dirs exist.
# Assumes kiosk_repair_internal_usb.sh already ran (as root) to heal remount-ro / dirty FAT.
set -euo pipefail

INTERNAL_USB_PATH="${INTERNAL_USB_PATH:-/media/usb_internal}"
STORAGE_DIR="${STORAGE_DIR:-$INTERNAL_USB_PATH/storage}"
REPORTS_DIR="${REPORTS_DIR:-$INTERNAL_USB_PATH/reports}"
AUDIT_DB_DIR="${AUDIT_DB_DIR:-$INTERNAL_USB_PATH/db}"

_writable_mount() {
  local probe="${INTERNAL_USB_PATH}/.kiosk_write_probe"
  touch "$probe" 2>/dev/null || return 1
  rm -f "$probe" 2>/dev/null || true
  return 0
}

_ensure_project_dirs() {
  mkdir -p "$STORAGE_DIR" "$REPORTS_DIR" "$AUDIT_DB_DIR"
  APP_ROOT="${APP_ROOT:-/opt/kiosk}"
  if [ -x "$APP_ROOT/scripts/migrate_storage_to_internal_usb.sh" ]; then
    if [ ! -f "$STORAGE_DIR/members.json" ] && [ -f "$APP_ROOT/storage/members.json" ]; then
      /bin/bash "$APP_ROOT/scripts/migrate_storage_to_internal_usb.sh" || true
    fi
  fi
}

if mountpoint -q "$INTERNAL_USB_PATH" 2>/dev/null; then
  if _writable_mount; then
    _ensure_project_dirs
    exit 0
  fi
  echo "kiosk_mount_internal_usb: WARNING $INTERNAL_USB_PATH is mounted but not writable" >&2
  # Do not fail start — run_kiosk_app.sh / data_service will fall back to SD.
  exit 0
fi

# fstab entry should mount this during local-fs.target; retry briefly if udev is still settling.
if command -v mount >/dev/null 2>&1; then
  mount "$INTERNAL_USB_PATH" 2>/dev/null || true
fi

for _i in $(seq 1 5); do
  if mountpoint -q "$INTERNAL_USB_PATH" 2>/dev/null; then
    if _writable_mount; then
      _ensure_project_dirs
      exit 0
    fi
    echo "kiosk_mount_internal_usb: WARNING $INTERNAL_USB_PATH mounted but not writable" >&2
    exit 0
  fi
  sleep 0.4
done

echo "kiosk_mount_internal_usb: WARNING $INTERNAL_USB_PATH not mounted — app will use SD-card storage as fallback" >&2
# Do NOT exit 1 here: the app must start regardless; data_service falls back to /opt/kiosk/storage on the SD card.
exit 0
