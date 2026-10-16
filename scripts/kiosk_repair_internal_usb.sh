#!/usr/bin/env bash
# Harden: repair internal FAT USB after unclean shutdown / remount-ro, then remount RW.
# Must run as root (systemd ExecStartPre=+... or sudo from watchdog / bridge).
# Safe to call repeatedly. Exit 0 always so service start is not blocked.
set -u

INTERNAL_USB_PATH="${INTERNAL_USB_PATH:-/media/usb_internal}"
PART="${INTERNAL_USB_PARTITION:-/dev/sda1}"
APP_ROOT="${APP_ROOT:-/opt/kiosk}"
LOG_TAG="kiosk_repair_internal_usb"
# errors=continue: one bad FAT cluster must not lock the whole stick read-only.
# flush: shorter dirty window after power loss. No format, no wipe.
MOUNT_OPTS="rw,uid=1000,gid=1000,dmask=0022,fmask=0133,flush,errors=continue"

_log() { echo "${LOG_TAG}: $*" >&2; }

_is_safe_usb_part() {
  local p="$1" pk
  [ -b "$p" ] || return 1
  case "$p" in
    /dev/mmcblk*|/dev/zram*|/dev/loop*|/dev/ram*) return 1 ;;
  esac
  # Never treat the root filesystem device as the internal USB.
  if findmnt -n -o SOURCE / 2>/dev/null | grep -qx "$p"; then
    return 1
  fi
  pk="$(lsblk -no PKNAME "$p" 2>/dev/null | head -n1 || true)"
  case "$pk" in
    mmcblk*|zram*|loop*) return 1 ;;
  esac
  return 0
}

_resolve_part() {
  local src
  # Only trust findmnt SOURCE when the path is actually a mountpoint.
  # Otherwise findmnt walks up to / and returns mmcblk root — never use that.
  if mountpoint -q "$INTERNAL_USB_PATH" 2>/dev/null; then
    src="$(findmnt -n -o SOURCE --target "$INTERNAL_USB_PATH" 2>/dev/null || true)"
    if _is_safe_usb_part "$src"; then
      PART="$src"
      return 0
    fi
  fi
  if [ -n "${INTERNAL_USB_UUIDS:-}" ]; then
    local uuid
    for uuid in ${INTERNAL_USB_UUIDS//,/ }; do
      if [ -b "/dev/disk/by-uuid/$uuid" ]; then
        PART="$(readlink -f "/dev/disk/by-uuid/$uuid" 2>/dev/null || true)"
        if _is_safe_usb_part "$PART"; then
          return 0
        fi
      fi
    done
  fi
  if _is_safe_usb_part "$PART"; then
    return 0
  fi
  if _is_safe_usb_part /dev/sda1; then
    PART=/dev/sda1
    return 0
  fi
  return 1
}

_is_mounted() {
  mountpoint -q "$INTERNAL_USB_PATH" 2>/dev/null
}

# Exact mount flag only. "errors=remount-ro" must not count as read-only.
_mount_flag_is_ro() {
  local opt
  local IFS=','
  # shellcheck disable=SC2086
  set -- $1
  for opt in "$@"; do
    [ "$opt" = "ro" ] && return 0
  done
  return 1
}

_opts_lock_on_error() {
  local opts
  _is_mounted || return 1
  opts="$(findmnt -n -o OPTIONS --target "$INTERNAL_USB_PATH" 2>/dev/null || true)"
  case "$opts" in
    *errors=remount-ro*) return 0 ;;
  esac
  return 1
}

_is_rw() {
  local opts probe
  if ! _is_mounted; then
    return 1
  fi
  opts="$(findmnt -n -o OPTIONS --target "$INTERNAL_USB_PATH" 2>/dev/null || true)"
  if _mount_flag_is_ro "$opts"; then
    return 1
  fi
  probe="${INTERNAL_USB_PATH}/.kiosk_write_probe"
  if touch "$probe" 2>/dev/null; then
    rm -f "$probe" 2>/dev/null || true
    return 0
  fi
  return 1
}

