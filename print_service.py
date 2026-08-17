#!/usr/bin/env python3
"""
print_service.py - Printing operations service
Reference-aligned A4 and thermal printing over serial.
"""

import logging
import os
import pathlib
import time
from datetime import datetime
from typing import Any, Dict, Optional

try:
    import serial
except ImportError:
    serial = None

try:
    import bridge_services
except ImportError:
    bridge_services = None

try:
    from report_service import (
        build_test_report_derived,
        format_duration_hhmmss,
        test_duration_seconds,
        _format_derived_number,
    )
except ImportError:
    def build_test_report_derived(td, recipe=None, report_id=None):
        return {}

    def _format_derived_number(val, decimals=3):
        return "--" if val is None else str(val)
    def format_duration_hhmmss(seconds_val):
        if seconds_val is None:
            return "--"
        try:
            total_s = int(seconds_val)
        except (TypeError, ValueError):
            return "--"
        if total_s < 0:
            return "--"
        h, rem = divmod(total_s, 3600)
        m, s = divmod(rem, 60)
        return f"{h:02d}:{m:02d}:{s:02d}"

    def test_duration_seconds(td):
        if not isinstance(td, dict):
            return None
        sec = td.get("durationSeconds")
        if sec is not None:
            try:
                return max(0, int(sec))
            except (TypeError, ValueError):
                pass
        return None

A4_CANDIDATES = ["/dev/ttyAMA4", "/dev/ttyUSB0", "/dev/ttyUSB1", "COM3", "COM4"]
THERMAL_CANDIDATES = ["/dev/ttyAMA3", "/dev/ttyUSB0", "/dev/ttyUSB1", "COM3", "COM4"]
THERMAL_WIDTH = 32
THERMAL_LINE_CHUNK = 32
A4_TEXT_WIDTH = 80
# Blank lines after content so date/time and footer clear the cutter (avoid half-cut).
THERMAL_POST_PRINT_FEED_LINES = 10

_PRINTER_INIT_SEQ = b"\x1b\x40"
_log = logging.getLogger(__name__)

_config = {}
_a4_port = None
_a4_baud = None
_thermal_port = None
_thermal_baud = None


def init(config):
    global _config, _a4_port, _a4_baud, _thermal_port, _thermal_baud
    _config = dict(config)
    _a4_port = _config.get("A4_PORT", "/dev/ttyAMA4")
    _a4_baud = int(_config.get("A4_BAUD", 9600))
    _thermal_port = _config.get("THERMAL_PORT", "/dev/ttyAMA3")
    _thermal_baud = int(_config.get("THERMAL_BAUD", 9600))


def _is_windows_com_port(port: str) -> bool:
    return bool(port and str(port).strip().upper().startswith("COM"))


def _port_exists(port: str) -> bool:
    if not port:
        return False
    if _is_windows_com_port(port):
        return True
    return os.path.exists(port)


def _probe_port(port: str, candidates: list) -> str:
    cands = ([port] if port else []) + [c for c in candidates if c and c != port]
    if bridge_services:
        return bridge_services.probe_and_choose_port(port, candidates=cands)
    if port and _port_exists(port):
        return port
    for p in candidates:
        if p and _port_exists(p):
            return p
    raise FileNotFoundError(2, "Serial device not found", port or "no-config")


def check_printer_status(printer_type: str = "a4") -> Dict[str, Any]:
    port = _a4_port if printer_type == "a4" else _thermal_port
    baud = _a4_baud if printer_type == "a4" else _thermal_baud
    if not serial:
        return {"available": False, "error": "pyserial not installed", "port": port}
    if not _port_exists(port):
        return {"available": False, "error": f"Printer port not found: {port}", "port": port}
    try:
        ser = serial.Serial(port=port, baudrate=baud, timeout=1.0)
        ser.close()
        return {"available": True, "port": port, "baud": baud}
    except Exception as e:
        return {"available": False, "error": str(e), "port": port}


def _open_a4_serial(port: str, baud: int):
    params = dict(
        port=port,
        baudrate=baud,
        bytesize=serial.EIGHTBITS,
        parity=serial.PARITY_NONE,
        stopbits=serial.STOPBITS_ONE,
        timeout=2,
        write_timeout=2,
    )
    try:
        return serial.Serial(**params)
    except Exception:
        time.sleep(0.5)
        return serial.Serial(**params)


def _send_printer_init(ser) -> None:
    ser.write(_PRINTER_INIT_SEQ)
    ser.flush()
    time.sleep(0.05)


def _send_bytes_chunked(ser, data: bytes, baud: int, chunk_size: int = 64) -> None:
    delay = 0.08 if baud <= 9600 else 0.04
    for i in range(0, len(data), chunk_size):
        ser.write(data[i : i + chunk_size])
        ser.flush()
        if i + chunk_size < len(data):
            time.sleep(delay)
    time.sleep(0.1)


def _send_text_chunked(ser, text: str, baud: int, chunk_size: int = 64) -> None:
    try:
        data = text.encode("utf-8", errors="replace")
    except Exception:
        data = text.encode("latin-1", errors="replace")
    _send_bytes_chunked(ser, data, baud, chunk_size=chunk_size)


def _thermal_sep(char: str, width: int = THERMAL_WIDTH) -> str:
    return (char * width)[:width]


def _fit_thermal_line(line: str, width: int = THERMAL_WIDTH) -> list:
    """Split or truncate a single logical line to at most `width` characters per row."""
    s = str(line) if line is not None else ""
    if not s.strip() and s == "":
        return [""]
    if len(s) <= width:
        return [s]
    out = []
    while s:
        out.append(s[:width])
        s = s[width:]
    return out


def _apply_thermal_line_spacing(lines: list, width: int = THERMAL_WIDTH) -> list:
    """Extra blank line after each printed row for readable line spacing."""
    out: list = []
    for line in lines:
        for part in _fit_thermal_line(line, width):
            out.append(part)
            if part.strip():
                out.append("")
    return out


def _compact_thermal_lines(lines: list, width: int = THERMAL_WIDTH) -> list:
    """Fit thermal lines without adding filler space between every row."""
    out: list = []
    previous_blank = False
    for line in lines:
        parts = _fit_thermal_line(line, width)
        for part in parts:
            is_blank = not str(part or "").strip()
            if is_blank and previous_blank:
                continue
            out.append(part)
            previous_blank = is_blank
    while out and not str(out[-1] or "").strip():
        out.pop()
    return out


