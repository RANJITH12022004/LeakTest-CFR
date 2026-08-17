#!/usr/bin/env bash
# Production hardening: keep HDMI on kiosk X (vt2), not login getty.
# Run at install, every boot, after apt upgrades, and from the watchdog.
#
#   sudo /opt/kiosk/scripts/kiosk_harden_display.sh          # full sync
#   sudo /opt/kiosk/scripts/kiosk_harden_display.sh --quick  # mask getty only (watchdog)
#   sudo /opt/kiosk/scripts/kiosk_harden_display.sh --repair # quick + restart display if down
set -euo pipefail

APP_ROOT="${APP_ROOT:-/opt/kiosk}"
KIOSK_USER="${KIOSK_USER:-rle}"
KIOSK_HOME="$(getent passwd "$KIOSK_USER" 2>/dev/null | cut -d: -f6 || true)"
QUICK=0
BOOT=0
REPAIR=0
QUIET=0

for arg in "$@"; do
  case "$arg" in
    --quick) QUICK=1 ;;
    --boot) BOOT=1 ;;
    --repair) REPAIR=1 ;;
    --quiet) QUIET=1 ;;
  esac
done

log() {
  if [ "$QUIET" -eq 0 ]; then
    echo "$*"
  fi
}

warn() {
  echo "WARN: $*" >&2
}

need_root() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "Run as root: sudo $APP_ROOT/scripts/kiosk_harden_display.sh" >&2
    exit 1
  fi
}

mask_console_gettys() {
  local tty dropin n=0
  for tty in 1 2 3 4 5 6; do
    dropin="/etc/systemd/system/getty@${tty}.service.d"
    if [ -d "$dropin" ]; then
      mkdir -p "$dropin"
      for conf in autologin.conf override.conf; do
        if [ -f "$dropin/$conf" ]; then
          mv "$dropin/$conf" "$dropin/${conf}.disabled"
        fi
      done
    fi
    systemctl stop "getty@${tty}.service" 2>/dev/null || true
    systemctl disable "getty@${tty}.service" 2>/dev/null || true
    if systemctl mask "getty@${tty}.service" 2>/dev/null; then
      n=$((n + 1))
    else
      warn "could not mask getty@${tty}.service"
    fi
  done
  log "Masked ${n}/6 console getty units (tty1–tty6)"
}

disable_desktop_managers() {
  systemctl disable --now lightdm.service 2>/dev/null || true
  systemctl mask lightdm.service 2>/dev/null || true
}

sync_systemd_units() {
  if [ -f "$APP_ROOT/config/internal_usb.env" ]; then
    # shellcheck disable=SC1090
    source "$APP_ROOT/config/internal_usb.env"
  fi
  local uuid="${INTERNAL_USB_UUID:-D444-057C}"
  sed -e "s/INTERNAL_USB_UUIDS=.*/INTERNAL_USB_UUIDS=${uuid}/" \
    "$APP_ROOT/kiosk-bridge.service" > /tmp/kiosk-bridge.service
  cp /tmp/kiosk-bridge.service /etc/systemd/system/kiosk-bridge.service
  cp "$APP_ROOT/kiosk-display.service" /etc/systemd/system/kiosk-display.service
  cp "$APP_ROOT/kiosk-console-vt.service" /etc/systemd/system/kiosk-console-vt.service
  cp "$APP_ROOT/kiosk-display-guard.service" /etc/systemd/system/kiosk-display-guard.service
  cp "$APP_ROOT/kiosk-watchdog.service" /etc/systemd/system/kiosk-watchdog.service
  cp "$APP_ROOT/kiosk-watchdog.timer" /etc/systemd/system/kiosk-watchdog.timer
  cp "$APP_ROOT/kiosk-internal-usb-mount.service" /etc/systemd/system/kiosk-internal-usb-mount.service
  systemctl daemon-reload
  log "Synced kiosk systemd units from ${APP_ROOT}"
}

install_user_session_files() {
  if [ -z "${KIOSK_HOME:-}" ] || [ ! -d "$KIOSK_HOME" ]; then
    warn "home for ${KIOSK_USER} not found — skip xinitrc install"
    return 0
  fi
  install -o "$KIOSK_USER" -g "$KIOSK_USER" -m 0755 "$APP_ROOT/config/xinitrc" "$KIOSK_HOME/.xinitrc"
  log "Installed ${KIOSK_HOME}/.xinitrc"
}

enable_kiosk_display_stack() {
  systemctl enable kiosk-display.service kiosk-console-vt.service kiosk-display-guard.service kiosk-watchdog.timer 2>/dev/null || true
}

display_running() {
  pgrep -f '/usr/lib/xorg/Xorg :0' >/dev/null 2>&1 \
    && pgrep -f '/usr/lib/chromium/chromium.*--app=' >/dev/null 2>&1
}

getty_leaked() {
  local tty
  for tty in 1 2 3 4 5 6; do
    if systemctl is-active "getty@${tty}.service" >/dev/null 2>&1; then
      return 0
    fi
    if systemctl is-enabled "getty@${tty}.service" 2>/dev/null | grep -qE 'enabled|static'; then
      if ! systemctl is-enabled "getty@${tty}.service" 2>/dev/null | grep -q masked; then
        return 0
      fi
    fi
  done
  return 1
}

unit_tty_mismatch() {
  if [ ! -f /etc/systemd/system/kiosk-display.service ]; then
    return 0
  fi
  if ! grep -q 'TTYPath=/dev/tty2' /etc/systemd/system/kiosk-display.service 2>/dev/null; then
    return 0
  fi
  if ! grep -q 'vt2' "$APP_ROOT/scripts/run_kiosk_display.sh" 2>/dev/null; then
    return 0
  fi
  return 1
}

repair_display_if_needed() {
  if [ "$REPAIR" -eq 0 ]; then
    return 0
  fi
  if display_running; then
    return 0
  fi
  log "Display not running — restarting kiosk-display + kiosk-console-vt"
  systemctl restart kiosk-display.service 2>/dev/null || true
  systemctl restart kiosk-console-vt.service 2>/dev/null || true
}

main() {
  need_root

  if [ "$BOOT" -eq 1 ]; then
    mask_console_gettys
    disable_desktop_managers
    if unit_tty_mismatch; then
      cp "$APP_ROOT/kiosk-display.service" /etc/systemd/system/kiosk-display.service
      systemctl daemon-reload
      log "Re-synced stale kiosk-display.service (expected TTYPath=/dev/tty2)"
    fi
    exit 0
  fi

  if [ "$QUICK" -eq 1 ]; then
    if getty_leaked || unit_tty_mismatch; then
      log "Console getty leak or stale display unit detected — re-hardening"
      mask_console_gettys
      if unit_tty_mismatch; then
        cp "$APP_ROOT/kiosk-display.service" /etc/systemd/system/kiosk-display.service
        systemctl daemon-reload
      fi
    fi
    disable_desktop_managers
    repair_display_if_needed
    exit 0
  fi

  log "==> Kiosk display production hardening"
  sync_systemd_units
  install_user_session_files
  mask_console_gettys
  disable_desktop_managers
  enable_kiosk_display_stack
  systemctl restart kiosk-console-vt.service 2>/dev/null || true
  if ! display_running; then
    systemctl restart kiosk-display.service 2>/dev/null || true
  fi
  log "==> Display hardening complete"
}

main "$@"