_try_remount_rw() {
  local err
  if ! _is_mounted; then
    return 1
  fi
  err="$(mount -o "remount,${MOUNT_OPTS}" "$INTERNAL_USB_PATH" 2>&1)" || _log "remount rw failed: ${err}"
  _is_rw
}

_part_is_mounted() {
  findmnt -n -S "$PART" >/dev/null 2>&1
}

# Never lazy-unmount before fsck. A lazy unmount still holds the filesystem.
_umount_usb() {
  local i
  sync || true
  if ! _is_mounted && ! _part_is_mounted; then
    return 0
  fi
  for i in 1 2 3 4 5; do
    if _is_mounted; then
      umount "$INTERNAL_USB_PATH" 2>/dev/null || true
    fi
    if _part_is_mounted; then
      umount "$PART" 2>/dev/null || true
    fi
    if ! _is_mounted && ! _part_is_mounted; then
      return 0
    fi
    sleep 0.4
  done
  _log "USB still busy — leaving data in place, not checking the filesystem while mounted"
  fuser -vm "$INTERNAL_USB_PATH" >&2 || true
  return 1
}

_fsck_part() {
  if ! command -v fsck.vfat >/dev/null 2>&1; then
    _log "fsck.vfat not found; skipping repair"
    return 1
  fi
  if ! _is_safe_usb_part "$PART"; then
    _log "refusing fsck on unsafe/non-USB partition: ${PART:-empty}"
    return 1
  fi
  if _is_mounted || _part_is_mounted; then
    _log "refusing fsck while $PART is mounted"
    return 1
  fi
  _log "running fsck.vfat -a -w on $PART (repair only, no format)"
  # Exit 0 = clean, 1 = corrected; both OK for remount.
  fsck.vfat -a -w "$PART"
  local rc=$?
  if [ "$rc" -eq 0 ] || [ "$rc" -eq 1 ]; then
    _log "fsck completed (rc=$rc)"
    return 0
  fi
  _log "fsck reported rc=$rc (continuing to remount attempt)"
  return 0
}

_mount_usb() {
  local err
  mkdir -p "$INTERNAL_USB_PATH"
  if _is_mounted; then
    return 0
  fi
  if [ -b "$PART" ]; then
    if err="$(mount -t vfat -o "$MOUNT_OPTS" "$PART" "$INTERNAL_USB_PATH" 2>&1)"; then
      return 0
    fi
    _log "mount $PART failed: ${err}"
  fi
  if err="$(mount "$INTERNAL_USB_PATH" 2>&1)"; then
    return 0
  fi
  _log "mount $INTERNAL_USB_PATH failed: ${err}"
  return 1
}

# Stop future boots from locking the stick read-only. Does not touch other fstab rows.
_harden_fstab() {
  local fstab="/etc/fstab" line
  [ -f "$fstab" ] || return 0
  line="$(grep -E "[[:space:]]${INTERNAL_USB_PATH}[[:space:]]" "$fstab" | head -n1 || true)"
  [ -n "$line" ] || return 0
  case "$line" in
    *errors=remount-ro*) ;;
    *) return 0 ;;
  esac
  cp "$fstab" "/etc/fstab.bak.kiosk-usb-$(date +%Y%m%d%H%M%S)"
  sed -i "\|[[:space:]]${INTERNAL_USB_PATH}[[:space:]]|s/errors=remount-ro/errors=continue/" "$fstab"
  if ! grep -E "[[:space:]]${INTERNAL_USB_PATH}[[:space:]]" "$fstab" | grep -q 'flush'; then
    sed -i "\|[[:space:]]${INTERNAL_USB_PATH}[[:space:]]|s/errors=continue/flush,errors=continue/" "$fstab"
  fi
  _log "fstab updated so a FAT error does not lock $INTERNAL_USB_PATH read-only"
}

