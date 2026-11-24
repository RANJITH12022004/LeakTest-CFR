#!/usr/bin/env bash
# Deploy audit-trail login/enable logging fixes to production kiosk.
set -euo pipefail

TARGET_HOST="${1:-100.90.98.85}"
TARGET_USER="${2:-rle}"
KIOSK_DIR="/opt/kiosk"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="${KIOSK_DIR}/backups/audit-fix-${STAMP}"

FILES=(app.py audit_service.py script.js)

echo "==> Backing up ${KIOSK_DIR} to ${BACKUP_DIR}"
ssh "${TARGET_USER}@${TARGET_HOST}" "sudo mkdir -p '${BACKUP_DIR}' && for f in ${FILES[*]}; do [ -f '${KIOSK_DIR}/'\$f ] && sudo cp '${KIOSK_DIR}/'\$f '${BACKUP_DIR}/'\$f || true; done"

echo "==> Copying patched files"
for f in "${FILES[@]}"; do
  scp "/workspace/${f}" "${TARGET_USER}@${TARGET_HOST}:/tmp/${f}.deploy"
  ssh "${TARGET_USER}@${TARGET_HOST}" "sudo mv /tmp/${f}.deploy '${KIOSK_DIR}/${f}' && sudo chown root:root '${KIOSK_DIR}/${f}'"
done

echo "==> Restarting kiosk-bridge.service"
ssh "${TARGET_USER}@${TARGET_HOST}" "sudo systemctl restart kiosk-bridge.service && sleep 2 && sudo systemctl is-active kiosk-bridge.service"

echo "==> Deploy complete (${STAMP})"
