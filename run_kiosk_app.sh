#!/usr/bin/env bash
# Launcher used by kiosk-bridge.service to start the Leak Test Flask backend.
# Mirrors the manual flow in /opt/kiosk/start_kiosk.sh (backend only; no Chromium).

set -euo pipefail

APP_ROOT="${APP_ROOT:-/opt/kiosk}"
PYTHON="${PYTHON:-/opt/kiosk/venv/bin/python3}"
INTERNAL_USB_PATH="${INTERNAL_USB_PATH:-/media/usb_internal}"

cd "$APP_ROOT"

_dir_writable() {
  local d="$1"
  local probe
  mkdir -p "$d" 2>/dev/null || return 1
  probe="${d}/.kiosk_write_probe"
  if touch "$probe" 2>/dev/null; then
    rm -f "$probe" 2>/dev/null || true
    return 0
  fi
  return 1
}

# Prefer internal USB when mounted AND writable.
# After power-loss FAT may remount-ro; repair script should heal it, but if not, use SD.
if mountpoint -q "$INTERNAL_USB_PATH" 2>/dev/null && _dir_writable "$INTERNAL_USB_PATH/storage"; then
  export INTERNAL_USB_PATH
  export STORAGE_DIR="${STORAGE_DIR:-$INTERNAL_USB_PATH/storage}"
  export REPORTS_DIR="${REPORTS_DIR:-$INTERNAL_USB_PATH/reports}"
  export AUDIT_DB_DIR="${AUDIT_DB_DIR:-$INTERNAL_USB_PATH/db}"
  export INTERNAL_USB_UUIDS="${INTERNAL_USB_UUIDS:-D444-057C}"
  echo "run_kiosk_app: using USB storage at $STORAGE_DIR" >&2
else
  unset STORAGE_DIR REPORTS_DIR AUDIT_DB_DIR 2>/dev/null || true
  export STORAGE_DIR="$APP_ROOT/storage"
  export REPORTS_DIR="$APP_ROOT/reports"
  export AUDIT_DB_DIR="$APP_ROOT/db"
  mkdir -p "$STORAGE_DIR" "$REPORTS_DIR" "$AUDIT_DB_DIR"
  # Seed critical files from USB if readable but RO (so login still works).
  # Treat empty JSON placeholders ([] / {}) as missing — "[ ! -s ]" is NOT enough.
  if mountpoint -q "$INTERNAL_USB_PATH" 2>/dev/null; then
    _needs_seed() {
      local f="$1"
      if [ ! -f "$f" ]; then return 0; fi
      local sz
      sz="$(wc -c < "$f" 2>/dev/null || echo 0)"
      if [ "${sz:-0}" -le 4 ]; then
        local raw
        raw="$(tr -d '[:space:]' < "$f" 2>/dev/null || true)"
        case "$raw" in
          ''|'[]'|'{}'|'null') return 0 ;;
        esac
      fi
      return 1
    }
    for f in members.json factorySettings.json recipes.json reports.json roles.json; do
      src="$INTERNAL_USB_PATH/storage/$f"
      dst="$STORAGE_DIR/$f"
      if [ -f "$src" ] && _needs_seed "$dst"; then
        cp -a "$src" "$dst" 2>/dev/null || true
      fi
    done
  fi
  echo "run_kiosk_app: USB unavailable/RO — using SD storage at $STORAGE_DIR" >&2
fi

if [ -f "$APP_ROOT/config/internal_usb.env" ]; then
  # shellcheck disable=SC1090
  source "$APP_ROOT/config/internal_usb.env"
  export INTERNAL_USB_UUIDS="${INTERNAL_USB_UUIDS:-${INTERNAL_USB_UUID:-}}"
  export INTERNAL_USB_PKNAME="${INTERNAL_USB_PKNAME:-sda}"
  export INTERNAL_USB_PARTITION="${INTERNAL_USB_PARTITION:-/dev/sda1}"
fi

export APP_ROOT PYTHONUNBUFFERED=1
export FLASK_HOST=0.0.0.0
export LEAK_TEST_SIMULATE="${LEAK_TEST_SIMULATE:-0}"
exec "$PYTHON" "$APP_ROOT/bridge.py"