_ensure_dirs() {
  mkdir -p \
    "${INTERNAL_USB_PATH}/storage" \
    "${INTERNAL_USB_PATH}/reports" \
    "${INTERNAL_USB_PATH}/db" 2>/dev/null || true
  chown -R rle:rle \
    "${INTERNAL_USB_PATH}/storage" \
    "${INTERNAL_USB_PATH}/reports" \
    "${INTERNAL_USB_PATH}/db" 2>/dev/null || true
}

# After USB is RW again, push newer SD-card mirrors back so login/recipes are not empty on USB.
_promote_sd_mirror_to_usb() {
  local sd_storage="${APP_ROOT}/storage"
  local usb_storage="${INTERNAL_USB_PATH}/storage"
  local f src dst
  if [ ! -d "$sd_storage" ] || [ ! -d "$usb_storage" ]; then
    return 0
  fi
  if ! _is_rw; then
    return 0
  fi
  for f in members.json recipes.json reports.json factorySettings.json roles.json \
           current_user.json session_power_audit_pending.json test_run.json; do
    src="${sd_storage}/${f}"
    dst="${usb_storage}/${f}"
    if [ ! -f "$src" ]; then
      continue
    fi
    # Fill a missing or empty USB file only. Never replace data already on the stick.
    # Skip a source that is not valid JSON so a truncated SD copy is not planted on USB.
    if [ -f "$dst" ] && [ -s "$dst" ]; then
      continue
    fi
    if ! python3 -c 'import json,sys; json.load(open(sys.argv[1], encoding="utf-8"))' "$src" 2>/dev/null; then
      continue
    fi
    cp -a "$src" "$dst" 2>/dev/null || true
  done
  sync || true
  chown -R rle:rle "$usb_storage" 2>/dev/null || true
}

_repair_once() {
  _log "repairing $PART for $INTERNAL_USB_PATH"
  # A FAT volume the kernel marked read-only stays read-only until it is
  # unmounted, repaired, and mounted again. Remount alone does not clear that.
  if ! _umount_usb; then
    if _try_remount_rw; then
      _log "remount,rw succeeded while the device was busy"
      return 0
    fi
    return 1
  fi
  _fsck_part
  if ! _mount_usb; then
    _log "WARNING: remount failed"
    return 1
  fi
  if _is_rw; then
    return 0
  fi
  _try_remount_rw
}

main() {
  mkdir -p /run/lock
  exec 9>/run/lock/kiosk-internal-usb.lock
  if ! flock -w 180 9; then
    _log "another USB repair is still running"
    exit 0
  fi

  if ! _resolve_part; then
    _log "no internal USB partition found — app will use SD fallback"
    exit 0
  fi

  _harden_fstab

  local need_repair=0
  if _is_mounted; then
    if _opts_lock_on_error; then
      _log "live mount still locks read-only on FAT error — applying read-write options"
      if _try_remount_rw && ! _opts_lock_on_error && _is_rw; then
        _log "remounted read-write without unmounting"
      else
        need_repair=1
      fi
    elif ! _is_rw; then
      _log "USB mounted but not writable (likely remount-ro after power loss)"
      need_repair=1
    fi
  else
    # Not mounted yet: fsck before first mount so dirty FAT is cleaned.
    need_repair=1
  fi

  if [ "$need_repair" -eq 1 ]; then
    local attempt
    for attempt in 1 2 3; do
      if _repair_once; then
        break
      fi
      _log "repair attempt $attempt failed — retrying"
      sleep 1
    done
  fi

  if _is_mounted && ! _is_rw; then
    _log "still RO — final repair pass"
    _repair_once || true
  fi

  if _is_mounted && _is_rw; then
    _ensure_dirs
    _promote_sd_mirror_to_usb
    _log "USB OK (rw) on $PART"
    exit 0
  fi

  _log "WARNING: USB not writable after repair — SD fallback will be used"
  exit 0
}

main "$@"