def _send_text_to_thermal(ser, text: str, baud: int) -> None:
    """
    Send thermal text one line at a time (max THERMAL_WIDTH chars per row).
    Avoids buffer overrun that drops the start of long chunked writes.
    """
    line_delay = 0.06 if baud <= 9600 else 0.035
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    for line in text.split("\n"):
        if line == "":
            ser.write(b"\n")
            ser.flush()
            time.sleep(0.02)
            continue
        for chunk in _fit_thermal_line(line, THERMAL_LINE_CHUNK):
            payload = (chunk + "\n").encode("latin-1", errors="replace")
            ser.write(payload)
            ser.flush()
            time.sleep(line_delay)
    for _ in range(THERMAL_POST_PRINT_FEED_LINES):
        ser.write(b"\n")
        ser.flush()
        time.sleep(0.06)
    time.sleep(0.5)


def _send_text_to_a4(ser, text: str, baud: int) -> int:
    text = text.replace("\r\n", "\n").replace("\n", "\r\n")
    data = text.encode("utf-8", errors="replace")
    _send_bytes_chunked(ser, data, baud, chunk_size=512)
    return len(data)


def _format_ts_readable(ts: Any) -> str:
    if ts is None:
        return "--"
    if isinstance(ts, datetime):
        dt = ts.astimezone() if ts.tzinfo is not None else ts
        return dt.strftime("%d/%m/%Y %H:%M:%S")
    s = str(ts).strip()
    if not s:
        return "--"
    try:
        s = s[:-1] + "+00:00" if s[-1:] in ("Z", "z") else s.replace("Z", "+00:00")
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is not None:
            dt = dt.astimezone()
        return dt.strftime("%d/%m/%Y %H:%M:%S")
    except Exception:
        return str(ts)


def _split_ts_date_and_time(ts: Any) -> tuple:
    """Return (date, time) strings for separate thermal print lines."""
    full = _format_ts_readable(ts)
    if full == "--":
        return "--", "--"
    parts = full.split(" ", 1)
    if len(parts) == 2:
        return parts[0], parts[1]
    return full, "--"


def _wrap_lines(lines: list, width: int) -> list:
    out = []
    for line in lines:
        if "\t" in line:
            out.append(line)
            continue
        if len(line) <= width:
            out.append(line)
            continue
        words = line.split()
        if not words:
            out.append("")
            continue
        cur = ""
        for w in words:
            nxt = w if not cur else (cur + " " + w)
            if len(nxt) <= width:
                cur = nxt
            else:
                if cur:
                    out.append(cur)
                cur = w
        if cur:
            out.append(cur)
    return out


def _truncate_with_ellipsis(value: Any, max_len: int) -> str:
    s = "" if value is None else str(value)
    if max_len <= 0:
        return ""
    if len(s) <= max_len:
        return s
    if max_len <= 3:
        return "." * max_len
    return s[: max_len - 3] + "..."


