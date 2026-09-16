#!/usr/bin/env bash
# Deploy biometric disable/enable re-enroll fix to a Leak Test kiosk Pi.
# Usage: ./scripts/deploy_biometric_fix_pi.sh [tailscale_ip]
set -euo pipefail

HOST="${1:-100.69.22.55}"
USER="rle"
REMOTE_DIR="/opt/kiosk"
STAMP="$(date +%Y%m%d_%H%M%S)"
BACKUP="/home/${USER}/backups/leaktest_pre_biometric_fix_${STAMP}.tar.gz"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> Backing up ${REMOTE_DIR} on ${USER}@${HOST}"
ssh -o ConnectTimeout=120 -o ServerAliveInterval=20 "${USER}@${HOST}" \
  "mkdir -p /home/${USER}/backups && sudo tar -czf '${BACKUP}' -C /opt kiosk"

echo "==> Copying patched files"
scp -o ConnectTimeout=120 \
  "${ROOT}/app.py" \
  "${ROOT}/data_service.py" \
  "${ROOT}/script.js" \
  "${USER}@${HOST}:/tmp/"

ssh -o ConnectTimeout=120 "${USER}@${HOST}" bash -s <<'REMOTE'
set -euo pipefail
sudo cp /tmp/app.py /tmp/data_service.py /tmp/script.js /opt/kiosk/
sudo chown rle:rle /opt/kiosk/app.py /opt/kiosk/data_service.py /opt/kiosk/script.js
sudo systemctl restart kiosk-bridge.service
sleep 2
systemctl is-active kiosk-bridge.service
REMOTE

echo "==> Deploy complete. Backup: ${BACKUP}"
