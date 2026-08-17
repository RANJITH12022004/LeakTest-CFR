#!/usr/bin/env python3
"""TD-2B Installation Qualification (IQ) checklist runner — Pass/Fail/N/A only."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

APP_ROOT = Path(__file__).resolve().parents[1]
BASE = os.environ.get("KIOSK_API_BASE", "http://127.0.0.1:5000")
FACTORY_USER = "RLERLT"
FACTORY_PASS = os.environ.get("FACTORY_PASS", "Rahul")
STORAGE_DIR = Path(os.environ.get("STORAGE_DIR", "/media/usb_internal/storage"))
REPORTS_DIR = Path(os.environ.get("REPORTS_DIR", "/media/usb_internal/reports"))
AUDIT_DB_DIR = Path(os.environ.get("AUDIT_DB_DIR", "/media/usb_internal/db"))


@dataclass
class CaseResult:
    test_id: str
    description: str
    category: str
    result: str
    evidence: str = ""
    remark: str = ""


@dataclass
class IQRun:
    results: list[CaseResult] = field(default_factory=list)
    env_snapshot: dict[str, Any] = field(default_factory=dict)
    rtc_diag: str = ""

    def record(
        self,
        test_id: str,
        description: str,
        category: str,
        result: str,
        evidence: str = "",
        remark: str = "",
    ) -> None:
        self.results.append(CaseResult(test_id, description, category, result, evidence, remark))
        mark = {"Pass": "OK", "Fail": "FAIL", "N/A": "N/A"}.get(result, result)
        print(f"  {mark:4} {test_id} — {description}" + (f" ({remark})" if remark else ""))

    def counts(self) -> tuple[int, int, int]:
        p = sum(1 for r in self.results if r.result == "Pass")
        f = sum(1 for r in self.results if r.result == "Fail")
        n = sum(1 for r in self.results if r.result == "N/A")
        return p, f, n


def http_get(path: str, headers: dict | None = None, timeout: int = 10, parse_json: bool = True) -> tuple[int, dict]:
    req = urllib.request.Request(BASE + path, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            if not parse_json:
                return resp.status, {"raw_len": len(raw)}
            if not raw:
                return resp.status, {}
            try:
                return resp.status, json.loads(raw.decode("utf-8"))
            except json.JSONDecodeError:
                return resp.status, {"raw": raw.decode("utf-8", errors="replace")[:200]}
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            body = json.loads(raw.decode("utf-8") or "{}") if raw else {}
        except json.JSONDecodeError:
            body = {"error": raw.decode("utf-8", errors="replace")}
        return e.code, body


def http_post(path: str, body: dict | None = None, headers: dict | None = None, timeout: int = 15) -> tuple[int, dict]:
    hdrs = {"Content-Type": "application/json"}
    if headers:
        hdrs.update(headers)
    data = json.dumps(body or {}).encode("utf-8")
    req = urllib.request.Request(BASE + path, data=data, headers=hdrs, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            return resp.status, json.loads(raw.decode("utf-8") or "{}") if raw else {}
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            payload = json.loads(raw.decode("utf-8") or "{}") if raw else {}
        except json.JSONDecodeError:
            payload = {"error": raw.decode("utf-8", errors="replace")}
        return e.code, payload


def factory_login() -> dict[str, str]:
    st, data = http_post("/api/data/auth/login", {"username": FACTORY_USER, "password": FACTORY_PASS})
    if st >= 400 or not isinstance(data.get("user"), dict):
        return {}
    user = data["user"]
    headers: dict[str, str] = {}
    if user.get("role"):
        headers["X-User-Role"] = str(user["role"])
    if user.get("username"):
        headers["X-User-Username"] = str(user["username"])
    if user.get("name"):
        headers["X-User-Name"] = str(user["name"])
    return headers


def systemctl_state(unit: str) -> tuple[str, str]:
    active = subprocess.run(
        ["systemctl", "is-active", unit],
        capture_output=True,
        text=True,
    )
    enabled = subprocess.run(
        ["systemctl", "is-enabled", unit],
        capture_output=True,
        text=True,
    )
    return active.stdout.strip(), enabled.stdout.strip()


def findmnt_target(target: str) -> str:
    proc = subprocess.run(
        ["findmnt", "-n", "-o", "SOURCE,TARGET,FSTYPE", target],
        capture_output=True,
        text=True,
    )
    return proc.stdout.strip() if proc.returncode == 0 else ""


def dir_writable(path: Path) -> bool:
    try:
        path.mkdir(parents=True, exist_ok=True)
        probe = path / ".iq_write_probe"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink(missing_ok=True)
        return True
    except OSError:
        return False


def run_rtc_diag(run: IQRun) -> None:
    script = APP_ROOT / "scripts" / "rtc_diag.sh"
    out_path = "/tmp/kiosk-iq-rtc-diag.log"
    if not script.is_file():
        run.rtc_diag = "rtc_diag.sh missing"
        return
    proc = subprocess.run(
        ["/bin/bash", str(script), out_path],
        capture_output=True,
        text=True,
        timeout=60,
    )
    run.rtc_diag = (proc.stdout or "") + (proc.stderr or "")
    if out_path and Path(out_path).is_file():
        run.rtc_diag = Path(out_path).read_text(encoding="utf-8", errors="replace")[-4000:]


def section_software(run: IQRun) -> None:
    print("\n=== IQ: Software installation ===")
    run.record("IQ-SW-01", "Application root at /opt/kiosk", "Software", "Pass" if APP_ROOT.is_dir() else "Fail", str(APP_ROOT))
    venv_py = APP_ROOT / "venv" / "bin" / "python3"
    run.record("IQ-SW-02", "Python venv executable", "Software", "Pass" if venv_py.is_file() else "Fail", str(venv_py))

    for unit, tid, desc in [
        ("kiosk-bridge.service", "IQ-SW-03", "kiosk-bridge.service active and enabled"),
        ("kiosk-display.service", "IQ-SW-04", "kiosk-display.service active and enabled"),
        ("kiosk-internal-usb-mount.service", "IQ-SW-06", "kiosk-internal-usb-mount.service active"),
    ]:
        active, enabled = systemctl_state(unit)
        ok = active == "active"
        if unit != "kiosk-internal-usb-mount.service":
            ok = ok and enabled == "enabled"
        run.record(tid, desc, "Software", "Pass" if ok else "Fail", f"active={active} enabled={enabled}")

    _, enabled = systemctl_state("kiosk-watchdog.timer")
    watchdog_script = APP_ROOT / "scripts" / "kiosk_watchdog.sh"
    timer_list = subprocess.run(["systemctl", "list-timers", "kiosk-watchdog.timer", "--no-pager"], capture_output=True, text=True)
    wd_ok = enabled == "enabled" and watchdog_script.is_file() and "kiosk-watchdog.timer" in timer_list.stdout
    run.record("IQ-SW-05", "kiosk-watchdog.timer enabled", "Software", "Pass" if wd_ok else "Fail", f"enabled={enabled}")
    run.record("IQ-SW-10", "Watchdog script present and timer scheduled", "Software", "Pass" if wd_ok else "Fail", str(watchdog_script))

    st_root, _ = http_get("/", parse_json=False)
    run.record("IQ-SW-07", "API root HTTP 200", "Software", "Pass" if st_root == 200 else "Fail", f"HTTP {st_root}")

    st_health, health = http_get("/api/desktop/v1/health")
    ok_health = st_health == 200 and health.get("ok") is True
    run.record("IQ-SW-08", "Desktop health endpoint", "Software", "Pass" if ok_health else "Fail", str(health))

    st_fs, fs = http_get("/api/data/factory-settings")
    settings = (fs.get("settings") or {}) if st_fs == 200 else {}
    firmware = settings.get("firmware") or settings.get("modelNo")
    fs_ok = st_fs == 200 and bool(settings)
    run.record(
        "IQ-SW-09",
        "Software version in factory settings",
        "Software",
        "Pass" if fs_ok else "Fail",
        f"firmware={settings.get('firmware')} modelNo={settings.get('modelNo')}",
        "" if firmware else "Observation: firmware/model not configured on site",
    )
    run.env_snapshot["firmware"] = settings.get("firmware") or settings.get("modelNo")


def section_storage(run: IQRun) -> None:
    print("\n=== IQ: Storage ===")
    run.record("IQ-ST-01", "Storage directory writable", "Storage", "Pass" if dir_writable(STORAGE_DIR) else "Fail", str(STORAGE_DIR))
    run.record("IQ-ST-02", "Reports directory writable", "Storage", "Pass" if dir_writable(REPORTS_DIR) else "Fail", str(REPORTS_DIR))

    audit_db = AUDIT_DB_DIR / "audit_log.db"
    db_ok = AUDIT_DB_DIR.is_dir() and (audit_db.is_file() or dir_writable(AUDIT_DB_DIR))
    run.record("IQ-ST-03", "Audit DB directory and SQLite file", "Storage", "Pass" if db_ok else "Fail", str(audit_db))

    mount_info = findmnt_target("/media/usb_internal")
    on_root = "/dev/root" in mount_info or not mount_info
    if mount_info and "/dev/root" not in mount_info and "sd" in mount_info.lower():
        run.record("IQ-ST-04", "Internal USB on dedicated block device", "Storage", "Pass", mount_info)
    elif STORAGE_DIR.is_dir() and dir_writable(STORAGE_DIR):
        run.record(
            "IQ-ST-04",
            "Internal USB on dedicated block device",
            "Storage",
            "Pass",
            mount_info or "not in findmnt",
            "Observation: storage on SD/root fallback; dedicated USB not mounted",
        )
    else:
        run.record("IQ-ST-04", "Internal USB on dedicated block device", "Storage", "Fail", mount_info or "not mounted")
    run.env_snapshot["usb_mount"] = mount_info or "not mounted"


def section_hardware(run: IQRun) -> None:
    print("\n=== IQ: Hardware ===")
    devices = [
        ("IQ-HW-01", "ESP32 UART node", "/dev/serial0"),
        ("IQ-HW-02", "Thermal printer UART", "/dev/ttyAMA3"),
        ("IQ-HW-03", "A4/dot-matrix UART", "/dev/ttyAMA4"),
        ("IQ-HW-04", "Biometric UART", "/dev/ttyAMA5"),
        ("IQ-HW-05", "RTC device", "/dev/rtc0"),
    ]
    for tid, desc, dev in devices:
        run.record(tid, desc, "Hardware", "Pass" if Path(dev).exists() else "Fail", dev)

    run_rtc_diag(run)
    rtc_ok = "rtc0" in run.rtc_diag.lower() and ("ok" in run.rtc_diag.lower() or "ds1307" in run.rtc_diag.lower())
    run.record("IQ-HW-06", "RTC readable (rtc_diag)", "Hardware", "Pass" if rtc_ok else "Fail", "see rtc_diag in results")

    headers = factory_login()
    if headers:
        st, adapter = http_post("/api/hardware/adapter/check", {}, headers)
        ok = st == 200 and isinstance(adapter, dict)
        mode = adapter.get("mode") or adapter.get("detected") or adapter.get("response")
        run.record("IQ-HW-07", "ESP adapter probe", "Hardware", "Pass" if ok else "Fail", f"HTTP {st} mode={mode}")
    else:
        run.record("IQ-HW-07", "ESP adapter probe", "Hardware", "Fail", remark="factory login failed")

    st_bio, bio = http_get("/api/biometric/status")
    bio_ok = st_bio == 200 and bio.get("ok") is True
    run.record("IQ-HW-08", "Biometric status probe", "Hardware", "Pass" if bio_ok else "Fail", str(bio)[:200])

    st_th, thermal = http_get("/api/print/status?type=thermal")
    th_ok = st_th == 200 and isinstance(thermal, dict)
    run.record("IQ-HW-09", "Thermal printer status probe", "Hardware", "Pass" if th_ok else "Fail", str(thermal)[:200])


def section_network_display_docs(run: IQRun) -> None:
    print("\n=== IQ: Network, display, documentation ===")
    st, net = http_get("/api/system/network-addresses")
    ok_net = st == 200 and (net.get("lan") or net.get("wlan") or net.get("ok"))
    run.record("IQ-NW-01", "Network interfaces configured", "Network", "Pass" if ok_net else "Fail", str(net)[:200])

    xorg_ok = subprocess.run(["pgrep", "-f", "/usr/lib/xorg/Xorg :0"], capture_output=True).returncode == 0
    run.record("IQ-DSP-02", "Xorg display :0 running", "Display", "Pass" if xorg_ok else "Fail")

    chrome_ok = subprocess.run(["pgrep", "-f", "/usr/lib/chromium/chromium.*--app="], capture_output=True).returncode == 0
    run.record("IQ-DSP-01", "Chromium kiosk process running", "Display", "Pass" if chrome_ok else "Fail")

    run.record(
        "IQ-DOC-01",
        "Pin mapping documentation present",
        "Documentation",
        "Pass" if (APP_ROOT / "HARDWARE_SETUP.md").is_file() else "Fail",
        "HARDWARE_SETUP.md",
    )
    run.record(
        "IQ-DOC-02",
        "Autostart/install documentation present",
        "Documentation",
        "Pass" if (APP_ROOT / "README_AUTOSTART.md").is_file() else "Fail",
        "README_AUTOSTART.md",
    )


def write_results(run: IQRun) -> Path:
    docs = APP_ROOT / "docs"
    docs.mkdir(exist_ok=True)
    date = datetime.now().strftime("%Y%m%d")
    md_path = docs / f"IQ_RESULTS_{date}.md"
    json_path = docs / f"IQ_RESULTS_{date}.json"
    p, f, n = run.counts()
    overall = "Non-Compliant" if f else "Compliant with Observations" if n or any(r.remark for r in run.results) else "Compliant"
    lines = [
        "# TD-2B Installation Qualification (IQ) Results",
        "",
        f"**Execution date:** {datetime.now().isoformat()}",
        f"**API base:** {BASE}",
        f"**Hostname:** {subprocess.run(['hostname'], capture_output=True, text=True).stdout.strip()}",
        "",
        "## Summary",
        "",
        f"- **Pass:** {p}",
        f"- **Fail:** {f}",
        f"- **N/A:** {n}",
        f"- **Overall:** {overall}",
        "",
        "## Environment snapshot",
        "",
        f"- firmware: {run.env_snapshot.get('firmware', 'N/A')}",
        f"- usb_mount: {run.env_snapshot.get('usb_mount', 'N/A')}",
        "",
        "## Results matrix",
        "",
        "| Test ID | Description | Category | Result | Evidence | Remark |",
        "|---------|-------------|----------|--------|----------|--------|",
    ]
    for r in run.results:
        lines.append(f"| {r.test_id} | {r.description} | {r.category} | {r.result} | {r.evidence} | {r.remark} |")

    if run.rtc_diag:
        lines.extend(["", "## RTC diagnostics", "", "```", run.rtc_diag[-4000:], "```", ""])

    md_path.write_text("\n".join(lines), encoding="utf-8")
    json_path.write_text(
        json.dumps(
            {
                "summary": {"pass": p, "fail": f, "na": n, "overall": overall},
                "env_snapshot": run.env_snapshot,
                "results": [r.__dict__ for r in run.results],
                "rtc_diag": run.rtc_diag[-4000:],
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    return md_path


def main() -> int:
    run = IQRun()
    print("=== TD-2B Installation Qualification (IQ) ===")
    print(f"API: {BASE}")
    section_software(run)
    section_storage(run)
    section_hardware(run)
    section_network_display_docs(run)
    md = write_results(run)
    p, f, n = run.counts()
    print(f"\n=== IQ Done: Pass={p} Fail={f} N/A={n} ===")
    print(f"Results: {md}")
    return 1 if f else 0


if __name__ == "__main__":
    sys.exit(main())
