#!/usr/bin/env bash
# Deploy calibration reports list fix to a Leak Test kiosk Pi (production-safe).
# Updates app files only — does NOT touch storage/, venv/, or factory data.
#
# Usage: ./scripts/deploy_calibration_reports_fix_pi.sh [tailscale_ip]
set -euo pipefail

HOST="${1:-100.69.22.55}"
USER="rle"
REMOTE_DIR="/opt/kiosk"
STAMP="$(date +%Y%m%d_%H%M%S)"
BACKUP="/home/${USER}/backups/leaktest_pre_cal_reports_fix_${STAMP}.tar.gz"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> Backing up ${REMOTE_DIR} code on ${USER}@${HOST} (excluding storage + venv)"
ssh -o ConnectTimeout=120 -o ServerAliveInterval=20 "${USER}@${HOST}" bash -s <<REMOTE
set -euo pipefail
mkdir -p /home/${USER}/backups
sudo tar -czf '${BACKUP}' \
  --exclude='kiosk/storage' \
  --exclude='kiosk/venv' \
  --exclude='kiosk/.git' \
  -C /opt kiosk
REMOTE

echo "==> Copying patched files"
scp -o ConnectTimeout=120 \
  "${ROOT}/index.html" \
  "${ROOT}/styles.css" \
  "${ROOT}/script.js" \
  "${ROOT}/data_service.py" \
  "${USER}@${HOST}:/tmp/"

ssh -o ConnectTimeout=120 "${USER}@${HOST}" bash -s <<'REMOTE'
set -euo pipefail
sudo cp /tmp/index.html /tmp/styles.css /tmp/script.js /tmp/data_service.py /opt/kiosk/
sudo chown rle:rle /opt/kiosk/index.html /opt/kiosk/styles.css /opt/kiosk/script.js /opt/kiosk/data_service.py
sudo systemctl restart kiosk-bridge.service
sleep 2
systemctl is-active kiosk-bridge.service
REMOTE

echo "==> Deploy complete. Backup: ${BACKUP}"
echo "==> On the kiosk: Reports -> Calibration Reports"
