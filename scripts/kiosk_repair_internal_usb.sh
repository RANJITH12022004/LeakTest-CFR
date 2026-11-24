#!/usr/bin/env bash
# Wrapper: shared internal USB repair lives under /opt/kiosk (common for both products).
exec /bin/bash /opt/kiosk/scripts/kiosk_repair_internal_usb.sh "$@"
