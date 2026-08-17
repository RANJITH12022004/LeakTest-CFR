#!/usr/bin/env python3
"""
report_service.py - Leak Test report generation and context.
"""

import html as html_module
import json
import pathlib
from datetime import datetime
from typing import Dict, Any, Optional, List

import data_service

_config = {}
_reports_dir = None
_storage_dir = None


def init(config):
    global _config, _reports_dir, _storage_dir
    _config = dict(config)
    _reports_dir = pathlib.Path(_config.get("REPORTS_DIR", "./reports"))
    _storage_dir = pathlib.Path(_config.get("STORAGE_DIR", "./storage"))
    _reports_dir.mkdir(parents=True, exist_ok=True)


def generate_report(
    test_data: Dict[str, Any],
    recipe: Optional[Dict[str, Any]] = None,
    factory_settings: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    report = dict(test_data)
    if recipe:
        report["recipe"] = {
            "id": recipe.get("id"),
            "name": recipe.get("name") or recipe.get("productName"),
            "productName": recipe.get("productName"),
            "batchNumber": recipe.get("batchNumber"),
            "unit": recipe.get("unit"),
        }
    if not factory_settings:
        factory_settings = data_service.get_factory_settings()
    report["factorySettings"] = enrich_factory_settings(factory_settings or {})
    if not report.get("createdAt"):
        report["createdAt"] = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    if not report.get("completedAt"):
        report["completedAt"] = report["createdAt"]
    report = enrich_report_context(report)
    return report


def enrich_factory_settings(factory_settings: Dict[str, Any]) -> Dict[str, Any]:
    fs_in = factory_settings or {}
    enriched = {
        "companyName": fs_in.get("companyName") or "N/A",
        "modelNo": fs_in.get("modelNo") or "N/A",
        "serialNo": fs_in.get("serialNo") or "N/A",
        "companyLocation": fs_in.get("companyLocation") or fs_in.get("location") or "N/A",
        "instrumentId": fs_in.get("instrumentId") or "N/A",
        "lastValidationDate": fs_in.get("lastValidationDate") or "N/A",
        "nextValidationDate": fs_in.get("nextValidationDate") or "N/A",
    }
    dates = _resolve_validation_dates(fs_in)
    if dates.get("lastValidationDate"):
        enriched["lastValidationDate"] = dates["lastValidationDate"]
    if dates.get("nextValidationDate"):
        enriched["nextValidationDate"] = dates["nextValidationDate"]
    return enriched


def format_duration_hhmmss(seconds_val: Any) -> str:
    """Format elapsed seconds as HH:MM:SS for reports."""
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


def test_duration_seconds(td: Dict[str, Any]) -> Optional[int]:
    """Resolve test duration in seconds from stored testData."""
    if not isinstance(td, dict):
        return None
    sec = td.get("durationSeconds")
    if sec is not None:
        try:
            return max(0, int(sec))
        except (TypeError, ValueError):
            pass
    start_raw = td.get("testStartTime")
    end_raw = td.get("testEndTime")
    if start_raw and end_raw:
        try:
            start = datetime.fromisoformat(str(start_raw).replace("Z", "+00:00"))
            end = datetime.fromisoformat(str(end_raw).replace("Z", "+00:00"))
            return max(0, int((end - start).total_seconds()))
        except Exception:
            pass
    return None


def _parse_density_number(val: Any) -> Optional[float]:
    if val is None or val == "" or val == "--":
        return None
    try:
        return float(str(val).replace(",", "").strip())
    except (TypeError, ValueError):
        return None


def _stat_display_value(val: Dict[str, Any]) -> Any:
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


def _agg_mean_min_max(values: List[float]) -> Dict[str, float]:
    if not values:
        return {}
    return {
        "mean": round(sum(values) / len(values), 3),
        "min": round(min(values), 3),
        "max": round(max(values), 3),
    }


def _parse_float(val: Any) -> Optional[float]:
    if val is None or val == "" or val == "--":
        return None
    try:
        return float(str(val).replace(",", "").strip())
    except (TypeError, ValueError):
        return None


def _format_derived_number(val: Any, decimals: int = 3) -> str:
    if val is None:
        return "--"
    try:
        f = float(val)
        if decimals <= 0:
            return str(int(round(f)))
        fmt = f"{{:.{decimals}f}}"
        s = fmt.format(f)
        return s.rstrip("0").rstrip(".") if "." in s else s
    except (TypeError, ValueError):
        return str(val)


def _report_print_timestamp() -> Dict[str, str]:
    try:
        import rtc_service

        payload = rtc_service.get_device_wall_datetime_payload()
        return {
            "printDate": str(payload.get("date") or "--"),
            "printTime": str(payload.get("time") or "--"),
        }
    except Exception:
        now = datetime.now()
        return {
            "printDate": now.strftime("%d/%m/%Y"),
            "printTime": now.strftime("%H:%M:%S"),
        }


def _test_type_label(recipe: Dict[str, Any], td: Dict[str, Any]) -> str:
    recipe = recipe or {}
    td = td or {}
    mode = str(recipe.get("uspMode") or td.get("uspMode") or "").strip().upper()
    if mode == "VACUUM_DECAY":
        return "Vacuum Decay"
    if mode == "PRESSURE_DECAY":
        return "Pressure Decay"
    if mode == "CUSTOM":
        return "Custom"
    usp = str(recipe.get("usp") or td.get("usp") or "").strip()
    if not usp:
        return "--"
    u = usp.upper().replace("  ", " ")
    if u in ("VACUUM_DECAY", "Vacuum Decay"):
        return "Vacuum Decay"
    if u in ("PRESSURE_DECAY", "Pressure Decay"):
        return "Pressure Decay"
    if "CUSTOM" in u:
        return "Custom"
    return usp


def _test_method_label(recipe: Dict[str, Any], td: Dict[str, Any], test_type: str) -> str:
    recipe = recipe or {}
    td = td or {}
    cyl = recipe.get("cylinder") if isinstance(recipe.get("cylinder"), dict) else {}
    cyl_ml = cyl.get("volume") or cyl.get("volumeMl") or td.get("sampleVolumeMl")
    parts = [test_type] if test_type and test_type != "--" else []
    if cyl_ml not in (None, "", "--"):
        parts.append(f"{cyl_ml} ml cylinder")
    return ", ".join(parts) if parts else "--"


def _drop_height_display(recipe: Dict[str, Any], td: Dict[str, Any]) -> str:
    recipe = recipe or {}
    td = td or {}
    dh = recipe.get("dropHeight")
    steps = recipe.get("steps") or td.get("steps") or []
    if dh is None and isinstance(steps, list) and steps and isinstance(steps[0], dict):
        dh = steps[0].get("dropHeight")
    if dh is None and isinstance(td, dict):
        dh = td.get("dropHeight")
    if dh is None or dh == "":
        return "--"
    try:
        mm = float(dh)
        return f"{_format_derived_number(mm, 0)} mm +/- 0.2 mm"
    except (TypeError, ValueError):
        return str(dh)


def build_test_report_derived(
    td: Optional[Dict[str, Any]],
    recipe: Optional[Dict[str, Any]] = None,
    report_id: Any = None,
) -> Dict[str, Any]:
    """Classic tap-density report fields (W/V0, W/Vf, readings, test metadata)."""
    td = td if isinstance(td, dict) else {}
    recipe = recipe if isinstance(recipe, dict) else {}
    if not recipe and isinstance(td.get("recipe"), dict):
        recipe = td.get("recipe") or {}

    results = td.get("stepResults") or []
    if not isinstance(results, list):
        results = []
    steps = recipe.get("steps") or td.get("steps") or []
    if not isinstance(steps, list):
        steps = []

    weight = _parse_float(td.get("initialWeightG"))
    initial_vol = None
    final_vol = None
    if results:
        initial_vol = _parse_float(results[0].get("volumeMl") if isinstance(results[0], dict) else None)
        final_vol = _parse_float(results[-1].get("volumeMl") if isinstance(results[-1], dict) else None)
    if initial_vol is None:
        initial_vol = _parse_float(td.get("initialVolumeMl"))

    diff_last_two = None
    if len(results) >= 2:
        v1 = _parse_float(results[-2].get("volumeMl") if isinstance(results[-2], dict) else None)
        v2 = _parse_float(results[-1].get("volumeMl") if isinstance(results[-1], dict) else None)
        if v1 is not None and v2 is not None:
            diff_last_two = abs(v1 - v2)
    elif len(results) == 1 and isinstance(results[0], dict):
        diff_last_two = _parse_float(results[0].get("volumeDeltaMl"))

    initial_density = None
    tapped_density = None
    if weight is not None and initial_vol is not None and initial_vol > 0:
        initial_density = round(weight / initial_vol, 3)
    if weight is not None and final_vol is not None and final_vol > 0:
        tapped_density = round(weight / final_vol, 3)

    compressibility = None
    hausner = None
    if initial_vol is not None and final_vol is not None and initial_vol > 0 and final_vol > 0:
        compressibility = round((1.0 - (final_vol / initial_vol)) * 100.0, 2)
        hausner = round(initial_vol / final_vol, 3)

    test_type = _test_type_label(recipe, td)
    test_method = _test_method_label(recipe, td, test_type)

    speed = recipe.get("speed")
    if speed is None and steps and isinstance(steps[0], dict):
        speed = steps[0].get("speed")

    recipe_for_taps = dict(recipe)
    if not recipe_for_taps.get("steps") and td.get("steps"):
        recipe_for_taps["steps"] = td.get("steps")
    if recipe_for_taps.get("customTotalTaps") is None and td.get("customTotalTaps") is not None:
        recipe_for_taps["customTotalTaps"] = td.get("customTotalTaps")
    total_taps = _recipe_total_tap_count(recipe_for_taps)
    step_tap_counts: List[Any] = []
    for step in steps:
        if isinstance(step, dict) and step.get("tapCount") is not None:
            step_tap_counts.append(step.get("tapCount"))

    readings: List[Dict[str, Any]] = []
    for i, row in enumerate(results):
        if not isinstance(row, dict):
            continue
        count = None
        if i < len(steps) and isinstance(steps[i], dict):
            count = steps[i].get("tapCount")
        vol = row.get("volumeMl", "--")
        dvol = row.get("volumeDeltaMl")
        if dvol in (None, "", "__"):
            dvol_str = "--"
        else:
            try:
                dvol_str = f"{float(dvol):.4f}"
            except (TypeError, ValueError):
                dvol_str = str(dvol)
        readings.append(
            {
                "step": i + 1,
                "count": count,
                "volume": vol,
                "volumeDiff": dvol_str,
            }
        )

    test_no = "--"
    if report_id is not None:
        try:
            test_no = f"{int(report_id):04d}"
        except (TypeError, ValueError):
            test_no = str(report_id)

    ts = _report_print_timestamp()
    return {
        **ts,
        "testNumber": test_no,
        "testType": test_type,
        "testMethod": test_method,
        "dropsPerMin": speed if speed is not None else "--",
        "dropHeight": _drop_height_display(recipe, td),
        "totalTaps": total_taps,
        "stepTapCounts": step_tap_counts,
        "sampleWeightG": weight,
        "initialVolumeMl": initial_vol,
        "finalVolumeMl": final_vol,
        "diffLastTwoVolumesMl": diff_last_two,
        "initialDensityGPerMl": initial_density,
        "tappedDensityGPerMl": tapped_density,
        "compressibilityIndexPct": compressibility,
        "hausnerRatio": hausner,
        "readings": readings,
    }


def compute_test_report_statistics(test_data: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Option A: Hausner = tap/bulk; CI% = (tap-bulk)/tap*100; agg over completed steps; final-step CI/Hausner."""
    if not isinstance(test_data, dict):
        return None
    if str(test_data.get("status") or "").strip().lower() == "aborted":
        return None
    results = test_data.get("stepResults") or []
    if not isinstance(results, list) or not results:
        return None

    bulk_vals: List[float] = []
    tap_vals: List[float] = []
    for row in results:
        if not isinstance(row, dict):
            continue
        b = _parse_density_number(row.get("bulkDensity"))
        t = _parse_density_number(row.get("tapDensity"))
        if b is not None:
            bulk_vals.append(b)
        if t is not None:
            tap_vals.append(t)

    stats: Dict[str, Any] = {}
    bulk_agg = _agg_mean_min_max(bulk_vals)
    tap_agg = _agg_mean_min_max(tap_vals)
    if bulk_agg:
        stats["Bulk density (g/mL)"] = bulk_agg
    if tap_agg:
        stats["Tap density (g/mL)"] = tap_agg

    last = results[-1] if isinstance(results[-1], dict) else {}
    bulk_f = _parse_density_number(last.get("bulkDensity"))
    tap_f = _parse_density_number(last.get("tapDensity"))
    if bulk_f is None and bulk_vals:
        bulk_f = bulk_vals[0]
    if tap_f is None and tap_vals:
        tap_f = tap_vals[-1]
    if bulk_f is not None and tap_f is not None and tap_f > 0 and bulk_f > 0:
        stats["Compressibility index (%)"] = {
            "value": round(((tap_f - bulk_f) / tap_f) * 100.0, 2)
        }
        stats["Hausner ratio"] = {"value": round(tap_f / bulk_f, 3)}

    return stats if stats else None


def enrich_report_context(report_data: Dict[str, Any]) -> Dict[str, Any]:
    if not report_data:
        return report_data
    factory_settings = data_service.get_factory_settings()
    fs = report_data.get("factorySettings") or {}
    for k, default in [
        ("companyName", "N/A"),
        ("modelNo", "N/A"),
        ("serialNo", "N/A"),
        ("companyLocation", "N/A"),
        ("instrumentId", "N/A"),
    ]:
        if not fs.get(k):
            fs[k] = factory_settings.get(k) or default
    dates = _resolve_validation_dates({**factory_settings, **fs})
    if dates.get("lastValidationDate"):
        fs["lastValidationDate"] = dates["lastValidationDate"]
    if dates.get("nextValidationDate"):
        fs["nextValidationDate"] = dates["nextValidationDate"]
    report_data["factorySettings"] = fs
    if str(report_data.get("type") or "").strip().lower() == "test":
        td = report_data.get("testData") if isinstance(report_data.get("testData"), dict) else report_data
        if isinstance(td, dict):
            td_remarks = td.get("remarks")
            if td_remarks not in (None, "") and not report_data.get("remarks"):
                report_data["remarks"] = td_remarks
        computed = compute_test_report_statistics(td if isinstance(td, dict) else None)
        if computed:
            report_data["statistics"] = computed
            if isinstance(report_data.get("testData"), dict):
                report_data["testData"]["statistics"] = computed
        recipe = report_data.get("recipe") if isinstance(report_data.get("recipe"), dict) else {}
        report_data["reportDerived"] = build_test_report_derived(
            td if isinstance(td, dict) else {},
            recipe,
            report_data.get("id"),
        )
    return report_data


def _parse_report_datetime(value: Any) -> Optional[datetime]:
    s = str(value or "").strip()
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None


def _parse_display_date(value: Any) -> Optional[datetime]:
    """Parse DD-MM-YYYY, DD/MM/YYYY, or ISO datetime strings."""
    s = str(value or "").strip()
    if not s or s.upper() == "N/A":
        return None
    for fmt in ("%d-%m-%Y", "%d/%m/%Y"):
        try:
            return datetime.strptime(s[:10], fmt)
        except Exception:
            continue
    return _parse_report_datetime(value)


def _add_years(dt: datetime, years: int = 1) -> datetime:
    """Add calendar years; Feb 29 rolls to Feb 28 on non-leap years."""
    try:
        return dt.replace(year=dt.year + int(years or 1))
    except ValueError:
        return dt.replace(month=2, day=28, year=dt.year + int(years or 1))


def _validation_dates_from_last(dt: datetime) -> Dict[str, str]:
    """Last validation date and next due exactly one calendar year later."""
    next_dt = _add_years(dt, 1)
    return {
        "lastValidationDate": dt.strftime("%d/%m/%Y"),
        "nextValidationDate": next_dt.strftime("%d/%m/%Y"),
    }


def _resolve_validation_dates(factory_settings: Optional[Dict[str, Any]] = None) -> Dict[str, str]:
    """Single source for validation dates: latest validation report, else stored last; next always +1 year."""
    computed = _compute_validation_dates_from_reports()
    if computed.get("lastValidationDate"):
        return computed
    fs = factory_settings or {}
    last_dt = _parse_display_date(fs.get("lastValidationDate"))
    if last_dt:
        return _validation_dates_from_last(last_dt)
    return {}


def sync_factory_validation_dates() -> Dict[str, str]:
    """Persist resolved validation dates into factory settings storage."""
    stored = data_service.get_factory_settings() or {}
    dates = _resolve_validation_dates(stored)
    if not dates:
        return {}
    updated = dict(stored)
    updated["lastValidationDate"] = dates["lastValidationDate"]
    updated["nextValidationDate"] = dates["nextValidationDate"]
    data_service.save_factory_settings(updated)
    return dates


def _compute_validation_dates_from_reports() -> Dict[str, str]:
    reports = data_service.list_reports("validation")
    latest_dt = None
    for report in reports or []:
        if str(report.get("type") or "").strip().lower() != "validation":
            continue
        td = report.get("testData") or {}
        status_raw = str(td.get("status") or report.get("status") or "").strip().lower()
        if status_raw == "aborted":
            continue
        dt = _parse_report_datetime(
            td.get("completedAt")
            or report.get("completedAt")
            or td.get("createdAt")
            or report.get("createdAt")
        )
        if not dt:
            continue
        if latest_dt is None or dt > latest_dt:
            latest_dt = dt
    if latest_dt is None:
        return {}
    return _validation_dates_from_last(latest_dt)


def get_report_preview_data(report: Dict[str, Any]) -> Dict[str, Any]:
    report = enrich_report_context(dict(report or {}))
    td = report.get("testData") or report
    remarks = report.get("remarks")
    if remarks is None and isinstance(td, dict):
        remarks = td.get("remarks")
    preview = {
        "id": report.get("id"),
        "type": report.get("type", "test"),
        "createdAt": report.get("createdAt"),
        "completedAt": report.get("completedAt"),
        "recipe": report.get("recipe", {}),
        "factorySettings": report.get("factorySettings", {}),
        "testData": report.get("testData", report),
        "statistics": report.get("statistics")
        or (td.get("statistics") if isinstance(td, dict) else {})
        or compute_test_report_statistics(td if isinstance(td, dict) else None)
        or {},
        "status": report.get("status", "PASS"),
        "remarks": remarks,
        "approvedBy": report.get("approvedBy"),
        "approvedByUsername": report.get("approvedByUsername"),
        "approvedByName": report.get("approvedByName"),
        "approvedAt": report.get("approvedAt"),
        "reportApprovalStatus": report.get("reportApprovalStatus"),
        "approvalPassFail": report.get("approvalPassFail"),
        "approvalRemarks": report.get("approvalRemarks"),
        "operatedByUsername": report.get("operatedByUsername")
        or (td.get("operatedByUsername") if isinstance(td, dict) else None)
        or (td.get("employeeId") if isinstance(td, dict) else None),
        "operatorName": report.get("operatorName")
        or (td.get("operatorName") if isinstance(td, dict) else None),
        "employeeId": report.get("employeeId")
        or (td.get("employeeId") if isinstance(td, dict) else None),
        "reportDerived": report.get("reportDerived")
        or build_test_report_derived(
            td if isinstance(td, dict) else {},
            report.get("recipe") if isinstance(report.get("recipe"), dict) else {},
            report.get("id"),
        ),
    }
    if report.get("type") == "validation":
        preview["validationSubtype"] = report.get("validationSubtype")
        preview["usp"] = report.get("usp")
        preview["setVacuumMmHg"] = report.get("setVacuumMmHg")
        preview["actualVacuumMmHg"] = report.get("actualVacuumMmHg")
        preview["setDurationSec"] = report.get("setDurationSec")
        preview["setDurationDisplay"] = report.get("setDurationDisplay")
        preview["actualDurationSec"] = report.get("actualDurationSec")
        preview["validationDurationSec"] = report.get("validationDurationSec")
        if isinstance(td, dict):
            for key in (
                "setVacuumMmHg",
                "actualVacuumMmHg",
                "setDurationSec",
                "setDurationDisplay",
                "actualDurationSec",
                "validationDurationSec",
            ):
                if preview.get(key) is None and td.get(key) is not None:
                    preview[key] = td.get(key)
        runs = report.get("validationRuns")
        if not runs and isinstance(td, dict):
            runs = td.get("validationRuns")
        if runs:
            preview["validationRuns"] = runs
            first = runs[0] if isinstance(runs[0], dict) else {}
            for key in (
                "setVacuumMmHg",
                "actualVacuumMmHg",
                "setDurationSec",
                "setDurationDisplay",
                "actualDurationSec",
                "validationDurationSec",
                "usp",
            ):
                if preview.get(key) is None and first.get(key) is not None:
                    preview[key] = first.get(key)
    # Friability-style monospace preview: thermal slip for screen; A4 text for wide print/PDF.
    try:
        import print_service

        preview["thermalText"] = print_service.format_for_thermal_printer(report).rstrip()
        preview["a4Text"] = print_service.format_for_a4_printer(report).rstrip()
    except Exception as exc:
        try:
            import logging
            logging.getLogger(__name__).exception("Failed to build report preview text: %s", exc)
        except Exception:
            pass
        preview["thermalText"] = ""
        preview["a4Text"] = ""
    return preview


def _html_esc(value: Any) -> str:
    if value is None or value == "":
        return "N/A"
    return html_module.escape(str(value))


def _format_report_ts(value: Any) -> str:
    s = str(value or "").strip()
    if not s:
        return "--"
    try:
        clean = s.replace("Z", "").strip()
        if "+" in clean:
            clean = clean.split("+", 1)[0].strip()
        if clean.count("-") > 2:
            clean = clean.rsplit("-", 1)[0].strip()
        dt = datetime.fromisoformat(clean)
        return dt.strftime("%d/%m/%Y %H:%M:%S")
    except Exception:
        return s


def _format_report_ts_parts(value: Any) -> Dict[str, str]:
    full = _format_report_ts(value)
    if full == "--":
        return {"date": "--", "time": "--"}
    parts = full.split(" ", 1)
    if len(parts) == 2:
        return {"date": parts[0], "time": parts[1]}
    return {"date": full, "time": "--"}


def _normalize_display_date_slash(value: Any) -> str:
    s = str(value or "").strip()
    if not s or s.upper() in ("N/A", "--"):
        return s or "N/A"
    for sep in ("-", "/"):
        bits = s[:10].split(sep)
        if len(bits) == 3 and all(bits):
            try:
                d, m, y = int(bits[0]), int(bits[1]), int(bits[2])
                if y < 100:
                    y += 2000
                return f"{d:02d}/{m:02d}/{y:04d}"
            except (TypeError, ValueError):
                pass
    return s


def _report_step_row_count(td: Dict[str, Any]) -> int:
    if not isinstance(td, dict):
        return 0
    results = td.get("stepResults") or []
    if isinstance(results, list) and results:
        return len(results)
    try:
        cs = int(td.get("completedSteps") or 0)
        return max(0, cs)
    except (TypeError, ValueError):
        return 0


def _statistics_table_html(preview: Dict[str, Any], td: Dict[str, Any]) -> str:
    if str(td.get("status") or "").strip().lower() == "aborted":
        return '<tr><td colspan="2">N/A</td></tr>'
    stats = preview.get("statistics") or td.get("statistics") or {}
    if not isinstance(stats, dict) or not stats:
        return '<tr><td colspan="2">N/A</td></tr>'
    rows = []
    for key, val in stats.items():
        if not isinstance(val, dict):
            continue
        display = _stat_display_value(val)
        if display is None:
            continue
        rows.append(
            "<tr><th>{}</th><td>{}</td></tr>".format(
                _html_esc(key), _html_esc(display)
            )
        )
    return "".join(rows) if rows else '<tr><td colspan="2">N/A</td></tr>'


def _fmt_mmss_html(sec: Any) -> str:
    try:
        t = max(0, int(round(float(sec))))
    except (TypeError, ValueError):
        return "--"
    return f"{t // 60:02d}:{t % 60:02d}"


def _validation_details_table_html(preview: Dict[str, Any]) -> str:
    td = preview.get("testData") if isinstance(preview.get("testData"), dict) else preview
    runs = preview.get("validationRuns")
    if not runs and isinstance(td, dict):
        runs = td.get("validationRuns")
    if (not runs) and isinstance(td, dict) and (
        td.get("setVacuumMmHg") is not None
        or preview.get("setVacuumMmHg") is not None
        or td.get("actualVacuumMmHg") is not None
    ):
        runs = [
            {
                "usp": td.get("usp") or preview.get("usp") or "Vacuum",
                "validationSubtype": td.get("validationSubtype") or preview.get("validationSubtype") or "distance",
                "setVacuumMmHg": td.get("setVacuumMmHg", preview.get("setVacuumMmHg")),
                "actualVacuumMmHg": td.get("actualVacuumMmHg", preview.get("actualVacuumMmHg")),
                "setDurationSec": td.get("setDurationSec", preview.get("setDurationSec")),
                "setDurationDisplay": td.get("setDurationDisplay", preview.get("setDurationDisplay")),
                "actualDurationSec": td.get("actualDurationSec", preview.get("actualDurationSec")),
                "validationDurationSec": td.get("validationDurationSec", preview.get("validationDurationSec")),
                "status": td.get("status") or preview.get("status"),
                "completedAt": td.get("completedAt") or preview.get("completedAt") or preview.get("createdAt"),
            }
        ]
    rows = []
    if isinstance(runs, list) and runs:
        for run in runs:
            if not isinstance(run, dict):
                continue
            usp = run.get("usp") or ("Pressure Decay" if run.get("validationSubtype") == "load" else "Vacuum Decay")
            date_str = _format_report_ts(run.get("completedAt") or preview.get("completedAt") or preview.get("createdAt"))
            set_vac = run.get("setVacuumMmHg", "--")
            act_vac = run.get("actualVacuumMmHg", "--")
            set_time = run.get("setDurationDisplay")
            if set_time in (None, ""):
                sec = run.get("setDurationSec")
                if sec is None:
                    sec = run.get("validationDurationSec")
                set_time = _fmt_mmss_html(sec) if sec is not None else "--"
            act_sec = run.get("actualDurationSec")
            act_time = _fmt_mmss_html(act_sec) if act_sec is not None else "--"
            status = run.get("status", "--")
            rows.append('<tr><th colspan="4" class="usp-hdr">{} validation</th></tr>'.format(_html_esc(usp)))
            rows.append('<tr><th>Date / Time</th><td colspan="3">{}</td></tr>'.format(_html_esc(date_str)))
            rows.append(
                "<tr><th>Method</th><td>{}</td><th>Status</th><td>{}</td></tr>".format(
                    _html_esc(usp), _html_esc(status)
                )
            )
            rows.append(
                "<tr><th>Set Vacuum (mmHg)</th><td>{}</td><th>Actual Vacuum (mmHg)</th><td>{}</td></tr>".format(
                    _html_esc(set_vac), _html_esc(act_vac)
                )
            )
            rows.append(
                "<tr><th>Set Time</th><td>{}</td><th>Actual Time</th><td>{}</td></tr>".format(
                    _html_esc(set_time), _html_esc(act_time)
                )
            )
    return "".join(rows) if rows else '<tr><td colspan="4">No validation data</td></tr>'


def _derived_summary_html(derived: Dict[str, Any]) -> str:
    if not isinstance(derived, dict):
        return ""
    total_taps = derived.get("totalTaps")
    total_taps_str = str(total_taps) if total_taps is not None else "--"
    return (
        '<h3>TEST SUMMARY</h3>'
        '<table class="ident">'
        '<tr><th>Sample Weight (g)</th><td>{w}</td><th>Total No. of Drops</th><td>{drops}</td></tr>'
        '<tr><th>Target Vacuum (V₀) (ml)</th><td>{v0}</td><th>Diff. of Last Two Volumes (ml)</th><td>{diff}</td></tr>'
        '</table>'
    ).format(
        w=_html_esc(_format_derived_number(derived.get("sampleWeightG"), 2)),
        drops=_html_esc(total_taps_str),
        v0=_html_esc(_format_derived_number(derived.get("initialVolumeMl"), 4)),
        diff=_html_esc(_format_derived_number(derived.get("diffLastTwoVolumesMl"), 4)),
    )


def _derived_test_result_html(derived: Dict[str, Any]) -> str:
    if not isinstance(derived, dict):
        return ""
    return (
        '<h3>TEST RESULT</h3>'
        '<table class="ident">'
        '<tr><th>Final Volume (Vf) (ml)</th><td>{vf}</td>'
        '<th>Initial Density (W/V₀) (g/mL)</th><td>{id}</td></tr>'
        '<tr><th>Tapped Density (W/Vf) (g/mL)</th><td>{td}</td>'
        '<th>Compressibility Index (%)</th><td>{ci}</td></tr>'
        '<tr><th>Hausner Ratio (V₀/Vf)</th><td colspan="3">{hr}</td></tr>'
        '</table>'
    ).format(
        vf=_html_esc(_format_derived_number(derived.get("finalVolumeMl"), 4)),
        id=_html_esc(_format_derived_number(derived.get("initialDensityGPerMl"), 3)),
        td=_html_esc(_format_derived_number(derived.get("tappedDensityGPerMl"), 3)),
        ci=_html_esc(_format_derived_number(derived.get("compressibilityIndexPct"), 2)),
        hr=_html_esc(_format_derived_number(derived.get("hausnerRatio"), 3)),
    )


def _report_status_display_label(preview: Dict[str, Any], td: Dict[str, Any] = None) -> str:
    """Canonical status for PDF/print: aborted never becomes Completed."""
    if not isinstance(preview, dict):
        preview = {}
    if not isinstance(td, dict):
        td = preview.get("testData") if isinstance(preview.get("testData"), dict) else {}
    raw = td.get("status")
    if raw in (None, ""):
        raw = preview.get("status")
    s = str(raw or "").strip()
    low = s.lower()
    rtype = str(preview.get("type") or "test").strip().lower()
    if low == "aborted":
        return "Aborted"
    if rtype == "validation":
        if low == "pass":
            return "Pass"
        if low == "fail":
            return "Fail"
        return s or "--"
    if rtype == "calibration":
        if not s or low == "completed":
            return "Completed"
        return s[:1].upper() + s[1:] if s else "Completed"
    return "Completed"


def build_report_pdf_html(report: Dict[str, Any]) -> str:
    """Build a self-contained HTML document for PDF rendering (server-side)."""
    preview = get_report_preview_data(report)
    rtype = str(preview.get("type") or "test").strip().lower()
    td = preview.get("testData") if isinstance(preview.get("testData"), dict) else {}
    recipe = preview.get("recipe") if isinstance(preview.get("recipe"), dict) else {}
    fs = preview.get("factorySettings") if isinstance(preview.get("factorySettings"), dict) else {}
    approval_st = str(preview.get("reportApprovalStatus") or "").strip().lower()
    is_aborted = (
        approval_st == "aborted"
        or str(td.get("status") or preview.get("status") or "").strip().lower() == "aborted"
    )
    is_approved = approval_st == "approved"

    status_label = _report_status_display_label(preview, td)
    start_parts = _format_report_ts_parts(td.get("testStartTime") or preview.get("createdAt"))
    end_parts = _format_report_ts_parts(
        td.get("testEndTime") or preview.get("completedAt") or preview.get("createdAt")
    )
    start_ts = _format_report_ts(td.get("testStartTime") or preview.get("createdAt"))
    end_ts = _format_report_ts(td.get("testEndTime") or preview.get("completedAt") or preview.get("createdAt"))

    remarks = preview.get("remarks") or td.get("remarks") or "N/A"
    remarks_heading = "Abort remarks" if is_aborted else "Remarks"
    if is_approved:
        appr_result = preview.get("approvalPassFail") or "--"
        appr_remarks = preview.get("approvalRemarks")
        appr_remarks_disp = appr_remarks if appr_remarks not in (None, "") else "N/A"
    else:
        appr_result = "N/A"
        appr_remarks_disp = "N/A"

    try:
        from print_service import _report_brand_title, _approver_name_and_id, _hold_release_total_fields
        title = _report_brand_title(rtype)
        appr_name, appr_id = _approver_name_and_id(preview, td)
        dur_fields = _hold_release_total_fields(td, recipe, fs)
    except Exception:
        title = "LEAK TEST APPARATUS TEST REPORT"
        if rtype == "validation":
            title = "LEAK TEST APPARATUS VALIDATION REPORT"
        elif rtype == "calibration":
            title = "LEAK TEST APPARATUS CALIBRATION REPORT"
        appr_name = preview.get("approvedByName") or (str(preview.get("approvedBy") or "").split("(")[0].strip() or "--")
        appr_id = preview.get("approvedByUsername") or "--"
        dur_fields = {"total": "--", "hold": "--", "release": "--"}
    if not is_approved:
        appr_name = "N/A"
        appr_id = "N/A"

    pts = _report_print_timestamp()
    pdate = _normalize_display_date_slash(
        (preview.get("reportDerived") or {}).get("printDate") or pts.get("printDate")
    )
    ptime = (preview.get("reportDerived") or {}).get("printTime") or pts.get("printTime")

    if rtype == "validation":
        val_section = (
            '<h3>VALIDATION DETAILS</h3>'
            '<table class="ident"><tbody>{}</tbody></table>'
        ).format(_validation_details_table_html(preview))
        test_section = ""
    else:
        val_section = ""
        set_vac = td.get("setVacuumMmHg")
        if set_vac in (None, ""):
            set_vac = recipe.get("vacuumMmHg")
        result_val = td.get("result") or "--"

        vacuum_samples = td.get("vacuumSamples") or []
        samples_html = ""
        if isinstance(vacuum_samples, list) and vacuum_samples:
            sample_rows = []
            for s in vacuum_samples:
                if not isinstance(s, dict):
                    continue
                pct = s.get("percent")
                try:
                    t = int(float(s.get("elapsedSec")))
                    t_disp = s.get("timeDisplay") or "{:02d}:{:02d}".format(t // 60, t % 60)
                except (TypeError, ValueError):
                    t_disp = s.get("timeDisplay") or "--"
                try:
                    vac_s = "{:.1f}".format(float(s.get("vacuumMmHg"))) if s.get("vacuumMmHg") not in (None, "") else "--"
                except (TypeError, ValueError):
                    vac_s = str(s.get("vacuumMmHg") or "--")
                pct_disp = "{}%".format(pct) if pct not in (None, "") else "--"
                sample_rows.append(
                    "<tr><td>{pct} / {t}</td><td>{v}</td></tr>".format(
                        pct=_html_esc(pct_disp),
                        t=_html_esc(t_disp),
                        v=_html_esc(vac_s),
                    )
                )
            if sample_rows:
                samples_html = (
                    '<h3>HOLD VACUUM SAMPLES</h3>'
                    '<table class="ident">'
                    '<tr><th>Time (% / mm:ss)</th><th>Vacuum (mmHg)</th></tr>'
                    + "".join(sample_rows)
                    + "</table>"
                )

        ar_nums = td.get("analysisReportNo") or recipe.get("analysisReportNo")
        if ar_nums in (None, ""):
            legacy = td.get("arNumbers") or recipe.get("arNumbers") or []
            if isinstance(legacy, list) and legacy:
                ar_nums = legacy[0]
            elif legacy not in (None, "", []):
                ar_nums = legacy
        ar_disp = str(ar_nums).strip() if ar_nums not in (None, "") else ""
        batch_size = td.get("batchSize")
        if batch_size in (None, ""):
            batch_size = recipe.get("batchSize")

        if rtype == "calibration":
            test_section = (
                '<h3>CALIBRATION DETAILS</h3>'
                '<table class="ident">'
                '<tr><th>Set Vacuum (mmHg)</th><td>{set_vac}</td><th>Calibration Value</th><td>{calib}</td></tr>'
                '<tr><th>Status</th><td colspan="3">{status}</td></tr>'
                '</table>'
                '<div class="remarks"><strong>{remarks_heading}:</strong> {remarks}</div>'
            ).format(
                remarks_heading=_html_esc(remarks_heading),
                set_vac=_html_esc(set_vac if set_vac not in (None, "") else "--"),
                calib=_html_esc(td.get("calibValue") if td.get("calibValue") not in (None, "") else td.get("actualVacuumMmHg") or "--"),
                status=_html_esc(status_label),
                remarks=_html_esc(remarks),
            )
        else:
            test_section = (
                '<h3>TEST INFORMATION</h3>'
                '<table class="ident">'
                '<tr><th>Product Name</th><td>{prod}</td><th>Batch No</th><td>{batch}</td></tr>'
                '<tr><th>Batch Size</th><td>{bsize}</td><th>Analysis Report No.</th><td>{ar}</td></tr>'
                '<tr><th>Operator</th><td>{op}</td><th>Test Status</th><td>{status}</td></tr>'
                '<tr><th>Start Date</th><td>{start_date}</td><th>Start Time</th><td>{start_time}</td></tr>'
                '<tr><th>Test Completed Date</th><td>{end_date}</td><th>Test Completed Time</th><td>{end_time}</td></tr>'
                '</table>'
                '<h3>TEST RESULT</h3>'
                '<table class="ident">'
                '<tr><th>Set Vacuum (mmHg)</th><td colspan="3">{set_vac}</td></tr>'
                '<tr><th>Total Duration (mm:ss)</th><td>{total}</td><th>Hold Duration (mm:ss)</th><td>{hold}</td></tr>'
                '<tr><th>Result</th><td colspan="3">{result}</td></tr>'
                '</table>'
                '{samples}'
                '<div class="remarks"><strong>{remarks_heading}:</strong> {remarks}</div>'
            ).format(
                remarks_heading=_html_esc(remarks_heading),
                op=_html_esc(preview.get("operatorName") or td.get("operatorName")),
                prod=_html_esc(recipe.get("productName") or td.get("productName")),
                batch=_html_esc(recipe.get("batchNumber") or td.get("batchNumber")),
                bsize=_html_esc(batch_size if batch_size not in (None, "") else "--"),
                ar=_html_esc(ar_disp or "--"),
                start_date=_html_esc(start_parts.get("date") or "--"),
                start_time=_html_esc(start_parts.get("time") or "--"),
                end_date=_html_esc(end_parts.get("date") or "--"),
                end_time=_html_esc(end_parts.get("time") or "--"),
                status=_html_esc(status_label),
                set_vac=_html_esc(set_vac if set_vac not in (None, "") else "--"),
                total=_html_esc(dur_fields.get("total") or "--"),
                hold=_html_esc(dur_fields.get("hold") or "--"),
                result=_html_esc(result_val),
                samples=samples_html,
                remarks=_html_esc(remarks),
            )

    body = (
        '<div class="doc">'
        '<h1>{title}</h1>'
        '<table class="ident">'
        '<tr><th>Company</th><td>{company}</td><th>Model No</th><td>{model}</td></tr>'
        '<tr><th>Serial No</th><td>{serial}</td><th>Location</th><td>{loc}</td></tr>'
        '<tr><th>Instrument ID</th><td>{inst}</td><th>Last Validation</th><td>{lastv}</td></tr>'
        '<tr><th>Next Validation</th><td colspan="3">{nextv}</td></tr>'
        '</table>'
        '{val}'
        '{test}'
        '<h3>APPROVAL</h3>'
        '<table class="ident">'
        '<tr><th>Operated by</th><td>{op}</td><th>Employee ID</th><td>{emp}</td></tr>'
        '<tr><th>Approval Result</th><td>{appr}</td><th>Approver Name</th><td>{appr_name}</td></tr>'
        '<tr><th>Approver User ID</th><td>{appr_id}</td><th>Approval Remarks</th><td>{appr_rem}</td></tr>'
        '</table>'
        '<table class="ident" style="margin-top:12px;">'
        '<tr><th>Print Date</th><td>{pdate}</td><th>Print Time</th><td>{ptime}</td></tr>'
        '</table>'
        '</div>'
    ).format(
        title=_html_esc(title),
        company=_html_esc(fs.get("companyName")),
        model=_html_esc(fs.get("modelNo")),
        serial=_html_esc(fs.get("serialNo")),
        pdate=_html_esc(pdate),
        ptime=_html_esc(ptime),
        loc=_html_esc(fs.get("companyLocation") or fs.get("location")),
        inst=_html_esc(fs.get("instrumentId")),
        lastv=_html_esc(_normalize_display_date_slash(fs.get("lastValidationDate"))),
        nextv=_html_esc(_normalize_display_date_slash(fs.get("nextValidationDate"))),
        val=val_section,
        test=test_section,
        op=_html_esc(preview.get("operatorName") or td.get("operatorName")),
        emp=_html_esc(preview.get("employeeId") or td.get("employeeId")),
        appr=_html_esc(appr_result),
        appr_name=_html_esc(appr_name),
        appr_id=_html_esc(appr_id),
        appr_rem=_html_esc(appr_remarks_disp),
    )

    css = (
        "body{font-family:Arial,sans-serif;font-size:11pt;color:#000;margin:12px;}"
        "h1{font-size:14pt;text-align:center;margin:0 0 8px;}"
        "h2{font-size:12pt;text-align:center;margin:0 0 12px;}"
        "h3{font-size:11pt;margin:14px 0 6px;border-bottom:1px solid #333;}"
        "table{width:100%;border-collapse:collapse;margin-bottom:10px;}"
        "th,td{border:1px solid #333;padding:4px 6px;text-align:left;vertical-align:top;}"
        "th{background:#e8e8e8;}"
        ".usp-hdr{background:#e8e8e8;font-weight:bold;}"
        ".remarks{margin:12px 0;padding:8px;border:1px solid #333;}"
    )
    return (
        '<!doctype html><html><head><meta charset="utf-8"><title>Report</title>'
        '<style>{}</style></head><body>{}</body></html>'
    ).format(css, body)



def create_pdf_report(report_data: Dict[str, Any], template_type: str = "standard") -> Optional[pathlib.Path]:
    try:
        timestamp = datetime.now().strftime("%Y%m%dT%H%M%S")
        recipe_name = report_data.get("recipe", {}).get("productName", "report")
        safe_name = "".join(c for c in recipe_name if c.isalnum() or c in "-_")
        filename = f"{safe_name}_{timestamp}.json"
        pdf_path = _reports_dir / filename
        with open(pdf_path, "w", encoding="utf-8") as f:
            json.dump(report_data, f, indent=2, ensure_ascii=False)
        return pdf_path
    except Exception:
        return None


def export_reports_to_usb(report_ids: List[int], export_path: str) -> Dict[str, Any]:
    try:
        export_dir = pathlib.Path(export_path)
        export_dir.mkdir(parents=True, exist_ok=True)
        exported_files = []
        for report_id in report_ids:
            report = data_service.get_report(report_id)
            if not report:
                continue
            timestamp = report.get("createdAt", datetime.now().strftime("%Y-%m-%dT%H:%M:%S"))
            safe_ts = "".join(c for c in str(timestamp) if c.isalnum() or c in "-_.T")
            recipe_name = report.get("recipe", {}).get("productName", "report")
            safe_name = "".join(c for c in recipe_name if c.isalnum() or c in "-_")
            filename = f"{safe_name}_{report_id}_{safe_ts}.json"
            export_file = export_dir / filename
            with open(export_file, "w", encoding="utf-8") as f:
                json.dump(report, f, indent=2, ensure_ascii=False)
            exported_files.append(str(export_file))
        return {"success": True, "exported_files": exported_files, "count": len(exported_files)}
    except Exception as e:
        return {"success": False, "error": str(e)}
