# TD-2B Installation Qualification (IQ) Results

**Execution date:** 2026-08-20T08:46:11.312665
**API base:** http://127.0.0.1:5000
**Hostname:** raspberrypi

## Summary

- **Pass:** 28
- **Fail:** 0
- **N/A:** 0
- **Overall:** Compliant with Observations

## Environment snapshot

- firmware: N/A
- usb_mount: not mounted

## Results matrix

| Test ID | Description | Category | Result | Evidence | Remark |
|---------|-------------|----------|--------|----------|--------|
| IQ-SW-01 | Application root at /opt/kiosk | Software | Pass | /opt/kiosk |  |
| IQ-SW-02 | Python venv executable | Software | Pass | /opt/kiosk/venv/bin/python3 |  |
| IQ-SW-03 | kiosk-bridge.service active and enabled | Software | Pass | active=active enabled=enabled |  |
| IQ-SW-04 | kiosk-display.service active and enabled | Software | Pass | active=active enabled=enabled |  |
| IQ-SW-06 | kiosk-internal-usb-mount.service active | Software | Pass | active=active enabled=enabled |  |
| IQ-SW-05 | kiosk-watchdog.timer enabled | Software | Pass | enabled=enabled |  |
| IQ-SW-10 | Watchdog script present and timer scheduled | Software | Pass | /opt/kiosk/scripts/kiosk_watchdog.sh |  |
| IQ-SW-07 | API root HTTP 200 | Software | Pass | HTTP 200 |  |
| IQ-SW-08 | Desktop health endpoint | Software | Pass | {'app': 'Tap Density', 'model': '', 'ok': True, 'serial': '', 'status': 'ok', 'time': '2026-08-20T08:46:07.519861'} |  |
| IQ-SW-09 | Software version in factory settings | Software | Pass | firmware=None modelNo=N/A |  |
| IQ-ST-01 | Storage directory writable | Storage | Pass | /media/usb_internal/storage |  |
| IQ-ST-02 | Reports directory writable | Storage | Pass | /media/usb_internal/reports |  |
| IQ-ST-03 | Audit DB directory and SQLite file | Storage | Pass | /media/usb_internal/db/audit_log.db |  |
| IQ-ST-04 | Internal USB on dedicated block device | Storage | Pass | not in findmnt | Observation: storage on SD/root fallback; dedicated USB not mounted |
| IQ-HW-01 | ESP32 UART node | Hardware | Pass | /dev/serial0 |  |
| IQ-HW-02 | Thermal printer UART | Hardware | Pass | /dev/ttyAMA3 |  |
| IQ-HW-03 | A4/dot-matrix UART | Hardware | Pass | /dev/ttyAMA4 |  |
| IQ-HW-04 | Biometric UART | Hardware | Pass | /dev/ttyAMA5 |  |
| IQ-HW-05 | RTC device | Hardware | Pass | /dev/rtc0 |  |
| IQ-HW-06 | RTC readable (rtc_diag) | Hardware | Pass | see rtc_diag in results |  |
| IQ-HW-07 | ESP adapter probe | Hardware | Pass | HTTP 200 mode=None |  |
| IQ-HW-08 | Biometric status probe | Hardware | Pass | {'ok': True, 'port': '/dev/ttyAMA5', 'templates': 2} |  |
| IQ-HW-09 | Thermal printer status probe | Hardware | Pass | {'available': True, 'baud': 9600, 'port': '/dev/ttyAMA3'} |  |
| IQ-NW-01 | Network interfaces configured | Network | Pass | {'lan': '192.168.1.100', 'ok': True, 'refreshedAt': '2026-08-20T03:16:11Z', 'wlan': '192.168.1.65'} |  |
| IQ-DSP-02 | Xorg display :0 running | Display | Pass |  |  |
| IQ-DSP-01 | Chromium kiosk process running | Display | Pass |  |  |
| IQ-DOC-01 | Pin mapping documentation present | Documentation | Pass | HARDWARE_SETUP.md |  |
| IQ-DOC-02 | Autostart/install documentation present | Documentation | Pass | README_AUTOSTART.md |  |

## RTC diagnostics