def _append_two_column_pairs(lines: list, pairs: list, width: int) -> None:
    """Append key/value pairs as two aligned columns for A4 text output."""
    if width < 40:
        for label, value in pairs:
            lines.append(f"{label}: {value}")
        return
    gap = 4
    col_w = max(18, (width - gap) // 2)
    value_w = max(8, col_w - 2)

    def _cell(label: Any, value: Any) -> str:
        lbl = _truncate_with_ellipsis(label, 22)
        val = _truncate_with_ellipsis(value, value_w)
        text = f"{lbl}: {val}".strip()
        return text.ljust(col_w)[:col_w]

    normalized = [(str(k or "--"), str(v if v not in (None, "") else "--")) for k, v in pairs]
    for i in range(0, len(normalized), 2):
        left = _cell(normalized[i][0], normalized[i][1])
        right = ""
        if i + 1 < len(normalized):
            right = _cell(normalized[i + 1][0], normalized[i + 1][1])
        lines.append(left + (" " * gap) + right)



def _fmt_density_val(val: Any) -> str:
    if val is None or val == "":
        return "--"
    try:
        f = float(val)
        return f"{f:.3f}".rstrip("0").rstrip(".") if f != int(f) else str(int(f))
    except (TypeError, ValueError):
        return str(val)


def _cell_str(val: Any) -> str:
    if val is None or val in ("", "__"):
        return "--"
    return str(val)


def _effective_step_row_count(td: Dict[str, Any]) -> int:
    """Rows to print: actual stepResults only (not recipe stepCount)."""
    if not isinstance(td, dict):
        return 0
    results = td.get("stepResults") or []
    if isinstance(results, list) and results:
        return len(results)
    cs = td.get("completedSteps")
    if cs is not None:
        try:
            return max(0, int(cs))
        except (TypeError, ValueError):
            pass
    return 0


def _section_sep(char: str, width: int, thermal: bool) -> str:
    if thermal:
        return _thermal_sep(char, width)
    return char * width


def _thermal_test_data_row(sn: int, cnt: str, vol: str, dvol: str, bulk: str, tap: str) -> str:
    """Thermal step row with per-step hold time."""
    return f"{sn:>2} {str(cnt):>4} {str(vol):>5} {str(dvol):>4} {str(bulk):>4} {str(tap):>4}"


_THERMAL_TEST_DATA_HEADER = f"{'#':>2} {'Cnt':>4} {'Vol':>5} {'dV':>4} {'Blk':>4} {'Tap':>4}"


def _format_thermal_test_data_table(
    row_count: int, results: list, steps: Optional[list] = None, width: int = THERMAL_WIDTH
) -> list:
    """Compact fixed-width step table for 32-char thermal paper."""
    w = width
    lines = [
        "",
        _section_sep("=", w, True),
        "TEST DATA",
        _section_sep("-", w, True),
        _THERMAL_TEST_DATA_HEADER,
        _section_sep("-", w, True),
    ]
    steps = steps if isinstance(steps, list) else []
    for i in range(row_count):
        r = results[i] if i < len(results) and isinstance(results[i], dict) else {}
        cnt = "--"
        if i < len(steps) and isinstance(steps[i], dict):
            cnt = _cell_str(steps[i].get("tapCount"))
        vol = _cell_str(r.get("volumeMl"))
        dvol = r.get("volumeDeltaMl", "__")
        if dvol not in (None, "", "__"):
            dvol = _fmt_density_val(dvol)
        else:
            dvol = _cell_str(dvol)
        bulk = r.get("bulkDensity", "__")
        if bulk not in (None, "", "__"):
            bulk = _fmt_density_val(bulk)
        else:
            bulk = _cell_str(bulk)
        tap = r.get("tapDensity", "__")
        if tap not in (None, "", "__"):
            tap = _fmt_density_val(tap)
        else:
            tap = _cell_str(tap)
        lines.append(_thermal_test_data_row(i + 1, cnt, vol, dvol, bulk, tap))
    lines.extend(["", _section_sep("-", w, True), ""])
    return lines


def _stat_display_value(val: dict) -> Any:
    """Single statistic value for print (value field, else mean)."""
    if val.get("value") is not None:
        return val.get("value")
    if val.get("mean") is not None:
        return val.get("mean")
    if val.get("Mean") is not None:
        return val.get("Mean")
    return None


def _recipe_total_tap_count(recipe: Dict[str, Any]) -> Optional[int]:
    if not isinstance(recipe, dict):
        return None
    ct = recipe.get("customTotalTaps")
    if ct is not None and ct != "":
        try:
            n = int(ct)
            if n > 0:
                return n
        except (TypeError, ValueError):
            pass
    steps = recipe.get("steps")
    if not isinstance(steps, list) or not steps:
        return None
    total = 0
    for step in steps:
        if not isinstance(step, dict):
            continue
        try:
            total += int(step.get("tapCount") or 0)
        except (TypeError, ValueError):
            pass
    return total if total > 0 else None


def _append_derived_test_summary_and_result(
    lines: list, derived: Dict[str, Any], width: int, thermal: bool
) -> None:
    if not isinstance(derived, dict) or not derived:
        return
    eq = _section_sep("=", width, thermal)
    dash = _section_sep("-", width, thermal)
    total_taps = derived.get("totalTaps")
    total_taps_str = str(total_taps) if total_taps is not None else "--"
    if thermal:
        lines.extend(
            [
                "",
                eq,
                "TEST SUMMARY",
                dash,
                f"Sample Weight (g): {_format_derived_number(derived.get('sampleWeightG'), 2)}",
                f"Total No. of Drops: {total_taps_str}",
                f"Target Vacuum V0 (ml): {_format_derived_number(derived.get('initialVolumeMl'), 4)}",
                f"Diff Last Two Vol (ml): {_format_derived_number(derived.get('diffLastTwoVolumesMl'), 4)}",
                "",
                eq,
                "TEST RESULT",
                dash,
                f"Final Volume Vf (ml): {_format_derived_number(derived.get('finalVolumeMl'), 4)}",
                f"Initial Density W/V0: {_format_derived_number(derived.get('initialDensityGPerMl'), 3)} g/mL",
                f"Tapped Density W/Vf: {_format_derived_number(derived.get('tappedDensityGPerMl'), 3)} g/mL",
                f"Compressibility Index: {_format_derived_number(derived.get('compressibilityIndexPct'), 2)} %",
                f"Hausner Ratio V0/Vf: {_format_derived_number(derived.get('hausnerRatio'), 3)}",
                "",
            ]
        )
        return

    lines.extend(["", eq, "TEST SUMMARY", dash])
    _append_two_column_pairs(
        lines,
        [
            ("Sample Weight (g)", _format_derived_number(derived.get("sampleWeightG"), 2)),
            ("Total No. of Drops", total_taps_str),
            ("Target Vacuum V0 (ml)", _format_derived_number(derived.get("initialVolumeMl"), 4)),
            ("Diff Last Two Vol (ml)", _format_derived_number(derived.get("diffLastTwoVolumesMl"), 4)),
        ],
        width,
    )
    lines.extend(["", eq, "TEST RESULT", dash])
    _append_two_column_pairs(
        lines,
        [
            ("Final Volume Vf (ml)", _format_derived_number(derived.get("finalVolumeMl"), 4)),
            ("Initial Density W/V0", f"{_format_derived_number(derived.get('initialDensityGPerMl'), 3)} g/mL"),
            ("Tapped Density W/Vf", f"{_format_derived_number(derived.get('tappedDensityGPerMl'), 3)} g/mL"),
            ("Compressibility Index", f"{_format_derived_number(derived.get('compressibilityIndexPct'), 2)} %"),
            ("Hausner Ratio V0/Vf", _format_derived_number(derived.get("hausnerRatio"), 3)),
        ],
        width,
    )
    lines.append("")


def _append_test_statistics_block(
    lines: list, stats: dict, width: int, thermal: bool, status_raw: str
) -> None:
    if str(status_raw or "").strip().lower() == "aborted":
        lines.extend(["", _section_sep("=", width, thermal), "STATISTICS", "N/A", _section_sep("*", width, thermal), ""])
        return
    if not isinstance(stats, dict) or not stats:
        return
    dash = _section_sep("-", width, thermal)
    eq = _section_sep("=", width, thermal)
    star = _section_sep("*", width, thermal)
    lines.extend(["", eq, "STATISTICS", dash])
    a4_pairs = []
    for key, val in stats.items():
        if not isinstance(val, dict):
            continue
        label = str(key)
        display = _stat_display_value(val)
        if display is None:
            continue
        if thermal:
            lines.append(f"{label}: {_fmt_density_val(display)}")
        else:
            a4_pairs.append((label, _fmt_density_val(display)))
    if not thermal and a4_pairs:
        _append_two_column_pairs(lines, a4_pairs, width)
    lines.extend(["", star, ""])


def _normalize_validation_runs(td: Dict[str, Any], report_data: Dict[str, Any]) -> list:
    if not isinstance(td, dict):
        td = {}
    runs = td.get("validationRuns") or report_data.get("validationRuns")
    if runs and isinstance(runs, list) and len(runs) > 0:
        return [r if isinstance(r, dict) else {} for r in runs]
    return [
        {
            "usp": td.get("usp") or report_data.get("usp"),
            "validationSubtype": td.get("validationSubtype") or report_data.get("validationSubtype"),
            "tapsMin": td.get("tapsMin", report_data.get("tapsMin")),
            "dropHeight": td.get("dropHeight", report_data.get("dropHeight")),
            "expectedTapCount": td.get("expectedTapCount", report_data.get("expectedTapCount")),
            "expectedTolerance": td.get("expectedTolerance", report_data.get("expectedTolerance")),
            "actualTapCount": td.get("actualTapCount", report_data.get("actualTapCount")),
            "validationDurationSec": td.get("validationDurationSec", report_data.get("validationDurationSec")),
            "status": td.get("status", report_data.get("status")),
            "completedAt": td.get("completedAt", report_data.get("completedAt")),
        }
    ]


def _validation_usp_label(run: Dict[str, Any]) -> str:
    usp = run.get("usp")
    if usp:
        return str(usp)
    return "Pressure Decay" if run.get("validationSubtype") == "load" else "Vacuum Decay"


def _validation_expected_display(run: Dict[str, Any]) -> str:
    expected = run.get("expectedTapCount", "--")
    tol = run.get("expectedTolerance")
    if tol is not None and expected not in (None, "--", ""):
        try:
            return f"{expected} (+/-{tol})"
        except (TypeError, ValueError):
            pass
    return _cell_str(expected)


def _validation_overall_status_label(td: Dict[str, Any], report_data: Dict[str, Any]) -> str:
    overall = td.get("status") or report_data.get("status") or "--"
    s = str(overall).strip()
    low = s.lower()
    if low == "pass":
        return "Pass"
    if low == "fail":
        return "Fail"
    return s or "--"


def _format_thermal_validation_runs_block(runs: list, width: int = THERMAL_WIDTH) -> list:
    w = width
    lines = ["", "VALIDATION RESULTS", _thermal_sep("-", w)]
    for idx, run in enumerate(runs):
        if idx > 0:
            lines.append("")
        lines.append(_validation_usp_label(run))
        lines.append(f"mbar/s: {_cell_str(run.get('tapsMin'))}")
        lines.append(f"Drop(mm): {_cell_str(run.get('dropHeight'))}")
        lines.append(f"Expected: {_validation_expected_display(run)}")
        lines.append(f"Actual: {_cell_str(run.get('actualTapCount'))}")
        dur = run.get("validationDurationSec")
        if dur is not None:
            try:
                lines.append(f"Duration: {int(dur)} s")
            except (TypeError, ValueError):
                pass
        lines.append(f"Status: {_cell_str(run.get('status'))}")
    lines.extend(["", _thermal_sep("-", w), ""])
    return lines


def _append_calibration_report_details(
    lines: list, td: Dict[str, Any], report_data: Dict[str, Any], width: int, thermal: bool
) -> None:
    if not isinstance(td, dict):
        td = {}
    ts_end = (
        report_data.get("completedAt")
        or td.get("completedAt")
        or report_data.get("createdAt")
        or td.get("createdAt")
    )
    set_vac = td.get("setVacuumMmHg", report_data.get("setVacuumMmHg"))
    act_vac = td.get("actualVacuumMmHg", report_data.get("actualVacuumMmHg"))
    calib_k = td.get("calibValue", report_data.get("calibValue", act_vac))
    rl_tm = td.get("releaseTimeSec", report_data.get("releaseTimeSec"))
    live_vac = td.get("liveVacuumAtPrompt")
    status = td.get("status") or report_data.get("status") or "Completed"
    remarks = report_data.get("remarks")
    if remarks is None:
        remarks = td.get("remarks")
    dash = "" if thermal else ("-" * width)

    def _vac_disp(val):
        if val in (None, ""):
            return "--"
        try:
            return "%.1f" % float(val)
        except (TypeError, ValueError):
            return str(val)

    if thermal:
        end_date, end_time = _split_ts_date_and_time(ts_end)
        lines.extend(
            [
                "",
                "CALIBRATION INFORMATION",
                f"Status: {status}",
                f"Completed Date: {end_date}",
                f"Completed Time: {end_time}",
                "",
                "CALIBRATION RESULTS",
                f"Target Vacuum (mmHg): {_vac_disp(set_vac)}",
                f"External Gauge K (mmHg): {_vac_disp(calib_k)}",
                f"Instrument Reading (mmHg): {_vac_disp(act_vac)}",
                f"Release Time RL_TM (s): {_cell_str(rl_tm)}",
            ]
        )
        if live_vac not in (None, ""):
            lines.append(f"Live Vacuum at Prompt (mmHg): {_vac_disp(live_vac)}")
        if remarks not in (None, ""):
            lines.append(f"Remarks: {remarks}")
        lines.append("")
    else:
        lines.extend(["", "CALIBRATION INFORMATION", dash if dash else ""])
        _append_two_column_pairs(
            lines,
            [
                ("Status", status),
                ("Completed", _format_ts_readable(ts_end)),
            ],
            width,
        )
        lines.extend(["", "CALIBRATION RESULTS", dash if dash else ""])
        _append_two_column_pairs(
            lines,
            [
                ("Target Vacuum (mmHg)", _vac_disp(set_vac)),
                ("External Gauge K (mmHg)", _vac_disp(calib_k)),
                ("Instrument Reading (mmHg)", _vac_disp(act_vac)),
                ("Release Time RL_TM (s)", _cell_str(rl_tm)),
            ],
            width,
        )
        if live_vac not in (None, ""):
            _append_two_column_pairs(
                lines,
                [("Live Vacuum at Prompt (mmHg)", _vac_disp(live_vac))],
                width,
            )
        if remarks not in (None, ""):
            _append_two_column_pairs(
                lines,
                [("Remarks", _truncate_with_ellipsis(remarks, max(16, width - 20)))],
                width,
            )


def _append_validation_report_details(
    lines: list, td: Dict[str, Any], report_data: Dict[str, Any], width: int, thermal: bool
) -> None:
    if not isinstance(td, dict):
        td = {}
    runs = _normalize_validation_runs(td, report_data)
    overall_label = _validation_overall_status_label(td, report_data)
    ts_end = (
        report_data.get("completedAt")
        or td.get("completedAt")
        or (runs[-1].get("completedAt") if runs else None)
        or report_data.get("createdAt")
        or td.get("createdAt")
    )
    remarks = report_data.get("remarks")
    if remarks is None:
        remarks = td.get("remarks")
    dash = "" if thermal else ("-" * width)

    if thermal:
        end_date, end_time = _split_ts_date_and_time(ts_end)
        lines.extend(
            [
                "",
                "VALIDATION INFORMATION",
                f"Overall Status: {overall_label}",
                f"Completed Date: {end_date}",
                f"Completed Time: {end_time}",
                "",
            ]
        )
        if runs:
            lines.extend(_format_thermal_validation_runs_block(runs, width))
        else:
            lines.extend(["", "VALIDATION RESULTS", "No validation data", ""])
    else:
        lines.extend(["", "VALIDATION INFORMATION", dash if dash else ""])
        _append_two_column_pairs(
            lines,
            [
                ("Overall Status", overall_label),
                ("Completed", _format_ts_readable(ts_end)),
            ],
            width,
        )
        lines.extend(["", "VALIDATION RESULTS", dash if dash else ""])
        if not runs:
            lines.append("No validation data")
        for idx, run in enumerate(runs):
            if idx > 0:
                lines.append("")
            lines.append(_validation_usp_label(run))
            run_pairs = [
                ("mbar/s", _cell_str(run.get("tapsMin"))),
                ("Drop (mm)", _cell_str(run.get("dropHeight"))),
                ("Expected", _validation_expected_display(run)),
                ("Actual", _cell_str(run.get("actualTapCount"))),
            ]
            dur = run.get("validationDurationSec")
            if dur is not None:
                try:
                    run_pairs.append(("Duration", f"{int(dur)} s"))
                except (TypeError, ValueError):
                    pass
            run_pairs.append(("Status", _cell_str(run.get("status"))))
            _append_two_column_pairs(lines, run_pairs, width)
        lines.append("")

    if remarks not in (None, ""):
        if thermal:
            lines.extend(["", "REMARKS:", str(remarks), ""])
        else:
            lines.extend(["", "REMARKS", dash if dash else ""])
            _append_two_column_pairs(lines, [("Remarks", _truncate_with_ellipsis(remarks, max(16, width - 20)))], width)
            lines.append("")


def _append_test_report_details(lines: list, td: Dict[str, Any], report_data: Dict[str, Any], width: int, thermal: bool) -> None:
    """Append remarks, step results, and statistics (matches on-screen report preview)."""
    dash = "" if thermal else ("-" * width)
    remarks = report_data.get("remarks")
    if remarks is None and isinstance(td, dict):
        remarks = td.get("remarks")
    status_raw = str(td.get("status") or report_data.get("status") or "").strip().lower() if isinstance(td, dict) else ""
    remarks_label = "ABORT REMARKS" if status_raw == "aborted" else "REMARKS"
    if remarks not in (None, ""):
        if thermal:
            lines.extend(["", remarks_label + ":", str(remarks), ""])
        else:
            lines.extend(["", remarks_label, dash if dash else ""])
            _append_two_column_pairs(lines, [("Comments", _truncate_with_ellipsis(remarks, max(16, width - 20)))], width)
            lines.append("")

    if not isinstance(td, dict):
        td = {}
    results = td.get("stepResults") or []
    row_count = _effective_step_row_count(td)

    duration_sec = test_duration_seconds(td)
    if duration_sec is not None:
        if thermal:
            lines.append(f"Test Duration: {format_duration_hhmmss(duration_sec)}")
        else:
            _append_two_column_pairs(lines, [("Test Duration", format_duration_hhmmss(duration_sec))], width)

    status_raw = str(td.get("status") or report_data.get("status") or "").lower()
    recipe = report_data.get("recipe") or td.get("recipe") or {}
    if not isinstance(recipe, dict):
        recipe = {}
    steps = recipe.get("steps") or td.get("steps") or []
    derived = report_data.get("reportDerived")
    if not isinstance(derived, dict) or not derived:
        derived = build_test_report_derived(td, recipe, report_data.get("id"))

    if row_count > 0:
        if thermal:
            lines.extend(_format_thermal_test_data_table(row_count, results, steps))
        else:
            eq = _section_sep("=", width, False)
            lines.extend(["", eq, "TEST DATA", dash if dash else ""])
            hdr = f"{'S':>2}  {'Count':>6}  {'Vol(ml)':>9}  {'dVol':>8}  {'Bulk':>9}  {'Tap':>9}"
            lines.append(hdr)
            if dash:
                lines.append(dash)
            for i in range(row_count):
                r = results[i] if i < len(results) and isinstance(results[i], dict) else {}
                cnt = "--"
                if i < len(steps) and isinstance(steps[i], dict):
                    cnt = steps[i].get("tapCount", "--")
                vol = r.get("volumeMl", "__")
                dvol = r.get("volumeDeltaMl", "__")
                if dvol not in (None, "", "__"):
                    dvol = _fmt_density_val(dvol)
                bulk = r.get("bulkDensity", "__")
                if bulk not in (None, "", "__"):
                    bulk = _fmt_density_val(bulk)
                tap = r.get("tapDensity", "__")
                if tap not in (None, "", "__"):
                    tap = _fmt_density_val(tap)
                sn = i + 1
                lines.append(
                    f"{sn:2d}  {str(cnt):>6}  {str(vol):>9}  {str(dvol):>8}  {str(bulk):>9}  {str(tap):>9}"
                )
            lines.append(dash if dash else "")
    elif str(report_data.get("type") or "test").strip().lower() == "test":
        lines.extend(["", "TEST DATA: No test data recorded"])

    if str(report_data.get("type") or "test").strip().lower() == "test":
        _append_derived_test_summary_and_result(lines, derived, width, thermal)

    stats = report_data.get("statistics") or td.get("statistics") or {}
    _append_test_statistics_block(lines, stats, width, thermal, status_raw)


def _format_report_text(report_data: Dict[str, Any], width: int = A4_TEXT_WIDTH) -> str:
    thermal = width < 70
    sep = _thermal_sep("=", width) if thermal else ("=" * width)
    sep_dash = _thermal_sep("-", width) if thermal else ("-" * width)
    td = report_data.get("testData") or report_data
    fs = report_data.get("factorySettings") or {}
    rtype = str(report_data.get("type") or "test").strip().lower()
    if rtype == "validation":
        title = "LEAK TEST VALIDATION REPORT"
    elif rtype == "calibration":
        title = "LEAK TEST CALIBRATION REPORT"
    else:
        title = "LEAK TEST REPORT"
    lines: list = []
    if thermal:
        lines.extend([sep, "RAISE LAB EQUIPMENT", ""])
    else:
        lines.append(sep)
    lines.append(title if thermal else title.center(width))
    if thermal:
        lines.append("")
    else:
        lines.append(sep)
    derived_hdr: Dict[str, Any] = {}
    if rtype not in ("validation", "calibration"):
        derived_hdr = report_data.get("reportDerived") or {}
        if not isinstance(derived_hdr, dict) or not derived_hdr:
            td_hdr = td if isinstance(td, dict) else {}
            recipe_hdr = report_data.get("recipe") or td_hdr.get("recipe") or {}
            if not isinstance(recipe_hdr, dict):
                recipe_hdr = {}
            derived_hdr = build_test_report_derived(td_hdr, recipe_hdr, report_data.get("id"))
    print_date = derived_hdr.get("printDate", "--") if derived_hdr else "--"
    print_time = derived_hdr.get("printTime", "--") if derived_hdr else "--"
    if thermal:
        lines.extend(
            [
                f"Company: {fs.get('companyName', 'N/A')}",
                f"Model No: {fs.get('modelNo', 'N/A')}",
                f"Serial No: {fs.get('serialNo', 'N/A')}",
                f"Print Date: {print_date}",
                f"Print Time: {print_time}",
                f"Location: {fs.get('companyLocation', fs.get('location', 'N/A'))}",
                f"Instrument ID: {fs.get('instrumentId', 'N/A')}",
                f"Last Val: {fs.get('lastValidationDate', 'N/A')}",
                f"Next Val Due: {fs.get('nextValidationDate', 'N/A')}",
            ]
        )
    else:
        _append_two_column_pairs(
            lines,
            [
                ("Company", fs.get("companyName", "N/A")),
                ("Model No", fs.get("modelNo", "N/A")),
                ("Serial No", fs.get("serialNo", "N/A")),
                ("Print Date", print_date),
                ("Print Time", print_time),
                ("Location", fs.get("companyLocation", fs.get("location", "N/A"))),
                ("Instrument ID", fs.get("instrumentId", "N/A")),
                ("Last Val", fs.get("lastValidationDate", "N/A")),
                ("Next Val Due", fs.get("nextValidationDate", "N/A")),
            ],
            width,
        )
    if not thermal:
        lines.append("")
    if rtype == "validation":
        _append_validation_report_details(lines, td if isinstance(td, dict) else {}, report_data, width, thermal)
    elif rtype == "calibration":
        _append_calibration_report_details(lines, td if isinstance(td, dict) else {}, report_data, width, thermal)
    else:
        recipe = report_data.get("recipe") or td.get("recipe") or td
        if not isinstance(recipe, dict):
            recipe = {}
        status_raw = str(td.get("status", "")).lower() if isinstance(td, dict) else ""
        status_label = "Aborted" if status_raw == "aborted" else "Completed"
        operator = report_data.get("operatorName") or td.get("operatorName", "--")
        comments = report_data.get("remarks") or td.get("remarks") or ""
        ts_start = td.get("testStartTime") or report_data.get("createdAt")
        ts_end = (
            td.get("testEndTime")
            or report_data.get("completedAt")
            or td.get("completedAt")
            or report_data.get("createdAt")
        )
        duration_sec = test_duration_seconds(td if isinstance(td, dict) else {})
        duration_str = format_duration_hhmmss(duration_sec) if duration_sec is not None else "--"

        def _fmt_mmss(total):
            try:
                t = int(float(total))
            except (TypeError, ValueError):
                return None
            if t < 0:
                t = 0
            return "%02d:%02d" % (t // 60, t % 60)

        set_vac = td.get("setVacuumMmHg")
        if set_vac in (None, ""):
            set_vac = recipe.get("vacuumMmHg")
        set_vac_disp = str(set_vac) if set_vac not in (None, "") else "--"
        act_vac = td.get("actualVacuumMmHg")
        try:
            act_vac_disp = "%.1f" % float(act_vac) if act_vac not in (None, "") else "--"
        except (TypeError, ValueError):
            act_vac_disp = str(act_vac) if act_vac not in (None, "") else "--"
        set_dur = (
            td.get("setDurationDisplay")
            or _fmt_mmss(td.get("setDurationSec"))
            or recipe.get("durationDisplay")
            or _fmt_mmss(recipe.get("durationSec"))
            or "--"
        )
        act_dur = td.get("actualDurationDisplay") or _fmt_mmss(td.get("actualDurationSec")) or "--"
        result_val = td.get("result") or "--"

        batch_size = td.get("batchSize")
        if batch_size in (None, ""):
            batch_size = recipe.get("batchSize")
        ar_no = td.get("analysisReportNo") or recipe.get("analysisReportNo")
        if ar_no in (None, ""):
            legacy_ar = td.get("arNumbers") or recipe.get("arNumbers") or []
            if isinstance(legacy_ar, list) and legacy_ar:
                ar_no = legacy_ar[0]
            elif legacy_ar not in (None, "", []):
                ar_no = legacy_ar

        def _append_hold_vacuum_samples(dest: list, for_thermal: bool) -> None:
            samples = td.get("vacuumSamples") or []
            if not isinstance(samples, list) or not samples:
                return
            if for_thermal:
                dest.extend(["", "HOLD VACUUM SAMPLES", "Time          Vacuum"])
                for s in samples:
                    if not isinstance(s, dict):
                        continue
                    pct = s.get("percent")
                    t_disp = s.get("timeDisplay") or _fmt_mmss(s.get("elapsedSec")) or "--"
                    try:
                        vac_s = "%.1f" % float(s.get("vacuumMmHg")) if s.get("vacuumMmHg") not in (None, "") else "--"
                    except (TypeError, ValueError):
                        vac_s = str(s.get("vacuumMmHg") or "--")
                    pct_disp = "%s%%" % pct if pct not in (None, "") else "--"
                    left = ("%s/%s" % (pct_disp, t_disp))[:14].ljust(14)
                    dest.append("%s%s" % (left, vac_s))
            else:
                dest.extend(["", "HOLD VACUUM SAMPLES", sep_dash])
                dest.append("Time (% / mm:ss)".ljust(40) + "Vacuum (mmHg)")
                for s in samples:
                    if not isinstance(s, dict):
                        continue
                    pct = s.get("percent")
                    t_disp = s.get("timeDisplay") or _fmt_mmss(s.get("elapsedSec")) or "--"
                    try:
                        vac_s = "%.1f" % float(s.get("vacuumMmHg")) if s.get("vacuumMmHg") not in (None, "") else "--"
                    except (TypeError, ValueError):
                        vac_s = str(s.get("vacuumMmHg") or "--")
                    pct_disp = "%s%%" % pct if pct not in (None, "") else "--"
                    left = ("%s / %s" % (pct_disp, t_disp)).ljust(40)
                    dest.append((left + vac_s)[:width])

        if thermal:
            info_lines = [
                "TEST INFORMATION",
                f"Product: {recipe.get('productName', td.get('productName', 'N/A'))}",
                f"Batch: {recipe.get('batchNumber', td.get('batchNumber', 'N/A'))}",
                f"Batch Size: {batch_size if batch_size not in (None, '') else 'N/A'}",
                f"A.R. No: {ar_no if ar_no not in (None, '') else 'N/A'}",
                f"Operator: {operator}",
                f"Test Start: {_format_ts_readable(ts_start)}",
                f"Completed: {_format_ts_readable(ts_end)}",
                f"Duration: {duration_str}",
                f"Test Status: {status_label}",
                "",
                "TEST RESULT",
                f"Set Vacuum (mmHg): {set_vac_disp}",
                f"Actual Vacuum (mmHg): {act_vac_disp}",
                f"Set Duration (mm:ss): {set_dur}",
                f"Actual Duration (mm:ss): {act_dur}",
                f"Result: {result_val}",
            ]
            _append_hold_vacuum_samples(info_lines, True)
            if comments not in (None, ""):
                info_lines.append(f"Comments: {comments}")
            info_lines.append("")
            lines.extend(info_lines)
        else:
            lines.extend(["", "TEST INFORMATION", sep_dash])
            _append_two_column_pairs(
                lines,
                [
                    ("Product", recipe.get("productName", td.get("productName", "N/A"))),
                    ("Batch", recipe.get("batchNumber", td.get("batchNumber", "N/A"))),
                    ("Batch Size", batch_size if batch_size not in (None, "") else "N/A"),
                    ("A.R. No", ar_no if ar_no not in (None, "") else "N/A"),
                    ("Operator", operator),
                    ("Test Start", _format_ts_readable(ts_start)),
                    ("Completed", _format_ts_readable(ts_end)),
                    ("Duration", duration_str),
                    ("Test Status", status_label),
                ],
                width,
            )
            lines.extend(["", "TEST RESULT", sep_dash])
            _append_two_column_pairs(
                lines,
                [
                    ("Set Vacuum (mmHg)", set_vac_disp),
                    ("Actual Vacuum (mmHg)", act_vac_disp),
                    ("Set Duration (mm:ss)", set_dur),
                    ("Actual Duration (mm:ss)", act_dur),
                    ("Result", result_val),
                ],
                width,
            )
            _append_hold_vacuum_samples(lines, False)
            if comments not in (None, ""):
                _append_two_column_pairs(
                    lines,
                    [("Comments", _truncate_with_ellipsis(comments, max(16, width - 20)))],
                    width,
                )
    if thermal:
        lines.extend(["", "APPROVAL"])
    if thermal:
        lines.extend(
            [
                f"Operated by: {report_data.get('operatorName') or td.get('operatorName', '--')}",
                f"Employee ID: {td.get('employeeId', '--')}",
                f"Approval Result: {report_data.get('approvalPassFail', '--')}",
                f"Approved By: {report_data.get('approvedBy', '--')}",
                f"Approved At: {_format_ts_readable(report_data.get('approvedAt'))}",
                f"Approval Remarks: {report_data.get('approvalRemarks', '')}",
            ]
        )
    else:
        lines.extend(["", "APPROVAL", sep_dash])
        _append_two_column_pairs(
            lines,
            [
                ("Operated by", report_data.get("operatorName") or td.get("operatorName", "--")),
                ("Employee ID", td.get("employeeId", "--")),
                ("Approval Result", report_data.get("approvalPassFail", "--")),
                ("Approved By", report_data.get("approvedBy", "--")),
                ("Approved At", _format_ts_readable(report_data.get("approvedAt"))),
                ("Approval Remarks", _truncate_with_ellipsis(report_data.get("approvalRemarks", ""), max(16, width - 20))),
            ],
            width,
        )
    if thermal:
        lines.extend([sep, ""])
        flat: list = []
        for line in lines:
            flat.extend(_fit_thermal_line(line, width))
        lines = _compact_thermal_lines(flat, width)
        return "\n".join(lines)
    return "\n".join(_wrap_lines(lines, width))


def format_for_a4_printer(
    report_data: Dict[str, Any], *, include_printed_timestamp: bool = True
) -> str:
    text = _format_report_text(report_data, width=A4_TEXT_WIDTH).rstrip("\n")
    if not include_printed_timestamp:
        return text
    footer = "\n".join(_thermal_printed_timestamp_lines())
    return text + "\n\n" + footer


def _thermal_printed_timestamp_lines() -> list:
    """Printed date/time from device RTC at format time."""
    try:
        import rtc_service

        payload = rtc_service.get_device_wall_datetime_payload()
        pdate = payload.get("date") or "--"
        ptime = payload.get("time") or "--"
    except Exception:
        now = datetime.now()
        pdate = now.strftime("%d-%m-%Y")
        ptime = now.strftime("%H:%M:%S")
    return ["", f"Printed Date: {pdate}", f"Printed Time: {ptime}"]


def _thermal_trailing_feed() -> str:
    return "\n" * THERMAL_POST_PRINT_FEED_LINES


def format_for_thermal_printer(report_data: Dict[str, Any]) -> str:
    text = _format_report_text(report_data, width=THERMAL_WIDTH).rstrip("\n")
    footer = "\n".join(_thermal_printed_timestamp_lines())
    return text + "\n\n" + footer + _thermal_trailing_feed()


def save_report_text_files(report_data: Dict[str, Any], report_id: int, reports_dir: pathlib.Path) -> None:
    if not report_data or report_id is None:
        return
    try:
        reports_dir = pathlib.Path(reports_dir)
        reports_dir.mkdir(parents=True, exist_ok=True)
        text_48 = format_for_thermal_printer(report_data)
        text_80 = format_for_a4_printer(report_data).rstrip() + "\r\n\x0c"
        (reports_dir / f"report_{report_id}_a4.txt").write_text(text_80, encoding="utf-8")
        (reports_dir / f"report_{report_id}_thermal.txt").write_text(text_48, encoding="utf-8")
    except Exception as e:
        _log.warning("save_report_text_files failed: %s", e)


def print_report_from_file(txt_path: pathlib.Path, port: str, baud: int, printer_type: str = "a4") -> Dict[str, Any]:
    txt_path = pathlib.Path(txt_path)
    if not txt_path.exists() or not txt_path.is_file():
        return {"success": False, "error": f"Report file not found: {txt_path}", "port": port}
    if not serial:
        return {"success": False, "error": "pyserial not installed", "port": port}
    if printer_type == "thermal":
        try:
            port = _probe_port(port, THERMAL_CANDIDATES)
        except FileNotFoundError as e:
            return {"success": False, "error": f"Printer port not found: {e.filename or port}", "port": port}
    elif not _port_exists(port):
        return {"success": False, "error": f"Printer port not found: {port}", "port": port}
    try:
        data = txt_path.read_bytes()
        if printer_type == "a4":
            ser = _open_a4_serial(port, baud)
            try:
                ser.reset_output_buffer()
                ser.flush()
                _send_printer_init(ser)
                _send_bytes_chunked(ser, data, baud, chunk_size=512)
                time.sleep(0.5)
                return {"success": True, "port": port}
            finally:
                ser.close()
        ser = serial.Serial(port=port, baudrate=baud, timeout=2.0)
        try:
            _send_printer_init(ser)
            time.sleep(0.2)
            _send_text_to_thermal(ser, data.decode("utf-8", errors="replace"), baud)
            time.sleep(0.5)
            return {"success": True, "port": port}
        finally:
            ser.close()
    except Exception as e:
        return {"success": False, "error": str(e), "port": port}


def print_a4_report(report_data: Dict[str, Any], printer_port: Optional[str] = None) -> Dict[str, Any]:
    port = printer_port or _a4_port
    baud = _a4_baud
    if not serial:
        return {"success": False, "error": "pyserial not installed", "port": port}
    if not _port_exists(port):
        return {"success": False, "error": f"A4 printer port not found: {port}", "port": port}
    try:
        text = format_for_a4_printer(report_data).rstrip() + "\r\n\x0c"
        ser = _open_a4_serial(port, baud)
        try:
            ser.reset_output_buffer()
            ser.flush()
            _send_printer_init(ser)
            _send_text_to_a4(ser, text, baud)
            time.sleep(0.5)
            return {"success": True, "port": port}
        finally:
            ser.close()
    except Exception as e:
        return {"success": False, "error": str(e), "port": port}


def print_thermal_report(report_data: Dict[str, Any], printer_port: Optional[str] = None) -> Dict[str, Any]:
    port = printer_port or _thermal_port
    baud = _thermal_baud
    if not serial:
        return {"success": False, "error": "pyserial not installed", "port": port}
    try:
        port = _probe_port(port, THERMAL_CANDIDATES)
    except FileNotFoundError as e:
        return {"success": False, "error": f"Thermal printer port not found: {e.filename or port}", "port": port}
    try:
        text = format_for_thermal_printer(report_data)
        ser = serial.Serial(port=port, baudrate=baud, timeout=2.0)
        try:
            _send_printer_init(ser)
            time.sleep(0.2)
            _send_text_to_thermal(ser, text, baud)
            time.sleep(0.5)
            return {"success": True, "port": port}
        finally:
            ser.close()
    except Exception as e:
        return {"success": False, "error": str(e), "port": port}


def _format_recipe_text(recipe_data: Dict[str, Any], width: int = A4_TEXT_WIDTH) -> str:
    thermal = width < 70
    sep = _thermal_sep("=", width) if thermal else ("=" * width)
    sep_dash = _thermal_sep("-", width) if thermal else ("-" * width)
    fs = recipe_data.get("factorySettings") or {}
    lines = [
        sep,
        "LEAK TEST RECIPE" if thermal else "LEAK TEST RECIPE".center(width),
        sep_dash if thermal else sep,
        f"Company: {fs.get('companyName', 'N/A')}",
        f"Model No: {fs.get('modelNo', 'N/A')}",
        f"Serial No: {fs.get('serialNo', 'N/A')}",
        f"Location: {fs.get('companyLocation', fs.get('location', 'N/A'))}",
        f"Instrument ID: {fs.get('instrumentId', 'N/A')}",
        f"Last Val: {fs.get('lastValidationDate', 'N/A')}",
        f"Next Val Due: {fs.get('nextValidationDate', 'N/A')}",
        sep_dash if thermal else "",
        f"Product: {recipe_data.get('productName', recipe_data.get('name', 'N/A'))}",
        f"Batch: {recipe_data.get('batchNumber', 'N/A')}",
        f"Unit: {recipe_data.get('unit', 'N/A')}",
        sep,
    ]
    if thermal:
        flat: list = []
        for line in lines:
            flat.extend(_fit_thermal_line(line, width))
        return "\n".join(_apply_thermal_line_spacing(flat, width))
    return "\n".join(_wrap_lines(lines, width))


def print_recipe_a4(recipe_data: Dict[str, Any], printer_port: Optional[str] = None) -> Dict[str, Any]:
    port = printer_port or _a4_port
    baud = _a4_baud
    if not serial:
        return {"success": False, "error": "pyserial not installed", "port": port}
    if not _port_exists(port):
        return {"success": False, "error": f"A4 printer port not found: {port}", "port": port}
    try:
        text = _format_recipe_text(recipe_data, width=A4_TEXT_WIDTH).rstrip() + "\r\n\x0c"
        ser = _open_a4_serial(port, baud)
        try:
            ser.reset_output_buffer()
            ser.flush()
            _send_printer_init(ser)
            _send_text_to_a4(ser, text, baud)
            time.sleep(0.5)
            return {"success": True, "port": port}
        finally:
            ser.close()
    except Exception as e:
        return {"success": False, "error": str(e), "port": port}


def print_recipe_thermal(recipe_data: Dict[str, Any], printer_port: Optional[str] = None) -> Dict[str, Any]:
    port = printer_port or _thermal_port
    baud = _thermal_baud
    if not serial:
        return {"success": False, "error": "pyserial not installed", "port": port}
    try:
        port = _probe_port(port, THERMAL_CANDIDATES)
    except FileNotFoundError as e:
        return {"success": False, "error": f"Thermal printer port not found: {e.filename or port}", "port": port}
    try:
        text = _format_recipe_text(recipe_data, width=THERMAL_WIDTH).rstrip("\n") + _thermal_trailing_feed()
        ser = serial.Serial(port=port, baudrate=baud, timeout=2.0)
        try:
            _send_printer_init(ser)
            time.sleep(0.2)
            _send_text_to_thermal(ser, text, baud)
            time.sleep(0.5)
            return {"success": True, "port": port}
        finally:
            ser.close()
    except Exception as e:
        return {"success": False, "error": str(e), "port": port}
