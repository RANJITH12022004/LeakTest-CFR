#!/usr/bin/env bash
# Harden: repair internal FAT USB after unclean shutdown / remount-ro, then remount RW.
# Must run as root (systemd ExecStartPre=+... or sudo from watchdog / bridge).
# Safe to call repeatedly. Exit 0 always so service start is not blocked.
set -u

INTERNAL_USB_PATH="${INTERNAL_USB_PATH:-/media/usb_internal}"
PART="${INTERNAL_USB_PARTITION:-/dev/sda1}"
APP_ROOT="${APP_ROOT:-/opt/kiosk}"
LOG_TAG="kiosk_repair_internal_usb"
# flush = reduce dirty FAT windows after power loss (slower writes, safer kiosk)
MOUNT_OPTS="rw,uid=1000,gid=1000,dmask=0022,fmask=0133,flush,errors=remount-ro,nofail,x-systemd.device-timeout=3"

_log() { echo "${LOG_TAG}: $*" >&2; }

_resolve_part() {
  local src
  src="$(findmnt -n -o SOURCE --target "$INTERNAL_USB_PATH" 2>/dev/null || true)"
  if [ -n "$src" ] && [ -b "$src" ]; then
    PART="$src"
    return 0
  fi
  if [ -n "${INTERNAL_USB_UUIDS:-}" ]; then
    local uuid
    for uuid in ${INTERNAL_USB_UUIDS//,/ }; do
      if [ -b "/dev/disk/by-uuid/$uuid" ]; then
        PART="$(readlink -f "/dev/disk/by-uuid/$uuid" 2>/dev/null || true)"
        if [ -b "$PART" ]; then
          return 0
        fi
      fi
    done
  fi
  if [ -b "$PART" ]; then
    return 0
  fi
  if [ -b /dev/sda1 ]; then
    PART=/dev/sda1
    return 0
  fi
  return 1
}

_is_mounted() {
  mountpoint -q "$INTERNAL_USB_PATH" 2>/dev/null
}

_is_rw() {
  local opts probe
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

_try_remount_rw() {
  if ! _is_mounted; then
    return 1
  fi
  mount -o remount,rw "$INTERNAL_USB_PATH" 2>/dev/null || true
  # Explicit remount with flush opts when kernel left the FS RO after FAT error.
  if [ -b "$PART" ]; then
    mount -o "remount,${MOUNT_OPTS}" "$PART" "$INTERNAL_USB_PATH" 2>/dev/null || true
  fi
  _is_rw
}

_umount_usb() {
  sync || true
  if ! _is_mounted; then
    return 0
  fi
  local i
  for i in 1 2 3; do
    if umount "$INTERNAL_USB_PATH" 2>/dev/null; then
      return 0
    fi
    sleep 0.3
  done
  umount -l "$INTERNAL_USB_PATH" 2>/dev/null || true
  sleep 0.5
  return 0
}

_fsck_part() {
  if ! command -v fsck.vfat >/dev/null 2>&1; then
    _log "fsck.vfat not found; skipping repair"
    return 1
  fi
  if [ ! -b "$PART" ]; then
    _log "partition missing: $PART"
    return 1
  fi
  # Ensure nothing holds the device.
  if findmnt -n -S "$PART" >/dev/null 2>&1; then
    _log "device still mounted elsewhere — forcing lazy umount"
    umount -l "$PART" 2>/dev/null || true
    sleep 0.5
  fi
  _log "running fsck.vfat -a -w on $PART"
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
  mkdir -p "$INTERNAL_USB_PATH"
  if [ -b "$PART" ]; then
    if mount -t vfat -o "$MOUNT_OPTS" "$PART" "$INTERNAL_USB_PATH" 2>/dev/null; then
      return 0
    fi
  fi
  # fstab helper fallback
  if mount "$INTERNAL_USB_PATH" 2>/dev/null; then
    return 0
  fi
  return 1
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
    # Prefer larger / newer SD copy when USB missing, empty, or clearly smaller.
    if [ ! -f "$dst" ] || [ ! -s "$dst" ]; then
      cp -a "$src" "$dst" 2>/dev/null || true
      continue
    fi
    local ssz dsz
    ssz="$(wc -c < "$src" 2>/dev/null || echo 0)"
    dsz="$(wc -c < "$dst" 2>/dev/null || echo 0)"
    if [ "${ssz:-0}" -gt "${dsz:-0}" ]; then
      cp -a "$src" "$dst" 2>/dev/null || true
    fi
  done
  sync || true
  chown -R rle:rle "$usb_storage" 2>/dev/null || true
}

_repair_once() {
  _log "repairing $PART for $INTERNAL_USB_PATH"
  # Fast path: try remount,rw without fsck first.
  if _try_remount_rw; then
    _log "remount,rw succeeded without fsck"
    return 0
  fi
  _umount_usb
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
  if ! _resolve_part; then
    _log "no internal USB partition found — app will use SD fallback"
    exit 0
  fi

  local need_repair=0
  if _is_mounted; then
    if ! _is_rw; then
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
