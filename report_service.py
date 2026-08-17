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
            "printDate": now.strftime("%d-%m-%Y"),
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
        "lastValidationDate": dt.strftime("%d-%m-%Y"),
        "nextValidationDate": next_dt.strftime("%d-%m-%Y"),
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
        preview["tapsMin"] = report.get("tapsMin")
        preview["dropHeight"] = report.get("dropHeight")
        preview["expectedTapCount"] = report.get("expectedTapCount")
        preview["actualTapCount"] = report.get("actualTapCount")
        runs = report.get("validationRuns")
        if not runs and isinstance(td, dict):
            runs = td.get("validationRuns")
        if runs:
            preview["validationRuns"] = runs
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


def _validation_details_table_html(preview: Dict[str, Any]) -> str:
    td = preview.get("testData") if isinstance(preview.get("testData"), dict) else preview
    runs = preview.get("validationRuns")
    if not runs and isinstance(td, dict):
        runs = td.get("validationRuns")
    rows = []
    if isinstance(runs, list) and runs:
        for run in runs:
            if not isinstance(run, dict):
                continue
            usp = run.get("usp") or ("Pressure Decay" if run.get("validationSubtype") == "load" else "Vacuum Decay")
            date_str = _format_report_ts(run.get("completedAt") or preview.get("completedAt") or preview.get("createdAt"))
            taps_min = run.get("tapsMin", "--")
            drop_h = run.get("dropHeight", "--")
            expected = run.get("expectedTapCount", "--")
            tol = run.get("expectedTolerance")
            expected_disp = (
                "{} (+/- {})".format(expected, tol)
                if tol is not None and expected not in (None, "", "--")
                else expected
            )
            actual = run.get("actualTapCount", "--")
            status = run.get("status", "--")
            rows.append('<tr><th colspan="4" class="usp-hdr">{} validation</th></tr>'.format(_html_esc(usp)))
            rows.append('<tr><th>Date / Time</th><td colspan="3">{}</td></tr>'.format(_html_esc(date_str)))
            rows.append(
                "<tr><th>USP</th><td>{}</td><th>mbar/s</th><td>{}</td></tr>".format(
                    _html_esc(usp), _html_esc(taps_min)
                )
            )
            rows.append(
                "<tr><th>Target Vacuum (mm)</th><td>{}</td><th>Status</th><td>{}</td></tr>".format(
                    _html_esc(drop_h), _html_esc(status)
                )
            )
            rows.append(
                "<tr><th>Expected Hold Time</th><td>{}</td><th>Actual Hold Time</th><td>{}</td></tr>".format(
                    _html_esc(expected_disp), _html_esc(actual)
                )
            )
    elif isinstance(td, dict):
        date_str = _format_report_ts(td.get("completedAt") or preview.get("completedAt") or preview.get("createdAt"))
        usp = td.get("usp") or preview.get("usp") or "--"
        taps_min = td.get("tapsMin", preview.get("tapsMin", "--"))
        drop_h = td.get("dropHeight", preview.get("dropHeight", "--"))
        expected = td.get("expectedTapCount", preview.get("expectedTapCount", "--"))
        tol = td.get("expectedTolerance", preview.get("expectedTolerance"))
        expected_disp = (
            "{} (+/- {})".format(expected, tol)
            if tol is not None and expected not in (None, "", "--")
            else expected
        )
        actual = td.get("actualTapCount", preview.get("actualTapCount", "--"))
        status = td.get("status") or preview.get("status") or "--"
        rows.append('<tr><th>Date / Time</th><td colspan="3">{}</td></tr>'.format(_html_esc(date_str)))
        rows.append(
            "<tr><th>USP</th><td>{}</td><th>mbar/s</th><td>{}</td></tr>".format(
                _html_esc(usp), _html_esc(taps_min)
            )
        )
        rows.append(
            "<tr><th>Target Vacuum (mm)</th><td>{}</td><th>Status</th><td>{}</td></tr>".format(
                _html_esc(drop_h), _html_esc(status)
            )
        )
        rows.append(
            "<tr><th>Expected Hold Time</th><td>{}</td><th>Actual Hold Time</th><td>{}</td></tr>".format(
                _html_esc(expected_disp), _html_esc(actual)
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
        or str(td.get("status") or "").strip().lower() == "aborted"
    )
    is_approved = approval_st == "approved"

    status_raw = str(td.get("status") or "").strip().lower()
    status_label = "Aborted" if status_raw == "aborted" else "Completed"
    start_ts = _format_report_ts(td.get("testStartTime") or preview.get("createdAt"))
    end_ts = _format_report_ts(td.get("testEndTime") or preview.get("completedAt") or preview.get("createdAt"))
    duration_str = format_duration_hhmmss(test_duration_seconds(td))

    remarks = preview.get("remarks") or td.get("remarks") or "N/A"
    remarks_heading = "Abort remarks" if is_aborted else "Remarks"
    if is_approved:
        appr_result = preview.get("approvalPassFail") or "--"
        appr_by = preview.get("approvedBy") or "--"
        appr_remarks = preview.get("approvalRemarks")
        appr_remarks_disp = appr_remarks if appr_remarks not in (None, "") else "N/A"
    else:
        appr_result = "N/A"
        appr_by = "N/A"
        appr_remarks_disp = "N/A"

    if rtype == "validation":
        val_section = (
            '<h3>VALIDATION DETAILS</h3>'
            '<table class="ident"><tbody>{}</tbody></table>'
        ).format(_validation_details_table_html(preview))
        test_section = ""
    else:
        val_section = ""

        def _fmt_mmss(total):
            try:
                t = int(float(total))
            except (TypeError, ValueError):
                return None
            if t < 0:
                t = 0
            return "{:02d}:{:02d}".format(t // 60, t % 60)

        set_vac = td.get("setVacuumMmHg")
        if set_vac in (None, ""):
            set_vac = recipe.get("vacuumMmHg")
        act_vac = td.get("actualVacuumMmHg")
        set_dur = td.get("setDurationDisplay") or _fmt_mmss(td.get("setDurationSec"))
        if not set_dur:
            set_dur = recipe.get("durationDisplay") or _fmt_mmss(recipe.get("durationSec"))
        act_dur = td.get("actualDurationDisplay") or _fmt_mmss(td.get("actualDurationSec"))
        result_val = td.get("result") or "--"

        try:
            act_vac_disp = "{:.1f}".format(float(act_vac)) if act_vac not in (None, "") else "--"
        except (TypeError, ValueError):
            act_vac_disp = str(act_vac) if act_vac not in (None, "") else "--"

        vacuum_samples = td.get("vacuumSamples") or []
        samples_html = ""
        if isinstance(vacuum_samples, list) and vacuum_samples:
            sample_rows = []
            for s in vacuum_samples:
                if not isinstance(s, dict):
                    continue
                pct = s.get("percent")
                t_disp = s.get("timeDisplay") or _fmt_mmss(s.get("elapsedSec")) or "--"
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

        pts = _report_print_timestamp()
        test_section = (
            '<h3>TEST INFORMATION</h3>'
            '<table class="ident">'
            '<tr><th>Print Date</th><td>{pdate}</td><th>Print Time</th><td>{ptime}</td></tr>'
            '<tr><th>Product Name</th><td>{prod}</td><th>Batch No</th><td>{batch}</td></tr>'
            '<tr><th>Batch Size</th><td>{bsize}</td><th>Analysis Report No.</th><td>{ar}</td></tr>'
            '<tr><th>Operator</th><td>{op}</td><th>Test Start</th><td>{start}</td></tr>'
            '<tr><th>Completed Date / Time</th><td colspan="3">{end}</td></tr>'
            '<tr><th>Duration</th><td>{dur}</td><th>Test Status</th><td>{status}</td></tr>'
            '</table>'
            '<h3>TEST RESULT</h3>'
            '<table class="ident">'
            '<tr><th>Set Vacuum (mmHg)</th><td>{set_vac}</td><th>Actual Vacuum (mmHg)</th><td>{act_vac}</td></tr>'
            '<tr><th>Set Duration (mm:ss)</th><td>{set_dur}</td><th>Actual Duration (mm:ss)</th><td>{act_dur}</td></tr>'
            '<tr><th>Result</th><td colspan="3">{result}</td></tr>'
            '</table>'
            '{samples}'
            '<div class="remarks"><strong>{remarks_heading}:</strong> {remarks}</div>'
        ).format(
            remarks_heading=_html_esc(remarks_heading),
            pdate=_html_esc(pts.get("printDate")),
            ptime=_html_esc(pts.get("printTime")),
            op=_html_esc(preview.get("operatorName") or td.get("operatorName")),
            prod=_html_esc(recipe.get("productName") or td.get("productName")),
            batch=_html_esc(recipe.get("batchNumber") or td.get("batchNumber")),
            bsize=_html_esc(batch_size if batch_size not in (None, "") else "--"),
            ar=_html_esc(ar_disp or "--"),
            start=_html_esc(start_ts),
            end=_html_esc(end_ts),
            dur=_html_esc(duration_str),
            status=_html_esc(status_label),
            set_vac=_html_esc(set_vac if set_vac not in (None, "") else "--"),
            act_vac=_html_esc(act_vac_disp),
            set_dur=_html_esc(set_dur or "--"),
            act_dur=_html_esc(act_dur or "--"),
            result=_html_esc(result_val),
            samples=samples_html,
            remarks=_html_esc(remarks),
        )

    title = "LEAK TEST VALIDATION REPORT" if rtype == "validation" else "LEAK TEST REPORT"
    if is_aborted:
        title_note = " (ABORTED)"
    elif is_approved:
        title_note = ""
    else:
        title_note = ""

    body = (
        '<div class="doc">'
        '<h1>{title}{note}</h1>'
        '<h2>{company}</h2>'
        '<table class="ident">'
        '<tr><th>Model No</th><td>{model}</td><th>Serial No</th><td>{serial}</td></tr>'
        '<tr><th>Print Date</th><td>{pdate}</td><th>Print Time</th><td>{ptime}</td></tr>'
        '<tr><th>Location</th><td>{loc}</td><th>Instrument ID</th><td>{inst}</td></tr>'
        '<tr><th>Last Validation</th><td>{lastv}</td><th>Next Validation</th><td>{nextv}</td></tr>'
        '</table>'
        '{val}'
        '{test}'
        '<h3>APPROVAL</h3>'
        '<table class="ident">'
        '<tr><th>Operated by</th><td>{op}</td><th>Employee ID</th><td>{emp}</td></tr>'
        '<tr><th>Approval Result</th><td>{appr}</td><th>Approved By</th><td>{by}</td></tr>'
        '<tr><th>Approval Remarks</th><td colspan="3">{appr_rem}</td></tr>'
        '</table>'
        '</div>'
    ).format(
        title=_html_esc(title),
        note=title_note,
        company=_html_esc(fs.get("companyName")),
        model=_html_esc(fs.get("modelNo")),
        serial=_html_esc(fs.get("serialNo")),
        pdate=_html_esc(
            (preview.get("reportDerived") or {}).get("printDate")
            or _report_print_timestamp().get("printDate")
        ),
        ptime=_html_esc(
            (preview.get("reportDerived") or {}).get("printTime")
            or _report_print_timestamp().get("printTime")
        ),
        loc=_html_esc(fs.get("companyLocation") or fs.get("location")),
        inst=_html_esc(fs.get("instrumentId")),
        lastv=_html_esc(fs.get("lastValidationDate")),
        nextv=_html_esc(fs.get("nextValidationDate")),
        val=val_section,
        test=test_section,
        op=_html_esc(preview.get("operatorName") or td.get("operatorName")),
        emp=_html_esc(preview.get("employeeId") or td.get("employeeId")),
        appr=_html_esc(appr_result),
        by=_html_esc(appr_by),
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
