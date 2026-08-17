# TD-2B OQ Execution Environment Snapshot

**Date:** 2026-08-20  
**Instrument:** Tap Density Tester (Model TD-2B per checklist; firmware RLT-2B in factory settings)  
**Software Version:** RDA -LT v1.0.0 (firmware field in factory settings)

## Services

| Service | Status |
|---------|--------|
| kiosk-bridge.service | active |
| kiosk-display.service | active |
| kiosk-internal-usb-mount.service | active |

## Storage paths

| Path | Purpose |
|------|---------|
| `/media/usb_internal/storage` | JSON data (members, recipes, reports index) |
| `/media/usb_internal/reports` | PDF and print artifacts |
| `/media/usb_internal/db` | SQLite audit_log.db |

**Note:** `/media/usb_internal` is present on root filesystem (`/dev/root`); dedicated internal USB block device not mounted at execution time.

## Network

- Hostname: raspberrypi
- API: http://127.0.0.1:5000 (HTTP 200)

## Hardware devices present

| Device | Path | Notes |
|--------|------|-------|
| MCU serial | `/dev/serial0` → ttyAMA0 | Present |
| Thermal printer | `/dev/ttyAMA3` | Present |
| A4 / dot matrix | `/dev/ttyAMA4` | Present |
| Fingerprint (R307) | `/dev/ttyAMA5` | Present |
| RTC | `/dev/rtc0` | Present |

## Checklist header (for Word document)

| Field | Value |
|-------|-------|
| Equipment / Instrument Name | Tap Density Tester |
| Model No. | TD-2B |
| Equipment ID / Asset No. | *(site to complete)* |
| Location / Department | Quality Control Laboratory |
| Software Version | RDA -LT v1.0.0 |
| Checklist Reference SOP No. | *(site to complete)* |
| Date of Execution | 2026-08-20 |

## Factory settings snapshot

- biometricEnabled: true
- autoLogoutMinutes: 1
- passwordResetPeriodDays: 30
- instrumentId / serialNo: N/A (configure on site)