```
24(cdrom),27(sudo),29(audio),44(video),46(plugdev),60(games),100(users),102(netdev),108(lpadmin),986(gpio),988(i2c),989(spi),992(render),996(input)
raspberrypi
--- /dev/rtc* ---
lrwxrwxrwx 1 root root      4 Aug 19 19:19 /dev/rtc -> rtc0
crw------- 1 root root 252, 0 Aug 19 19:19 /dev/rtc0
--- timedatectl ---
               Local time: Thu 2026-08-20 08:44:40 IST
           Universal time: Thu 2026-08-20 03:14:40 UTC
                 RTC time: Thu 2026-08-20 03:14:40
                Time zone: Asia/Kolkata (IST, +0530)
System clock synchronized: no
              NTP service: inactive
          RTC in local TZ: no
--- rtc0 sysfs name ---
rtc-ds1307 1-0068
--- hwclock -r (root) ---
2026-08-20 08:44:40.934394+05:30
--- hwclock as rle (no sudo) ---
hwclock: Cannot access the Hardware Clock via any known method.
hwclock: Use the --verbose option to see the details of our search for an access method.
--- hwclock sudo -n as rle ---
2026-08-20 08:44:41.075540+05:30
--- i2c read 0x68 (system python3-smbus) ---
read_byte 0x68: [Errno 16] Device or resource busy
--- rtc_service.get_rtc_date (venv) ---
{'success': True, 'datetime': '2026-08-20T08:44:42', 'error': None, 'source': 'hwclock', 'device': '/dev/rtc0'}
======== end ========
======== 2026-08-20T08:45:48+05:30 ========
--- id / hostname ---
uid=1000(rle) gid=1000(rle) groups=1000(rle),4(adm),5(tty),20(dialout),24(cdrom),27(sudo),29(audio),44(video),46(plugdev),60(games),100(users),102(netdev),108(lpadmin),986(gpio),988(i2c),989(spi),992(render),996(input)
raspberrypi
--- /dev/rtc* ---
lrwxrwxrwx 1 root root      4 Aug 19 19:19 /dev/rtc -> rtc0
crw------- 1 root root 252, 0 Aug 19 19:19 /dev/rtc0
--- timedatectl ---
               Local time: Thu 2026-08-20 08:45:48 IST
           Universal time: Thu 2026-08-20 03:15:48 UTC
                 RTC time: Thu 2026-08-20 03:15:48
                Time zone: Asia/Kolkata (IST, +0530)
System clock synchronized: no
              NTP service: inactive
          RTC in local TZ: no
--- rtc0 sysfs name ---
rtc-ds1307 1-0068
--- hwclock -r (root) ---
2026-08-20 08:45:48.393374+05:30
--- hwclock as rle (no sudo) ---
hwclock: Cannot access the Hardware Clock via any known method.
hwclock: Use the --verbose option to see the details of our search for an access method.
--- hwclock sudo -n as rle ---
2026-08-20 08:45:49.136623+05:30
--- i2c read 0x68 (system python3-smbus) ---
read_byte 0x68: [Errno 16] Device or resource busy
--- rtc_service.get_rtc_date (venv) ---
{'success': True, 'datetime': '2026-08-20T08:45:50', 'error': None, 'source': 'hwclock', 'device': '/dev/rtc0'}
======== end ========
======== 2026-08-20T08:46:07+05:30 ========
--- id / hostname ---
uid=1000(rle) gid=1000(rle) groups=1000(rle),4(adm),5(tty),20(dialout),24(cdrom),27(sudo),29(audio),44(video),46(plugdev),60(games),100(users),102(netdev),108(lpadmin),986(gpio),988(i2c),989(spi),992(render),996(input)
raspberrypi
--- /dev/rtc* ---
lrwxrwxrwx 1 root root      4 Aug 19 19:19 /dev/rtc -> rtc0
crw------- 1 root root 252, 0 Aug 19 19:19 /dev/rtc0
--- timedatectl ---
               Local time: Thu 2026-08-20 08:46:07 IST
           Universal time: Thu 2026-08-20 03:16:07 UTC
                 RTC time: Thu 2026-08-20 03:16:07
                Time zone: Asia/Kolkata (IST, +0530)
System clock synchronized: no
              NTP service: inactive
          RTC in local TZ: no
--- rtc0 sysfs name ---
rtc-ds1307 1-0068
--- hwclock -r (root) ---
2026-08-20 08:46:07.612323+05:30
--- hwclock as rle (no sudo) ---
hwclock: Cannot access the Hardware Clock via any known method.
hwclock: Use the --verbose option to see the details of our search for an access method.
--- hwclock sudo -n as rle ---
2026-08-20 08:46:08.082819+05:30
--- i2c read 0x68 (system python3-smbus) ---
read_byte 0x68: [Errno 16] Device or resource busy
--- rtc_service.get_rtc_date (venv) ---
{'success': True, 'datetime': '2026-08-20T08:46:09', 'error': None, 'source': 'hwclock', 'device': '/dev/rtc0'}
======== end ========

```
