 #!/usr/bin/env python3
"""
app.py - Flask application for Leak Test
Serves static files and REST API for data, auth, audit, reports, and print.
"""

import json
import os
import pathlib
import secrets
import atexit
import signal
import subprocess
import sys
import time
import threading
from datetime import datetime, timedelta
from typing import Optional
from flask import Flask, jsonify, request, send_from_directory, Response, stream_with_context

try:
    from flask_cors import CORS
except ImportError:
    CORS = None

import data_service
import rbac_service
import audit_service
import calculation_service
import report_service
import print_service
import hardware_service
import biometric_service
import rtc_service
import usb_export
import network_service
import pdf_generator

# ======================= CONFIG ==========================

APP_ROOT = pathlib.Path(os.environ.get("APP_ROOT", os.path.dirname(os.path.abspath(__file__))))
INTERNAL_USB_PATH = pathlib.Path(os.environ.get("INTERNAL_USB_PATH", "/media/usb_internal"))


def _default_storage_dir() -> pathlib.Path:
    """Prefer internal USB (sda1 at /media/usb_internal) when mounted; else APP_ROOT/storage."""
    if os.environ.get("STORAGE_DIR"):
        return pathlib.Path(os.environ["STORAGE_DIR"])
    if INTERNAL_USB_PATH.is_dir():
        return INTERNAL_USB_PATH / "storage"
    return APP_ROOT / "storage"


def _default_reports_dir() -> pathlib.Path:
    """Prefer internal USB when mounted; else APP_ROOT/reports."""
    if os.environ.get("REPORTS_DIR"):
        return pathlib.Path(os.environ["REPORTS_DIR"])
    if INTERNAL_USB_PATH.is_dir():
        return INTERNAL_USB_PATH / "reports"
    return APP_ROOT / "reports"


def _default_audit_db_dir() -> pathlib.Path:
    """Audit SQLite DB: sibling of storage/ on internal USB, else APP_ROOT/db."""
    if os.environ.get("AUDIT_DB_DIR"):
        return pathlib.Path(os.environ["AUDIT_DB_DIR"])
    if INTERNAL_USB_PATH.is_dir():
        return INTERNAL_USB_PATH / "db"
    return APP_ROOT / "db"


STORAGE_DIR = _default_storage_dir()
REPORTS_DIR = _default_reports_dir()
AUDIT_DB_DIR = _default_audit_db_dir()
EXPORT_USB_PATH = os.environ.get("EXPORT_USB_PATH", str(APP_ROOT / "export"))
ESP_PORT = os.environ.get("ESP_PORT", "/dev/serial0")
ESP_BAUD = int(os.environ.get("ESP_BAUD", "9600"))
BIOMETRIC_PORT = os.environ.get("BIOMETRIC_PORT", "/dev/ttyAMA5")
BIOMETRIC_BAUD = int(os.environ.get("BIOMETRIC_BAUD", "57600"))
BIOMETRIC_ENROLL_TIMEOUT_SEC = float(os.environ.get("BIOMETRIC_ENROLL_TIMEOUT_SEC", "120"))
BIOMETRIC_LOGIN_TIMEOUT_SEC = float(os.environ.get("BIOMETRIC_LOGIN_TIMEOUT_SEC", "30"))
BIOMETRIC_MOCK = os.environ.get("BIOMETRIC_MOCK", "0")
BIOMETRIC_MOCK_TEMPLATE_ID = os.environ.get("BIOMETRIC_MOCK_TEMPLATE_ID", "1")
BIOMETRIC_MOCK_SEED = os.environ.get("BIOMETRIC_MOCK_SEED", "")
FLASK_HOST = os.environ.get("FLASK_HOST", "127.0.0.1")
FLASK_PORT = int(os.environ.get("FLASK_PORT", "5000"))
EXPORT_SUBFOLDER = "LeakTest-Reports-Exported"
DATETIME_STORAGE = STORAGE_DIR / "datetime.json"
APPROVAL_VERIFY_TTL_SECONDS = int(os.environ.get("APPROVAL_VERIFY_TTL_SECONDS", "180"))

# ==========================================================

app = Flask(__name__)
if CORS:
    CORS(app)

try:
    STORAGE_DIR.mkdir(parents=True, exist_ok=True)
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    AUDIT_DB_DIR.mkdir(parents=True, exist_ok=True)
except Exception:
    pass

config = {
    "APP_ROOT": APP_ROOT,
    "STORAGE_DIR": STORAGE_DIR,
    "REPORTS_DIR": REPORTS_DIR,
    "AUDIT_DB_DIR": AUDIT_DB_DIR,
    "A4_PORT": os.environ.get("A4_PORT", "/dev/ttyAMA4"),
    "A4_BAUD": int(os.environ.get("A4_BAUD", "9600")),
    "THERMAL_PORT": os.environ.get("THERMAL_PORT", "/dev/ttyAMA3"),
    "THERMAL_BAUD": int(os.environ.get("THERMAL_BAUD", "9600")),
    "ESP_PORT": ESP_PORT,
    "ESP_BAUD": ESP_BAUD,
    "UART_LOG_PATH": os.environ.get("UART_LOG_PATH", str(APP_ROOT / "uart_communications.log")),
    "BIOMETRIC_PORT": BIOMETRIC_PORT,
    "BIOMETRIC_BAUD": BIOMETRIC_BAUD,
    "BIOMETRIC_ENROLL_TIMEOUT_SEC": BIOMETRIC_ENROLL_TIMEOUT_SEC,
    "BIOMETRIC_LOGIN_TIMEOUT_SEC": BIOMETRIC_LOGIN_TIMEOUT_SEC,
    "BIOMETRIC_MOCK": BIOMETRIC_MOCK,
    "BIOMETRIC_MOCK_TEMPLATE_ID": BIOMETRIC_MOCK_TEMPLATE_ID,
    "BIOMETRIC_MOCK_SEED": BIOMETRIC_MOCK_SEED,
}

data_service.init(config)
audit_service.init(config)
calculation_service.init()
report_service.init(config)
print_service.init(config)
hardware_service.init(app, config)

_enroll_sessions = {}
_enroll_sessions_lock = threading.Lock()

biometric_service.init(app, config)
rtc_service.init(app.logger)
rtc_service.schedule_rtc_startup_sync()

import logging as _logging

_cfg_log = _logging.getLogger(__name__)
_cfg_log.info(
    "[CONFIG] INTERNAL_USB_PATH=%s STORAGE_DIR=%s REPORTS_DIR=%s AUDIT_DB_DIR=%s",
    INTERNAL_USB_PATH,
    STORAGE_DIR,
    REPORTS_DIR,
    AUDIT_DB_DIR,
)


def _audit(user, role, action, details=""):
    """Helper to log audit event (user/role from current user if not passed)."""
    u = user
    r = role
    if u is None or r is None:
        cur = data_service.get_current_user()
        if cur:
            u = u if u is not None else cur.get("username") or cur.get("name") or "--"
            r = r if r is not None else cur.get("role") or "--"
    audit_time = _audit_time_fields()
    audit_service.log_structured_event(
        user=u,
        role=r,
        action=action,
        details=details,
        event_type="legacy",
        outcome="success" if action else "",
        timestamp_ms=audit_time.get("timestamp_ms"),
        date_time=audit_time.get("date_time"),
    )


def _recipe_audit_field_map(recipe):
    """Extract comparable recipe fields for audit details."""
    if not isinstance(recipe, dict):
        return {}
    duration = recipe.get("durationSec")
    if duration in (None, "") and recipe.get("durationDisplay"):
        duration = recipe.get("durationDisplay")
    steps = recipe.get("steps")
    step_n = len(steps) if isinstance(steps, list) else None
    return {
        "product": recipe.get("productName") or recipe.get("name") or "",
        "type": recipe.get("productType") or recipe.get("uspMode") or "",
        "batchSize": recipe.get("batchSize"),
        "samples": recipe.get("noOfSamples"),
        "vacuumMmHg": recipe.get("vacuumMmHg"),
        "duration": duration,
        "analysisReportNo": recipe.get("analysisReportNo") or "",
        "steps": step_n,
    }


def format_recipe_audit_details(recipe, recipe_id=None):
    fields = _recipe_audit_field_map(recipe)
    parts = []
    if recipe_id is not None:
        parts.append("id {}".format(recipe_id))
    if fields.get("product"):
        parts.append("product: {}".format(fields["product"]))
    if fields.get("type"):
        parts.append("type: {}".format(fields["type"]))
    if fields.get("batchSize") not in (None, ""):
        parts.append("batchSize: {}".format(fields["batchSize"]))
    if fields.get("samples") not in (None, ""):
        parts.append("samples: {}".format(fields["samples"]))
    if fields.get("vacuumMmHg") not in (None, ""):
        parts.append("vacuum: {} mmHg".format(fields["vacuumMmHg"]))
    if fields.get("duration") not in (None, ""):
        parts.append("duration: {}".format(fields["duration"]))
    if fields.get("analysisReportNo"):
        parts.append("A.R.: {}".format(fields["analysisReportNo"]))
    if fields.get("steps") not in (None, ""):
        parts.append("steps: {}".format(fields["steps"]))
    return " | ".join(parts) if parts else "recipe"


def diff_recipe_audit_details(before, after, recipe_id=None):
    b = _recipe_audit_field_map(before)
    a = _recipe_audit_field_map(after)
    keys = ["product", "type", "batchSize", "samples", "vacuumMmHg", "duration", "analysisReportNo", "steps"]
    changes = []
    for k in keys:
        bv = b.get(k)
        av = a.get(k)
        if str(bv if bv is not None else "") == str(av if av is not None else ""):
            continue
        label = {
            "product": "product",
            "type": "type",
            "batchSize": "batchSize",
            "samples": "samples",
            "vacuumMmHg": "vacuum",
            "duration": "duration",
            "analysisReportNo": "A.R.",
            "steps": "steps",
        }.get(k, k)
        if k == "vacuumMmHg":
            changes.append("{} {}→{} mmHg".format(label, bv if bv not in (None, "") else "—", av if av not in (None, "") else "—"))
        else:
            changes.append("{} {}→{}".format(label, bv if bv not in (None, "") else "—", av if av not in (None, "") else "—"))
    prefix = []
    if recipe_id is not None:
        prefix.append("id {}".format(recipe_id))
    name = a.get("product") or b.get("product") or ""
    if name:
        prefix.append("product: {}".format(name))
    if changes:
        return " | ".join(prefix + changes) if prefix else " | ".join(changes)
    return format_recipe_audit_details(after, recipe_id=recipe_id)


def _audit_time_fields():
    payload = rtc_service.get_device_wall_datetime_payload()
    dt_raw = (payload.get("datetime") or "").strip()
    if dt_raw:
        try:
            dt_obj = datetime.fromisoformat(dt_raw.replace("Z", "+00:00"))
            return {
                "timestamp_ms": int(dt_obj.timestamp() * 1000),
                "date_time": dt_obj.strftime("%d/%m/%Y %H:%M:%S"),
            }
        except Exception:
            pass
    now = datetime.now()
    return {
        "timestamp_ms": int(now.timestamp() * 1000),
        "date_time": now.strftime("%d/%m/%Y %H:%M:%S"),
    }


def _audit_request_source():
    return "{} {}".format(request.method, request.path)


def _audit_actor():
    cur = data_service.get_current_user() or {}
    return {
        "user": (request.headers.get("X-User-Username") or "").strip() or (cur.get("username") or "").strip() or (cur.get("name") or "").strip() or "--",
        "role": (request.headers.get("X-User-Role") or "").strip() or (cur.get("role") or "").strip() or "--",
        "name": (request.headers.get("X-User-Name") or "").strip() or (cur.get("name") or "").strip() or (cur.get("username") or "").strip() or "--",
    }


def _sanitize_audit_payload(value):
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            if str(k).lower() in ("password",):
                out[k] = "***"
            else:
                out[k] = _sanitize_audit_payload(v)
        return out
    if isinstance(value, list):
        return [_sanitize_audit_payload(v) for v in value]
    return value


def _changed_fields(before_obj, after_obj):
    before_obj = before_obj or {}
    after_obj = after_obj or {}
    keys = sorted(set(before_obj.keys()) | set(after_obj.keys()))
    changed = []
    for key in keys:
        if before_obj.get(key) != after_obj.get(key):
            changed.append(key)
    return changed


def _audit_event(
    *,
    action,
    outcome,
    entity_type="",
    entity_id=None,
    entity_name="",
    details="",
    reason="",
    target_user="",
    before=None,
    after=None,
    signature=None,
    event_type="compliance",
    extra=None,
    actor_user=None,
    actor_role=None,
):
    actor = _audit_actor()
    if actor_user is not None:
        actor = dict(actor)
        actor["user"] = str(actor_user or "").strip() or "--"
    if actor_role is not None:
        actor = dict(actor)
        actor["role"] = str(actor_role or "").strip() or "--"
    audit_time = _audit_time_fields()
    signature = signature or {}
    before_clean = _sanitize_audit_payload(before)
    after_clean = _sanitize_audit_payload(after)
    audit_service.log_structured_event(
        user=actor.get("user"),
        role=actor.get("role"),
        action=action,
        details=details,
        event_type=event_type,
        entity_type=entity_type,
        entity_id=entity_id,
        entity_name=entity_name,
        outcome=outcome,
        reason=reason,
        session_user=actor.get("user"),
        session_role=actor.get("role"),
        target_user=target_user,
        signature_mode=signature.get("mode") or "",
        signature_user=signature.get("username") or "",
        signature_role=signature.get("role") or "",
        changed_fields=_changed_fields(before_clean if isinstance(before_clean, dict) else {}, after_clean if isinstance(after_clean, dict) else {}),
        before=before_clean,
        after=after_clean,
        request_source=_audit_request_source(),
        extra=extra,
        timestamp_ms=audit_time.get("timestamp_ms"),
        date_time=audit_time.get("date_time"),
    )




POWER_INTERRUPTION_REMARKS = "Power interruption"
POWER_INTERRUPTION_SYSTEM_APPROVER = "System"


def _parse_report_dt(raw):
    """Parse ISO-ish timestamps from reports/checkpoints into datetime (best-effort)."""
    if raw is None:
        return None
    if isinstance(raw, datetime):
        return raw
    s = str(raw).strip()
    if not s:
        return None
    try:
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        return datetime.fromisoformat(s)
    except Exception:
        return None


def _format_duration_hms(seconds) -> str:
    try:
        total = max(0, int(seconds))
    except (TypeError, ValueError):
        return "00:00:00"
    h, rem = divmod(total, 3600)
    m, s = divmod(rem, 60)
    return "{:02d}:{:02d}:{:02d}".format(h, m, s)


def _power_loss_end_iso(checkpoint: dict = None, report: dict = None) -> str:
    """Last known live test time: checkpoint stamp beats post-boot wall clock."""
    cp = checkpoint if isinstance(checkpoint, dict) else {}
    rp = report if isinstance(report, dict) else {}
    td = rp.get("testData") if isinstance(rp.get("testData"), dict) else {}
    cp_td = cp.get("testData") if isinstance(cp.get("testData"), dict) else {}
    for raw in (
        cp.get("_checkpointAt"),
        cp.get("testEndTime"),
        cp_td.get("testEndTime"),
        cp.get("_espCommandSentAt"),
        td.get("testEndTime"),
        rp.get("testEndTime"),
        rp.get("completedAt"),
    ):
        if raw:
            return str(raw).strip()
    return _utc_now_iso()


def _read_duration_seconds_candidate(*dicts) -> Optional[int]:
    """Prefer wall-clock elapsed keys used by mid-test heartbeats."""
    for d in dicts:
        if not isinstance(d, dict):
            continue
        for key in (
            "wallElapsedSec",
            "_wallElapsedSec",
            "durationSeconds",
            "actualDurationSec",
            "elapsedSeconds",
            "durationSec",
        ):
            raw = d.get(key)
            if raw is None or raw == "":
                continue
            try:
                return max(0, int(raw))
            except (TypeError, ValueError):
                continue
    return None


def _apply_power_loss_duration(report: dict, checkpoint: dict = None) -> dict:
    """Stamp actual Start→power-cut wall time onto the report.

    Power interruption must NOT use planned hold/release (e.g. 120s / 80s).
    Total = wall elapsed until last checkpoint heartbeat.
    """
    report = dict(report or {})
    td = report.get("testData")
    td = dict(td) if isinstance(td, dict) else {}
    cp = checkpoint if isinstance(checkpoint, dict) else {}
    cp_td = cp.get("testData") if isinstance(cp.get("testData"), dict) else {}

    def _read_wall_explicit(*dicts):
        for d in dicts:
            if not isinstance(d, dict):
                continue
            for key in ("wallElapsedSec", "_wallElapsedSec"):
                raw = d.get(key)
                if raw is None or raw == "":
                    continue
                try:
                    return max(0, int(raw))
                except (TypeError, ValueError):
                    continue
        return None

    wall_explicit = _read_wall_explicit(cp, cp_td, td, report)
    elapsed = wall_explicit
    if elapsed is None:
        elapsed = _read_duration_seconds_candidate(cp, cp_td, td, report)

    start_raw = (
        cp.get("testStartTime")
        or cp_td.get("testStartTime")
        or td.get("testStartTime")
        or report.get("testStartTime")
    )
    end_raw = _power_loss_end_iso(cp, report)
    start_dt = _parse_report_dt(start_raw)
    end_dt = _parse_report_dt(end_raw)

    duration = None
    if wall_explicit is not None:
        # Heartbeat wall clock is authoritative for power-cut reports.
        duration = wall_explicit
        if start_dt is not None:
            try:
                end_dt = start_dt + timedelta(seconds=wall_explicit)
                end_raw = end_dt.isoformat().replace("+00:00", "Z")
            except Exception:
                pass
    elif start_dt is not None and end_dt is not None:
        if start_dt.tzinfo and not end_dt.tzinfo:
            end_dt = end_dt.replace(tzinfo=start_dt.tzinfo)
        elif end_dt.tzinfo and not start_dt.tzinfo:
            start_dt = start_dt.replace(tzinfo=end_dt.tzinfo)
        delta = max(0, int((end_dt - start_dt).total_seconds()))
        if elapsed is not None and elapsed > delta + 2:
            duration = elapsed
            try:
                end_dt = start_dt + timedelta(seconds=elapsed)
                end_raw = end_dt.isoformat().replace("+00:00", "Z")
            except Exception:
                pass
        elif abs(delta) <= 2 and elapsed is not None and elapsed > 2:
            duration = elapsed
            try:
                end_dt = start_dt + timedelta(seconds=elapsed)
                end_raw = end_dt.isoformat().replace("+00:00", "Z")
            except Exception:
                pass
        else:
            duration = delta if delta > 0 else (elapsed if elapsed is not None else 0)
            if elapsed is not None and elapsed > 0 and delta <= 0:
                duration = elapsed
    elif elapsed is not None:
        duration = elapsed
        if end_dt is not None and start_dt is None and elapsed > 0:
            try:
                start_dt = end_dt - timedelta(seconds=elapsed)
                start_raw = start_dt.isoformat().replace("+00:00", "Z")
            except Exception:
                pass
        elif start_dt is not None and end_dt is None and elapsed > 0:
            try:
                end_dt = start_dt + timedelta(seconds=elapsed)
                end_raw = end_dt.isoformat().replace("+00:00", "Z")
            except Exception:
                pass
    else:
        duration = 0

    if start_raw:
        start_iso = str(start_raw).strip()
        td["testStartTime"] = start_iso
        report["testStartTime"] = start_iso
    end_iso = str(end_raw).strip() if end_raw else _utc_now_iso()
    td["testEndTime"] = end_iso
    report["testEndTime"] = end_iso
    report["completedAt"] = end_iso

    duration_i = max(0, int(duration) if duration is not None else 0)
    td["durationSeconds"] = duration_i
    td["actualDurationSec"] = duration_i
    td["wallElapsedSec"] = duration_i
    report["durationSeconds"] = duration_i

    # Actual phase times from checkpoint (not planned set/release).
    hold_actual = None
    for src in (cp_td, td, cp):
        if not isinstance(src, dict):
            continue
        raw_h = src.get("holdDurationSec")
        if raw_h in (None, ""):
            continue
        try:
            hold_actual = max(0, int(round(float(raw_h))))
            break
        except (TypeError, ValueError):
            continue
    build_actual = None
    for src in (cp_td, td, cp):
        if not isinstance(src, dict):
            continue
        raw_b = src.get("buildDurationSec")
        if raw_b in (None, ""):
            continue
        try:
            build_actual = max(0, int(round(float(raw_b))))
            break
        except (TypeError, ValueError):
            continue

    if hold_actual is None:
        hold_actual = 0
    if build_actual is None:
        build_actual = max(0, duration_i - hold_actual) if hold_actual > 0 else duration_i
    if build_actual + hold_actual > duration_i + 2:
        if hold_actual > duration_i:
            hold_actual = duration_i
            build_actual = 0
        else:
            build_actual = max(0, duration_i - hold_actual)

    td["buildDurationSec"] = build_actual
    td["holdDurationSec"] = hold_actual
    td["releaseDurationSec"] = 0
    td["releaseTimeSec"] = 0
    td["totalDurationSec"] = duration_i
    report["testData"] = td
    return report


def _apply_power_loss_abort_to_report(report: dict, checkpoint: dict = None) -> dict:
    """Finalize a mid-test report after power loss.

    Production rules:
      - Test status: aborted
      - Result: FAIL
      - Approval: system auto-approved (FAIL)
      - Remarks: Power interruption
    """
    report = _apply_power_loss_duration(dict(report or {}), checkpoint)
    td = report.get("testData")
    if not isinstance(td, dict):
        td = {}
    else:
        td = dict(td)
    now_iso = _utc_now_iso()
    td["status"] = "aborted"
    td["result"] = "FAIL"
    td["remarks"] = POWER_INTERRUPTION_REMARKS
    td["approvalPassFail"] = "FAIL"
    td["passFail"] = "FAIL"
    report["testData"] = td
    report["remarks"] = POWER_INTERRUPTION_REMARKS
    report["status"] = "aborted"
    report["result"] = "FAIL"
    report["approvalPassFail"] = "FAIL"
    report["passFail"] = "FAIL"
    report["reportApprovalStatus"] = "approved"
    report["approvedBy"] = "System (power interruption)"
    report["approvedByName"] = POWER_INTERRUPTION_SYSTEM_APPROVER
    report["approvedByUsername"] = "system"
    report["approvalRemarks"] = POWER_INTERRUPTION_REMARKS
    report["approvedAt"] = now_iso
    if not report.get("completedAt"):
        report["completedAt"] = report.get("testEndTime") or now_iso
    return report


def _audit_power_loss_aborted_report(report: dict) -> None:
    """Generate PDF and audit rows for a power-loss aborted/FAIL system-approved report."""
    rid = report.get("id")
    if rid is None:
        return
    ctx = _format_report_audit_details(int(rid), report)
    td = report.get("testData") if isinstance(report.get("testData"), dict) else {}
    duration = td.get("durationSeconds")
    if duration is None:
        duration = report.get("durationSeconds")
    try:
        duration_i = int(duration) if duration is not None else None
    except (TypeError, ValueError):
        duration_i = None
    dur_txt = _format_duration_hms(duration_i) if duration_i is not None else "--"
    try:
        pdf_ok = _generate_report_pdf_file(int(rid), write_audit=False)
    except Exception:
        pdf_ok = False
        app.logger.exception("Power-loss report PDF failed for id %s", rid)
    pl_detail = (
        "{} | unclean shutdown | duration: {} | status: aborted | result: FAIL | "
        "approved by System (power interruption) | remarks: {}"
    ).format(ctx, dur_txt, POWER_INTERRUPTION_REMARKS)
    if pdf_ok:
        pl_detail = "{} | PDF saved".format(pl_detail)
    _audit("System", "System", "Report aborted (power loss)", pl_detail)
    _audit(
        "System",
        "System",
        "Report auto-approved (power interruption)",
        "{} | approvalPassFail=FAIL".format(ctx),
    )
    if pdf_ok:
        _audit_report_pdf_generated(int(rid), report)


def _checkpoint_is_mid_test(cp) -> bool:
    """True when an in-progress / awaiting-approval checkpoint should recover on boot."""
    if not isinstance(cp, dict) or not cp:
        return False
    rtype = str(cp.get("type") or "").strip().lower()
    if rtype not in ("test", "validation", "calibration"):
        return False
    phase = str(cp.get("_checkpointPhase") or "").strip().lower()
    if phase in ("running", "awaiting-approval"):
        return True
    if cp.get("_pendingReportId") is not None:
        return True
    td = cp.get("testData") if isinstance(cp.get("testData"), dict) else {}
    st = str(td.get("status") or cp.get("status") or "").strip().lower()
    if st in ("running", "in_progress", "hold", "evacuating"):
        return True
    if st in ("completed", "aborted", "pass", "fail", "failed"):
        return False
    # Start-just-saved checkpoint: has recipe/product + start stamp, phase may be running/blank.
    has_product = bool(
        cp.get("recipe")
        or td.get("recipe")
        or td.get("productName")
        or cp.get("productName")
        or cp.get("name")
    )
    has_start = bool(
        cp.get("_checkpointAt")
        or cp.get("testStartTime")
        or td.get("testStartTime")
    )
    return bool(has_product and has_start)


def _power_loss_report_already_saved(checkpoint: dict) -> bool:
    """True if a Power interruption report for this run start already exists."""
    cp = checkpoint if isinstance(checkpoint, dict) else {}
    cp_td = cp.get("testData") if isinstance(cp.get("testData"), dict) else {}
    start = str(
        cp.get("testStartTime")
        or cp_td.get("testStartTime")
        or ""
    ).strip()
    if not start:
        return False
    for report in data_service.list_reports("all") or []:
        td = report.get("testData") if isinstance(report.get("testData"), dict) else {}
        remarks = str(td.get("remarks") or report.get("remarks") or "").lower()
        if "power interruption" not in remarks:
            continue
        r_start = str(td.get("testStartTime") or report.get("testStartTime") or "").strip()
        if r_start and r_start == start:
            return True
    return False


def _abort_pending_reports_after_power_loss(session_username):
    """Finalize pending reports as aborted/FAIL after unclean shutdown (power loss)."""
    un = _norm_username(session_username)
    if not un:
        return 0
    cp = data_service.get_test_run_data()
    aborted = 0
    for report in data_service.list_reports("all") or []:
        rtype = (report.get("type") or "").strip().lower()
        if rtype not in ("test", "validation", "calibration"):
            continue
        if (report.get("reportApprovalStatus") or "").strip().lower() != "pending":
            continue
        if _report_operated_by_username(report) != un:
            continue
        report = _apply_power_loss_abort_to_report(report, cp)
        data_service.save_report(report)
        _audit_power_loss_aborted_report(report)
        aborted += 1
    return aborted


def _create_aborted_report_from_power_loss_checkpoint(session_username):
    """If a run was in progress (checkpoint) but no pending report existed, save aborted/FAIL report."""
    un = _norm_username(session_username)
    cp = data_service.get_test_run_data()
    if not isinstance(cp, dict) or not cp:
        return 0
    if not _checkpoint_is_mid_test(cp):
        data_service.clear_test_run_data()
        return 0
    rtype = (cp.get("type") or "").strip().lower()
    if rtype not in ("test", "validation", "calibration"):
        data_service.clear_test_run_data()
        return 0
    if _power_loss_report_already_saved(cp):
        data_service.clear_test_run_data()
        return 0
    td = cp.get("testData") if isinstance(cp.get("testData"), dict) else {}
    op = _norm_username(
        cp.get("operatedByUsername")
        or td.get("operatedByUsername")
        or td.get("employeeId")
        or cp.get("username")
        or ""
    )
    # Prefer matching operator; if checkpoint has no operator, use session user.
    if op and un and op != un:
        app.logger.warning(
            "Power-loss checkpoint operator %s != session %s; still creating report",
            op,
            un,
        )
    report_data = dict(cp)
    if not report_data.get("type"):
        report_data["type"] = rtype
    if un:
        report_data.setdefault("operatedByUsername", un)
        report_data.setdefault("employeeId", un)
        if isinstance(report_data.get("testData"), dict):
            report_data["testData"] = dict(report_data["testData"])
            report_data["testData"].setdefault("operatedByUsername", un)
            report_data["testData"].setdefault("employeeId", un)
    recipe = report_data.get("recipe") or (td.get("recipe") if isinstance(td, dict) else None)
    try:
        enriched = report_service.generate_report(
            report_data,
            recipe=recipe,
            factory_settings=report_data.get("factorySettings"),
        )
        enriched = _stamp_report_operator(enriched)
        enriched = _apply_power_loss_abort_to_report(enriched, cp)
        report_id = data_service.save_report(enriched)
        enriched["id"] = report_id
        data_service.save_report(enriched)
        _audit_report_created(report_id, enriched)
        _audit_power_loss_aborted_report(enriched)
        data_service.clear_test_run_data()
        app.logger.info(
            "Power-loss report created id=%s type=%s status=aborted result=FAIL",
            report_id,
            rtype,
        )
        return 1
    except Exception:
        app.logger.exception("Failed creating power-loss report from checkpoint")
        return 0


def _startup_session_power_audit():
    """If the last run ended without a clean stop while a session was active, log power interruption and save report."""
    try:
        had_clean_shutdown = data_service.consume_app_clean_stop_flag()
        pending = data_service.read_session_power_audit_pending()
        if pending and not had_clean_shutdown:
            un = (pending.get("username") or "").strip()
            role = (pending.get("role") or "").strip()
            if not pending.get("powerAuditLogged"):
                audit_time = _audit_time_fields()
                if audit_service.is_hidden_factory_actor(un, role):
                    pi_details = "Privileged factory session was active when power was interrupted or the system restarted."
                elif un:
                    pi_details = "Unclean shutdown while {} was logged in".format(un)
                else:
                    pi_details = "Unclean shutdown during active session"
                audit_service.log_structured_event(
                    user="--",
                    role="--",
                    action="Power interruption",
                    outcome="success",
                    entity_type="session",
                    entity_name="power",
                    details=pi_details,
                    event_type="compliance",
                    target_user=un,
                    extra={"lastKnownRole": role} if role else None,
                    request_source="system/startup",
                    timestamp_ms=audit_time.get("timestamp_ms"),
                    date_time=audit_time.get("date_time"),
                )
                pending = dict(pending)
                pending["powerAuditLogged"] = True
                data_service.write_session_power_audit_pending(pending)
            # Always attempt report finalization on unclean boot (idempotent via checkpoint clear / duplicate guard).
            try:
                _abort_pending_reports_after_power_loss(un)
                created = _create_aborted_report_from_power_loss_checkpoint(un)
                if created:
                    app.logger.info("Power-loss checkpoint recovered into report(s)")
                else:
                    # Log why for production diagnosis
                    cp = data_service.get_test_run_data()
                    app.logger.warning(
                        "Power-loss report not created (checkpoint mid-test=%s keys=%s)",
                        _checkpoint_is_mid_test(cp),
                        list(cp.keys())[:12] if isinstance(cp, dict) else None,
                    )
            except Exception:
                app.logger.exception("Abort pending reports after power loss failed")
        elif pending and had_clean_shutdown and pending.get("powerAuditLogged"):
            pending = dict(pending)
            pending.pop("powerAuditLogged", None)
            data_service.write_session_power_audit_pending(pending)
        cur = data_service.get_current_user()
        if cur:
            if not pending:
                data_service.write_session_power_audit_pending(cur)
        else:
            data_service.delete_session_power_audit_pending()
        audit_service.prune_power_interruption_overflow(keep=10)
    except Exception:
        app.logger.exception("Startup session power audit failed")




def _register_clean_shutdown_atexit():
    """Mark clean shutdown on normal process exit (reduces false power-interruption audits)."""

    def _on_exit():
        try:
            data_service.touch_app_clean_stop_flag()
        except Exception:
            pass

    try:
        atexit.register(_on_exit)
    except Exception:
        pass

def _register_clean_shutdown_signals():
    """Mark clean shutdown on SIGTERM/SIGINT so the next start does not log a false power interruption."""

    def _handler(signum, frame):
        try:
            data_service.touch_app_clean_stop_flag()
        except Exception:
            pass

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(sig, _handler)
        except (ValueError, OSError, AttributeError):
            pass


def _require_user_admin_verification():
    return _consume_approval_verify_token("user_admin")


def _approval_verifier_member(verifier: dict) -> dict:
    """Resolve verifier to a member row with featureOverrides for permission checks."""
    if not verifier:
        return {}
    role = str(verifier.get("role") or "").strip().lower()
    if role == "factory":
        return verifier
    un = str(verifier.get("username") or "").strip()
    m = data_service.get_member_by_username(un) if un else None
    return m if m else verifier


def _approval_verifier_eligible_for_recipe(verifier: dict) -> bool:
    """Recipe approval: verifier must have recipe-approve permission (Factory bypass)."""
    vm = _approval_verifier_member(verifier)
    role = str(vm.get("role") or "").strip().lower()
    if role == "factory":
        return True
    return rbac_service.member_has_internal(vm, "recipe-approve")


def _normalize_report_approval_type(report_type) -> str:
    t = str(report_type or "test").strip().lower()
    if t in ("test", "validation", "calibration"):
        return t
    return "test"


def _report_approval_internal_keys(report_type) -> list:
    """
    Internal permission keys that may approve a report of this type.
    Test report approval covers test + validation; calibration needs its own card.
    """
    t = _normalize_report_approval_type(report_type)
    if t == "calibration":
        return ["calibration-report-approve"]
    if t == "validation":
        return ["test-report-approve", "validation-report-approve"]
    return ["test-report-approve"]


def _approval_verifier_eligible_for_report(verifier: dict, report_type: str = "test") -> bool:
    """Report approval eligibility by report type (Factory bypass)."""
    vm = _approval_verifier_member(verifier)
    role = str(vm.get("role") or "").strip().lower()
    if role == "factory":
        return True
    for key in _report_approval_internal_keys(report_type):
        if rbac_service.member_has_internal(vm, key):
            return True
    return False


def _approval_verifier_eligible_for_user_admin(verifier: dict) -> bool:
    """User disable / admin actions: verifier must have profile-management permission."""
    vm = _approval_verifier_member(verifier)
    role = str(vm.get("role") or "").strip().lower()
    if role == "factory":
        return True
    return rbac_service.member_has_internal(vm, "user-manage")


def _utc_now_iso():
    """Naive local ISO timestamp for reports/labels (hardware RTC wall time)."""
    dt = rtc_service.read_rtc_wall_datetime()
    if dt is not None:
        return dt.strftime("%Y-%m-%dT%H:%M:%S")
    return datetime.now().strftime("%Y-%m-%dT%H:%M:%S")


def _norm_username(val):
    return str(val or "").strip().lower()


def _report_operated_by_username(report):
    td = report.get("testData") or {}
    if isinstance(td, dict):
        u = td.get("operatedByUsername") or td.get("employeeId")
        if u:
            return _norm_username(u)
    return _norm_username(report.get("operatedByUsername") or report.get("employeeId"))


def _stamp_report_operator(enriched):
    cur = data_service.get_current_user() or {}
    td = enriched.get("testData")
    if not isinstance(td, dict):
        td = {}
    un = _norm_username(
        enriched.get("operatedByUsername")
        or td.get("operatedByUsername")
        or td.get("employeeId")
        or cur.get("username")
        or cur.get("name")
    )
    name = (
        enriched.get("operatorName")
        or td.get("operatorName")
        or cur.get("name")
        or cur.get("username")
        or "—"
    )
    emp = (
        enriched.get("employeeId")
        or td.get("employeeId")
        or cur.get("username")
        or un
    )
    enriched["operatedByUsername"] = un
    enriched["operatorName"] = name
    enriched["employeeId"] = emp
    td = dict(td)
    td["operatedByUsername"] = un
    td["operatorName"] = name
    td["employeeId"] = emp
    enriched["testData"] = td
    return enriched


def _report_requires_approval(report):
    rtype = (report.get("type") or "").strip().lower()
    return rtype in ("test", "validation", "calibration")


def _check_report_approved_for_print_export(report=None, report_id=None, report_data=None):
    """Return (json_response, status_code) if blocked, else None."""
    if report is None and report_id is not None:
        report = data_service.get_report(report_id)
    if report is None and report_data:
        report = report_data
    if not report or not _report_requires_approval(report):
        return None
    st = (report.get("reportApprovalStatus") or "").strip().lower()
    if st == "approved":
        return None
    if st == "pending" and _effective_request_role() != "factory":
        body = {
            "ok": False,
            "success": False,
            "error": "Report must be approved before print or export.",
        }
        return jsonify(body), 403
    return None


def _display_role_label(role_str):
    """User-facing role in approval lines (stored role Supervisor → Reviewer)."""
    r = str(role_str or "").strip()
    if not r:
        return r
    if r.lower() == "supervisor":
        return "Reviewer"
    return r


def _rbac_member_from_session():
    """Member record (with normalized permissions) for RBAC, or factory stub user."""
    cur = data_service.get_current_user()
    if not cur:
        return None
    role = str((cur or {}).get("role") or "").strip().lower()
    un = str((cur or {}).get("username") or "").strip().upper()
    if role == "factory" or un == data_service.FACTORY_USERNAME.upper():
        return cur
    m = data_service.get_member_by_username(cur.get("username") or "")
    return m if m else cur


def _session_has_internal(internal_key: str) -> bool:
    m = _rbac_member_from_session()
    if not m:
        return False
    return rbac_service.member_has_internal(m, internal_key)


def _require_auth():
    """Return 401 if no logged-in session."""
    if not data_service.get_current_user():
        return jsonify({"error": "Unauthorized"}), 401
    return None


def _log_print_auth_failure(gate):
    """Warn when print is rejected for missing session (client may still look logged in)."""
    if not gate:
        return
    status = gate[1] if isinstance(gate, tuple) and len(gate) > 1 else None
    if status != 401:
        return
    hdr_user = (request.headers.get("X-User-Username") or "").strip()
    app.logger.warning(
        "Print auth 401: empty server session (X-User-Username=%r)",
        hdr_user or None,
    )


def _session_member_id():
    """Logged-in member id from session, or None (e.g. factory stub)."""
    cur = data_service.get_current_user() or {}
    try:
        mid = cur.get("id")
        if mid is None:
            return None
        return int(mid)
    except (TypeError, ValueError):
        return None


def _is_self_member(member_id: int) -> bool:
    """True when the session user is updating/viewing their own member record."""
    try:
        target_id = int(member_id)
    except (TypeError, ValueError):
        return False
    sid = _session_member_id()
    if sid is not None and sid == target_id:
        return True
    cur = data_service.get_current_user() or {}
    member = data_service.get_member(target_id)
    if not member:
        return False
    un_cur = str(cur.get("username") or "").strip().lower()
    un_mem = str(member.get("username") or "").strip().lower()
    return bool(un_cur) and un_cur == un_mem


def _require_user_manage_or_self(member_id: int):
    """Allow user-manage admins or any user accessing their own profile."""
    err = _require_auth()
    if err:
        return err
    if _is_self_member(member_id):
        return None
    return _require_session_internal(
        "user-manage",
        "Forbidden. You do not have permission to manage users.",
    )


def _self_profile_payload_from_request(existing: dict, payload: dict) -> dict:
    """Self-service profile: only display name and password may change."""
    out = dict(existing)
    if "name" in payload:
        name = str(payload.get("name") or "").strip()
        if name:
            out["name"] = name
    new_pwd = payload.get("password")
    if new_pwd is not None and str(new_pwd).strip():
        pwd_err = _password_strength_error(str(new_pwd))
        if pwd_err:
            raise ValueError(pwd_err)
        out["password"] = str(new_pwd)
    return out


def _resolve_session_member_record():
    """Member row for the logged-in user (not factory)."""
    data_service.refresh_current_user_from_member()
    cur = data_service.get_current_user() or {}
    un = str(cur.get("username") or "").strip()
    if un.upper() == data_service.FACTORY_USERNAME.upper():
        return None, cur
    mid = _session_member_id()
    member = data_service.get_member(mid) if mid is not None else None
    if not member and un:
        member = data_service.get_member_by_username(un)
    return member, cur


def _require_session_internal(internal_key: str, message: str = None):
    """Return Flask error response if session lacks internal permission, else None."""
    err = _require_auth()
    if err:
        return err
    data_service.refresh_current_user_from_member()
    if not _session_has_internal(internal_key):
        msg = message or "Forbidden. You do not have permission for this action."
        return jsonify({"error": msg}), 403
    return None


def _require_any_session_internal(internal_keys, message: str = None):
    """Return Flask error response if session lacks all listed permissions, else None."""
    err = _require_auth()
    if err:
        return err
    data_service.refresh_current_user_from_member()
    for key in internal_keys or []:
        if _session_has_internal(key):
            return None
    msg = message or "Forbidden. You do not have permission for this action."
    return jsonify({"error": msg}), 403


def _session_can_edit_datetime() -> bool:
    """True when the logged-in user may change system date/time (RBAC, not role name alone)."""
    data_service.refresh_current_user_from_member()
    m = _rbac_member_from_session()
    if not m:
        return False
    return rbac_service.member_has_internal(m, "edit-datetime")


def _require_edit_datetime():
    """Return a Flask error response if the session may not change date/time, else None."""
    if not data_service.get_current_user():
        return jsonify({"ok": False, "error": "Unauthorized"}), 401
    if not _session_can_edit_datetime():
        return (
            jsonify(
                {
                    "ok": False,
                    "error": "Forbidden. You do not have permission to change date and time.",
                }
            ),
            403,
        )
    return None


def _verifier_payload_has_internal(verified, internal_key: str) -> bool:
    if not verified:
        return False
    vr = str((verified or {}).get("role") or "").strip().lower()
    if vr == "factory":
        return True
    un = (verified or {}).get("username") or ""
    vm = data_service.get_member_by_username(un) if un else None
    if not vm:
        return False
    return rbac_service.member_has_internal(vm, internal_key)


def _session_role_header():
    return (request.headers.get("X-User-Role") or "").strip().lower()


def _effective_request_role():
    """Role for this request: X-User-Role if present, else logged-in user from server session."""
    hr = _session_role_header()
    if hr:
        return hr
    cur = data_service.get_current_user()
    return str((cur or {}).get("role") or "").strip().lower()


def _is_biometric_enabled():
    settings = data_service.get_factory_settings() or {}
    val = settings.get("biometricEnabled", True)
    if isinstance(val, bool):
        return val
    return str(val).strip().lower() not in ("false", "0", "off", "no", "disabled")


def _is_biometric_transient_error(message):
    """Errors expected during passive biometric polling (not true auth failures)."""
    msg = str(message or "").strip().lower()
    if not msg:
        return False
    transient_markers = (
        "timed out waiting for finger",
        "no finger detected",
        "image too messy",
    )
    return any(marker in msg for marker in transient_markers)


def _can_assign_feature_overrides():
    if _effective_request_role() == "factory":
        return True
    return _session_has_internal("user-add")


def _payload_has_protected_feature_overrides(member_data):
    if not isinstance(member_data, dict):
        return False
    raw = member_data.get("featureOverrides")
    if not isinstance(raw, dict):
        return False
    protected = {"dashboard", "factory-settings", "factory-reset"}
    for k in (raw.get("allow") or []):
        if str(k or "").strip() in protected:
            return True
    for k in (raw.get("deny") or []):
        if str(k or "").strip() in protected:
            return True
    return False


def _apply_recipe_approval_for_session_creator(processed):
    """All creators start pending; approval only via X-Approval-Verify-Token."""
    processed["recipeApprovalStatus"] = "pending"
    for k in (
        "recipeApprovedAt",
        "recipeApprovedBy",
        "recipeApprovalRemarks",
        "recipeApprovedByUsername",
    ):
        processed.pop(k, None)


def _apply_recipe_approval_verify_token(processed, remarks=""):
    """
    When X-Approval-Verify-Token is present, approve a pending recipe in the same save
    (avoids save-then-approve creating duplicate recipes or double writes).
    Returns (error_message or None, applied_via_token bool).
    """
    if (request.headers.get("X-Approval-Verify-Token") or "").strip() == "":
        return None, False
    if processed.get("recipeApprovalStatus") != "pending":
        return None, False
    verified, verify_err = _consume_approval_verify_token("recipe")
    if verify_err:
        return verify_err, False
    verified_name = (verified.get("name") or verified.get("username") or "—").strip()
    verified_role = (verified.get("role") or "").strip()
    verified_username = _norm_username(verified.get("username"))
    by_line = verified_name
    if verified_role:
        by_line = "{} ({})".format(verified_name, _display_role_label(verified_role))
    processed["recipeApprovalStatus"] = "approved"
    processed["recipeApprovedAt"] = _utc_now_iso()
    processed["recipeApprovedBy"] = by_line
    processed["recipeApprovedByUsername"] = verified_username
    processed["recipeApprovalRemarks"] = (remarks or "").strip()
    return None, True


_approval_verify_tokens = {}


def _cleanup_approval_verify_tokens():
    now = int(time.time())
    stale = [token for token, payload in _approval_verify_tokens.items() if int(payload.get("expiresAt", 0)) <= now]
    for token in stale:
        _approval_verify_tokens.pop(token, None)


def _issue_approval_verify_token(verifier_user, purpose, report_type=None):
    _cleanup_approval_verify_tokens()
    now = int(time.time())
    token = secrets.token_urlsafe(24)
    purpose_norm = str(purpose or "recipe").strip().lower()
    payload = {
        "username": verifier_user.get("username") or "",
        "name": verifier_user.get("name") or verifier_user.get("username") or "",
        "role": str(verifier_user.get("role") or "").strip().lower(),
        "purpose": purpose_norm,
        "issuedAt": now,
        "expiresAt": now + APPROVAL_VERIFY_TTL_SECONDS,
    }
    if purpose_norm == "report":
        payload["reportType"] = _normalize_report_approval_type(report_type)
    _approval_verify_tokens[token] = payload
    return token, payload


def _consume_approval_verify_token(expected_purpose):
    _cleanup_approval_verify_tokens()
    token = (request.headers.get("X-Approval-Verify-Token") or "").strip()
    if not token:
        return None, "Approval verification is required."
    payload = _approval_verify_tokens.pop(token, None)
    if not payload:
        return None, "Approval verification is invalid or expired."
    exp = str(expected_purpose or "").strip().lower()
    got = str(payload.get("purpose") or "").strip().lower()
    if got != exp:
        return None, "Approval verification was issued for a different action."
    if exp == "report":
        rtype = _normalize_report_approval_type(payload.get("reportType"))
        ok_keys = _report_approval_internal_keys(rtype)
        if not any(_verifier_payload_has_internal(payload, k) for k in ok_keys):
            if rtype == "calibration":
                return None, "Verifier does not have calibration report approval permission."
            return None, "Verifier does not have report approval permission for this report type."
    elif exp == "recipe":
        if not _verifier_payload_has_internal(payload, "recipe-approve"):
            return None, "Verifier does not have recipe approval permission."
    elif exp == "user_admin":
        if not _verifier_payload_has_internal(payload, "user-manage"):
            return None, "Verifier does not have profile management permission."
    elif exp == "export":
        if not _verifier_payload_has_internal(payload, "export-approve"):
            return None, "Verifier does not have export approval permission."
    else:
        return None, "Invalid approval purpose."
    return payload, None


def _audit_report_pdf_generated(report_id, report=None) -> None:
    """Audit row when a report PDF file is written (approved or aborted only)."""
    if report is None:
        report = data_service.get_report(report_id)
    rid = report_id if report_id is not None else (report or {}).get("id")
    st = str((report or {}).get("reportApprovalStatus") or "").strip().lower()
    if st == "approved":
        pf = str((report or {}).get("approvalPassFail") or "").strip().upper()
        detail = "Report id {}".format(rid)
        if pf:
            detail = "{} | {} | approved PDF".format(detail, pf)
        else:
            detail = "{} | approved PDF".format(detail)
    elif st == "aborted":
        detail = "Report id {} | aborted PDF".format(rid)
    else:
        return
    _audit(None, None, "Report PDF generated", detail)


def _format_report_audit_details(report_id, enriched):
    """Build audit trail details: saved report name, recipe, batch."""
    if not enriched:
        return str(report_id)
    parts = []
    name = enriched.get("name")
    if name:
        parts.append("saved as: {}".format(name))
    else:
        parts.append("report id {}".format(report_id))
    recipe = enriched.get("recipe") or {}
    test_data = enriched.get("testData") or {}
    recipe_inner = test_data.get("recipe") or {}
    rname = (
        recipe.get("productName")
        or recipe.get("name")
        or test_data.get("productName")
        or recipe_inner.get("productName")
        or recipe_inner.get("name")
        or enriched.get("productName")
    )
    if rname:
        parts.append("recipe: {}".format(rname))
    if report_id is not None:
        parts.append("report id {}".format(report_id))
    batch = recipe.get("batchNumber")
    if batch is None or (isinstance(batch, str) and not batch.strip()):
        batch = test_data.get("batchNumber")
    if batch is None or (isinstance(batch, str) and not batch.strip()):
        batch = recipe_inner.get("batchNumber")
    if batch is not None and str(batch).strip() != "":
        parts.append("batch: {}".format(batch))
    return " | ".join(parts)


# =================== STATIC ==========================


@app.route("/api/health")
def health():
    return jsonify({"status": "ok", "vacuumValidation": True}), 200


@app.route("/")
def serve_index():
    return send_from_directory(APP_ROOT, "index.html")


# =================== DATA: RECIPES ==========================


@app.route("/api/data/recipes", methods=["GET"])
def get_recipes():
    try:
        gate = _require_any_session_internal(
            ["recipe-list", "quick-test", "recipe-test", "recipe-edit"],
            "Forbidden. You do not have permission to view recipes.",
        )
        if gate:
            return gate
        recipes = data_service.list_recipes()
        return jsonify({"recipes": recipes}), 200
    except Exception as e:
        app.logger.exception("Error listing recipes")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/recipes", methods=["POST"])
def create_recipe():
    try:
        gate = _require_session_internal(
            "recipe-manage",
            "Forbidden. You do not have permission to create recipes.",
        )
        if gate:
            return gate
        recipe_data = request.get_json(force=True, silent=True) or {}
        validation_result = calculation_service.validate_recipe(recipe_data)
        if not validation_result.get("valid", False):
            return jsonify({"error": validation_result.get("error", "Invalid recipe data")}), 400
        processed = calculation_service.process_recipe_form_data(recipe_data)
        _apply_recipe_approval_for_session_creator(processed)
        remarks = (recipe_data.get("recipeApprovalRemarks") or recipe_data.get("remarks") or "").strip()
        tok_err, via_token = _apply_recipe_approval_verify_token(processed, remarks)
        if tok_err:
            return jsonify({"error": tok_err}), 401
        recipe_id = data_service.save_recipe(processed)
        rd = format_recipe_audit_details(processed, recipe_id=recipe_id)
        _audit(None, None, "Recipe created", "Recipe created: {}".format(rd))
        if processed.get("recipeApprovalStatus") == "approved" and via_token:
            v_user = processed.get("recipeApprovedByUsername") or "--"
            v_role = (request.headers.get("X-User-Role") or "").strip() or "--"
            _audit(v_user, v_role, "Recipe approved", rd)
        return jsonify({"id": recipe_id, "recipe": processed}), 201
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        app.logger.exception("Error creating recipe")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/recipes/<int:recipe_id>", methods=["GET"])
def get_recipe(recipe_id):
    try:
        gate = _require_any_session_internal(
            ["recipe-list", "quick-test", "recipe-test", "recipe-edit"],
            "Forbidden. You do not have permission to view recipes.",
        )
        if gate:
            return gate
        recipe = data_service.get_recipe(recipe_id)
        if recipe:
            return jsonify({"recipe": recipe}), 200
        return jsonify({"error": "Recipe not found"}), 404
    except Exception as e:
        app.logger.exception("Error getting recipe")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/recipes/<int:recipe_id>", methods=["PUT"])
def update_recipe(recipe_id):
    try:
        gate = _require_session_internal(
            "recipe-manage",
            "Forbidden. You do not have permission to edit recipes.",
        )
        if gate:
            return gate
        recipe_data = request.get_json(force=True, silent=True) or {}
        recipe_data["id"] = recipe_id
        validation_result = calculation_service.validate_recipe(recipe_data)
        if not validation_result.get("valid", False):
            return jsonify({"error": validation_result.get("error", "Invalid recipe data")}), 400
        processed = calculation_service.process_recipe_form_data(recipe_data)
        _apply_recipe_approval_for_session_creator(processed)
        remarks = (recipe_data.get("recipeApprovalRemarks") or recipe_data.get("remarks") or "").strip()
        tok_err, via_token = _apply_recipe_approval_verify_token(processed, remarks)
        if tok_err:
            return jsonify({"error": tok_err}), 401
        existing = data_service.get_recipe(recipe_id)
        data_service.save_recipe(processed)
        rd = diff_recipe_audit_details(existing, processed, recipe_id=recipe_id)
        _audit(None, None, "Recipe edited", "Recipe edited: {}".format(rd))
        if processed.get("recipeApprovalStatus") == "approved" and via_token:
            v_user = processed.get("recipeApprovedByUsername") or "--"
            v_role = (request.headers.get("X-User-Role") or "").strip() or "--"
            _audit(v_user, v_role, "Recipe approved", rd)
        return jsonify({"id": recipe_id, "recipe": processed}), 200
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        app.logger.exception("Error updating recipe")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/recipes/<int:recipe_id>", methods=["DELETE"])
def delete_recipe(recipe_id):
    try:
        gate = _require_any_session_internal(
            ["recipe-delete", "disable-recipes"],
            "Forbidden. You do not have permission to disable recipes.",
        )
        if gate:
            return gate
        existing = data_service.get_recipe(recipe_id)
        success = data_service.delete_recipe(recipe_id)
        if success:
            rlabel = ""
            if existing:
                rlabel = existing.get("productName") or existing.get("name") or ""
            details = "Recipe id {}".format(recipe_id)
            if rlabel:
                details = "{}: {}".format(details, rlabel)
            _audit(None, None, "Disable Recipe", details)
            return jsonify({"success": True}), 200
        return jsonify({"error": "Recipe not found"}), 404
    except Exception as e:
        app.logger.exception("Error deleting recipe")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/recipes/<int:recipe_id>/approve", methods=["POST"])
def approve_recipe(recipe_id):
    try:
        verified, verify_err = _consume_approval_verify_token("recipe")
        if verify_err:
            return jsonify({"ok": False, "error": verify_err}), 401
        body = request.get_json(force=True, silent=True) or {}
        remarks = (body.get("remarks") or "").strip()
        approver_name = (body.get("approverName") or "").strip()
        role_header = (request.headers.get("X-User-Role") or "").strip()
        recipe = data_service.get_recipe(recipe_id)
        if not recipe:
            return jsonify({"ok": False, "error": "Recipe not found"}), 404
        verified_username = _norm_username(verified.get("username"))
        st = recipe.get("recipeApprovalStatus")
        if st == "approved":
            existing_approver = _norm_username(recipe.get("recipeApprovedByUsername"))
            if existing_approver and existing_approver == verified_username:
                return jsonify({"ok": False, "error": "Same person cannot approve twice"}), 409
            return jsonify({"ok": True, "recipe": recipe}), 200
        if st not in (None, "pending"):
            return jsonify({"ok": False, "error": "Invalid approval state"}), 400
        if st is None:
            return jsonify({"ok": False, "error": "Legacy recipe does not require approval"}), 400
        verified_name = (verified.get("name") or verified.get("username") or approver_name or "—").strip()
        verified_role = (verified.get("role") or role_header or "").strip()
        by_line = verified_name
        if verified_role:
            by_line = "{} ({})".format(verified_name, _display_role_label(verified_role))
        recipe["recipeApprovalStatus"] = "approved"
        recipe["recipeApprovedAt"] = _utc_now_iso()
        recipe["recipeApprovedBy"] = by_line
        recipe["recipeApprovedByUsername"] = verified_username
        recipe["recipeApprovalRemarks"] = remarks
        data_service.save_recipe(recipe)
        rname = (recipe.get("productName") or recipe.get("name") or "").strip()
        rdetail = "Recipe id {} | verified by {}".format(recipe_id, verified_name)
        if rname:
            rdetail = "{} | recipe: {}".format(rdetail, rname)
        batch = recipe.get("batchNumber")
        if batch is not None and str(batch).strip():
            rdetail = "{} | batch: {}".format(rdetail, str(batch).strip())
        v_audit_user = verified.get("username") or verified_username or verified_name
        v_audit_role = (verified.get("role") or "").strip() or "--"
        _audit(
            v_audit_user,
            v_audit_role,
            "Recipe approved",
            rdetail,
        )
        return jsonify({"ok": True, "recipe": recipe}), 200
    except Exception as e:
        app.logger.exception("Error approving recipe")
        return jsonify({"ok": False, "error": str(e)}), 500


# =================== DATA: TEST RUN CHECKPOINT (power-loss recovery) ==========================


@app.route("/api/data/test-run/checkpoint", methods=["PUT"])
def put_test_run_checkpoint():
    """Persist in-progress test run so a report can be saved after unclean shutdown."""
    try:
        gate = _require_auth()
        if gate:
            return gate
        gate = _require_any_session_internal(
            ["quick-test", "recipe-test", "validation-test", "calibration-menu"],
            "Forbidden. You do not have permission to run tests.",
        )
        if gate:
            return gate
        body = request.get_json(force=True, silent=True) or {}
        if not body:
            return jsonify({"ok": False, "error": "Checkpoint body required"}), 400
        data_service.save_test_run_data(body)
        return jsonify({"ok": True}), 200
    except Exception as e:
        app.logger.exception("Error saving test run checkpoint")
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/data/test-run/checkpoint", methods=["DELETE"])
def delete_test_run_checkpoint():
    try:
        gate = _require_auth()
        if gate:
            return gate
        data_service.clear_test_run_data()
        return jsonify({"ok": True}), 200
    except Exception as e:
        app.logger.exception("Error clearing test run checkpoint")
        return jsonify({"ok": False, "error": str(e)}), 500


# =================== DATA: REPORTS ==========================


@app.route("/api/data/reports", methods=["GET"])
def get_reports():
    try:
        gate = _require_session_internal("reports-view", "Forbidden. You do not have permission to view reports.")
        if gate:
            return gate
        filter_type = request.args.get("filter", "all")
        reports = data_service.list_reports(filter_type)
        return jsonify({"reports": reports}), 200
    except Exception as e:
        app.logger.exception("Error listing reports")
        return jsonify({"error": str(e)}), 500




def _audit_report_created(report_id, enriched):
    """Write audit row for a newly saved report/test/validation."""
    details = _format_report_audit_details(report_id, enriched)
    approval_st = str(enriched.get("reportApprovalStatus") or "").strip().lower()
    if approval_st == "pending":
        details = "{} | awaiting approval (PDF after approval)".format(details)
    elif approval_st == "aborted":
        details = "{} | aborted".format(details)
    rtype = (enriched.get("type") or "").strip().lower()
    if rtype == "test":
        td = enriched.get("testData") or {}
        recipe = enriched.get("recipe") or td.get("recipe") or {}
        pname = str(recipe.get("productName") or td.get("productName") or "").strip()
        recipe_id = recipe.get("id")
        test_source = str(recipe.get("testSource") or td.get("testSource") or "").strip().lower()
        is_quick = (
            test_source == "quick"
            or pname.lower() == "quick test"
            or (recipe_id is None and bool(pname))
        )
        action = "Quick test performed" if is_quick else "Test performed"
        _audit(None, None, action, details)
    elif rtype == "validation":
        _audit(None, None, "Validation performed", details)
    elif rtype == "calibration":
        _audit(None, None, "Calibration performed", details)
    else:
        _audit(None, None, "Report saved", details)

@app.route("/api/data/reports", methods=["POST"])
def create_report():
    try:
        report_data = request.get_json(force=True, silent=True) or {}
        rtype = (report_data.get("type") or "").strip().lower()
        if rtype == "validation":
            gate = _require_session_internal(
                "validation-test",
                "Forbidden. You do not have permission to run validation.",
            )
        elif rtype == "calibration":
            gate = _require_session_internal(
                "calibration-menu",
                "Forbidden. You do not have permission to run calibration.",
            )
        elif rtype == "test":
            gate = _require_any_session_internal(
                ["quick-test", "recipe-test"],
                "Forbidden. You do not have permission to save test reports.",
            )
        else:
            gate = _require_session_internal("reports-view", "Forbidden. You do not have permission to save reports.")
        if gate:
            return gate
        recipe = report_data.get("recipe") or (report_data.get("testData") or {}).get("recipe")
        enriched = report_service.generate_report(
            report_data,
            recipe=recipe,
            factory_settings=report_data.get("factorySettings"),
        )
        if (enriched.get("type") or "").strip().lower() in ("test", "validation", "calibration"):
            enriched = _stamp_report_operator(enriched)
            td = enriched.get("testData") if isinstance(enriched.get("testData"), dict) else {}
            run_status = str(td.get("status") or enriched.get("status") or "").strip().lower()
            if run_status == "aborted":
                enriched["reportApprovalStatus"] = "aborted"
            else:
                enriched["reportApprovalStatus"] = "pending"
                for k in ("approvalPassFail", "approvalRemarks", "approvedBy", "approvedAt", "approvedByUsername"):
                    enriched.pop(k, None)
        report_id = data_service.save_report(enriched)
        enriched = report_service.enrich_report_context({**enriched, "id": report_id})
        data_service.save_report(enriched)
        if (enriched.get("type") or "").strip().lower() == "validation":
            try:
                report_service.sync_factory_validation_dates()
            except Exception:
                app.logger.exception("Failed to sync factory validation dates after validation report")
        try:
            print_service.save_report_text_files(enriched, report_id, REPORTS_DIR)
        except Exception:
            pass
        approval_st = str(enriched.get("reportApprovalStatus") or "").strip().lower()
        pdf_ok = False
        if approval_st == "pending":
            _remove_report_pdf_file(report_id)
        elif approval_st == "aborted":
            try:
                pdf_ok = _generate_report_pdf_file(report_id, write_audit=False)
            except Exception:
                app.logger.exception("Aborted-report PDF on create failed for id %s", report_id)
        _audit_report_created(report_id, enriched)
        if approval_st == "aborted" and pdf_ok:
            _audit_report_pdf_generated(report_id, enriched)
        return jsonify({"id": report_id, "report": enriched}), 201
    except Exception as e:
        app.logger.exception("Error creating report")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/reports/<int:report_id>/approve", methods=["POST"])
def approve_report(report_id):
    try:
        token = (request.headers.get("X-Approval-Verify-Token") or "").strip()
        verified = None
        if token:
            verified, verify_err = _consume_approval_verify_token("report")
            if verify_err:
                return jsonify({"ok": False, "error": verify_err}), 401
        else:
            # Factory: no verifier modal — same trust model as recipe save (header + server session).
            if _effective_request_role() != "factory":
                return jsonify({"ok": False, "error": "Approval verification is required."}), 401
            cur = data_service.get_current_user() or {}
            display_name = (request.headers.get("X-User-Name") or "").strip() or (
                (cur.get("name") or "").strip() or (cur.get("username") or "").strip() or "Factory"
            )
            username_raw = (
                (request.headers.get("X-User-Username") or "").strip()
                or (cur.get("username") or "").strip()
                or (cur.get("name") or "").strip()
                or display_name
            )
            verified = {
                "username": username_raw,
                "name": display_name,
                "role": "factory",
            }
        body = request.get_json(force=True, silent=True) or {}
        pf = (body.get("passFail") or body.get("pass_fail") or "").strip().upper()
        if pf not in ("PASS", "FAIL"):
            return jsonify({"ok": False, "error": "passFail must be PASS or FAIL"}), 400
        remarks = (body.get("remarks") or "").strip()
        approver_name = (body.get("approverName") or "").strip()
        role_header = (request.headers.get("X-User-Role") or "").strip()
        report = data_service.get_report(report_id)
        if not report:
            return jsonify({"ok": False, "error": "Report not found"}), 404
        verified_username = _norm_username(verified.get("username"))
        st = report.get("reportApprovalStatus")
        if st is None:
            return jsonify({"ok": False, "error": "Report does not require approval"}), 400
        if st == "approved":
            existing_approver = _norm_username(report.get("approvedByUsername"))
            if existing_approver and existing_approver == verified_username:
                return jsonify({"ok": False, "error": "Same person cannot approve twice"}), 409
            return jsonify({"ok": True, "report": report}), 200
        if st != "pending":
            return jsonify({"ok": False, "error": "Invalid approval state"}), 400
        op_username = _report_operated_by_username(report)
        if op_username and verified_username == op_username and _effective_request_role() != "factory":
            return jsonify({"ok": False, "error": "Operator cannot approve their own report."}), 403
        report_type = _normalize_report_approval_type(report.get("type"))
        token_report_type = verified.get("reportType")
        if token_report_type is not None and str(token_report_type).strip() != "":
            if _normalize_report_approval_type(token_report_type) != report_type:
                return jsonify({
                    "ok": False,
                    "error": "Approval verification was issued for a different report type.",
                }), 403
        if _effective_request_role() != "factory":
            if not _approval_verifier_eligible_for_report(verified, report_type):
                if report_type == "calibration":
                    return jsonify({
                        "ok": False,
                        "error": "Verifier does not have calibration report approval permission.",
                    }), 403
                return jsonify({
                    "ok": False,
                    "error": "Verifier does not have report approval permission for this report type.",
                }), 403
        verified_name = (verified.get("name") or verified.get("username") or approver_name or "—").strip()
        verified_role = (verified.get("role") or role_header or "").strip()
        by_line = verified_name
        if verified_role:
            by_line = "{} ({})".format(verified_name, _display_role_label(verified_role))
        report["reportApprovalStatus"] = "approved"
        report["approvalPassFail"] = pf
        report["approvalRemarks"] = remarks
        report["approvedBy"] = by_line
        report["approvedByName"] = verified_name
        report["approvedByUsername"] = verified_username
        report["approvedAt"] = _utc_now_iso()
        data_service.save_report(report)
        pdf_ok = False
        try:
            pdf_ok = _generate_report_pdf_file(report_id, write_audit=False)
        except Exception:
            app.logger.exception("Approved-report PDF generation failed for id %s", report_id)
        if pdf_ok:
            _audit_report_pdf_generated(report_id, report)
        ctx = _format_report_audit_details(report_id, report)
        appr_detail = "{} | {} | verified by {}".format(ctx, pf, verified_name)
        v_audit_user = verified.get("username") or verified_username or verified_name
        v_audit_role = (verified.get("role") or "").strip() or "--"
        _audit(
            v_audit_user,
            v_audit_role,
            "Report approved",
            appr_detail,
        )
        return jsonify({"ok": True, "report": report}), 200
    except Exception as e:
        app.logger.exception("Error approving report")
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/data/reports/<int:report_id>/abort", methods=["POST"])
def abort_report(report_id):
    try:
        report = data_service.get_report(report_id)
        if not report:
            return jsonify({"ok": False, "error": "Report not found"}), 404
        rtype = (report.get("type") or "").strip().lower()
        if rtype == "validation":
            gate = _require_session_internal(
                "validation-test",
                "Forbidden. You do not have permission to abort validation reports.",
            )
        elif rtype == "test":
            gate = _require_any_session_internal(
                ["quick-test", "recipe-test"],
                "Forbidden. You do not have permission to abort test reports.",
            )
        else:
            gate = _require_session_internal("reports-view", "Forbidden.")
        if gate:
            return gate
        if rtype not in ("test", "validation"):
            return jsonify({"ok": False, "error": "Report type cannot be aborted"}), 400
        st = (report.get("reportApprovalStatus") or "").strip().lower()
        if st != "pending":
            return jsonify({"ok": False, "error": "Only pending reports can be aborted"}), 400
        cur = data_service.get_current_user() or {}
        session_un = _norm_username(cur.get("username") or cur.get("name"))
        op_un = _report_operated_by_username(report)
        role = _effective_request_role()
        if role != "factory" and session_un != op_un:
            return jsonify({"ok": False, "error": "Only the operator or Factory can abort this report."}), 403
        td = report.get("testData")
        if not isinstance(td, dict):
            td = {}
        else:
            td = dict(td)
        td["status"] = "aborted"
        report["testData"] = td
        report["status"] = "aborted"
        report["reportApprovalStatus"] = "aborted"
        if not report.get("completedAt"):
            report["completedAt"] = _utc_now_iso()
        data_service.save_report(report)
        pdf_ok = False
        try:
            pdf_ok = _generate_report_pdf_file(report_id, write_audit=False)
        except Exception:
            app.logger.exception("Aborted-report PDF generation failed for id %s", report_id)
        if pdf_ok:
            _audit_report_pdf_generated(report_id, report)
        ctx = _format_report_audit_details(report_id, report)
        abort_detail = ctx
        if pdf_ok:
            abort_detail = "{} | aborted PDF saved".format(ctx)
        _audit(session_un or None, role or None, "Report aborted", abort_detail)
        return jsonify({"ok": True, "report": report}), 200
    except Exception as e:
        app.logger.exception("Error aborting report")
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/data/reports/<int:report_id>", methods=["GET"])
def get_report(report_id):
    try:
        gate = _require_session_internal("reports-view", "Forbidden. You do not have permission to view reports.")
        if gate:
            return gate
        report = data_service.get_report(report_id)
        if report:
            return jsonify({"report": report}), 200
        return jsonify({"error": "Report not found"}), 404
    except Exception as e:
        app.logger.exception("Error getting report")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/reports/<int:report_id>", methods=["DELETE"])
def delete_report(report_id):
    try:
        gate = _require_session_internal("reports-delete", "Forbidden. You do not have permission to delete reports.")
        if gate:
            return gate
        existing = data_service.get_report(report_id)
        success = data_service.delete_report(report_id)
        if success:
            details = (
                _format_report_audit_details(report_id, existing)
                if existing
                else str(report_id)
            )
            _audit(None, None, "Report deleted", details)
            return jsonify({"success": True}), 200
        return jsonify({"error": "Report not found"}), 404
    except Exception as e:
        app.logger.exception("Error deleting report")
        return jsonify({"error": str(e)}), 500


# =================== DATA: MEMBERS ==========================


@app.route("/api/data/members", methods=["GET"])
def get_members():
    try:
        gate = _require_session_internal("user-manage", "Forbidden. You do not have permission to manage users.")
        if gate:
            return gate
        members = data_service.list_members()
        safe = [data_service.sanitize_member_for_client(m) or m for m in members]
        return jsonify({"members": safe}), 200
    except Exception as e:
        app.logger.exception("Error listing members")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/members", methods=["POST"])
def create_member():
    try:
        gate = _require_session_internal("user-add", "Forbidden. You do not have permission to add users.")
        if gate:
            return gate
        member_data = request.get_json(force=True, silent=True) or {}
        if _payload_has_protected_feature_overrides(member_data):
            return jsonify({"error": "Protected features cannot be overridden."}), 400
        if data_service.has_non_empty_feature_overrides(member_data) and not _can_assign_feature_overrides():
            return jsonify({"error": "Forbidden. Only Factory/Admin can assign feature overrides."}), 403
        member_id = data_service.save_member(member_data)
        created = data_service.get_member(member_id) or dict(member_data)
        cur = data_service.get_current_user() or {}
        sig = {
            "mode": "session",
            "username": (cur.get("username") or cur.get("name") or "").strip() or "--",
            "role": (cur.get("role") or "").strip() or "--",
        }
        uname = created.get("username") or created.get("name") or ""
        urole = created.get("role") or ""
        _audit_event(
            action="Added new user",
            outcome="success",
            entity_type="member",
            entity_id=member_id,
            entity_name=uname,
            details="Added new user: {} ({})".format(uname, _display_role_label(urole) if urole else "—"),
            target_user=uname,
            after=data_service.sanitize_member_for_client(created) or created,
            signature=sig,
        )
        safe = data_service.sanitize_member_for_client(created) or dict(created)
        return jsonify({"id": member_id, "member": safe}), 201
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        app.logger.exception("Error creating member")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/members/<int:member_id>", methods=["GET"])
def get_member(member_id):
    try:
        gate = _require_user_manage_or_self(member_id)
        if gate:
            return gate
        member = data_service.get_member(member_id)
        if member:
            return jsonify({"member": data_service.sanitize_member_for_client(member) or member}), 200
        return jsonify({"error": "Member not found"}), 404
    except Exception as e:
        app.logger.exception("Error getting member")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/members/<int:member_id>", methods=["PUT"])
def update_member(member_id):
    try:
        gate = _require_user_manage_or_self(member_id)
        if gate:
            return gate
        member_data = request.get_json(force=True, silent=True) or {}
        before_member = data_service.get_member(member_id)
        if not before_member:
            return jsonify({"error": "Member not found"}), 404
        new_status = str(member_data.get("status") or "").strip().lower()
        old_status = str(before_member.get("status") or "active").strip().lower()
        if new_status == "disabled" and old_status != "disabled":
            return jsonify({
                "error": "Use DELETE /api/data/members/{id} with admin verification to disable a member."
            }), 400
        is_self = _is_self_member(member_id)
        if is_self:
            try:
                member_data = _self_profile_payload_from_request(before_member, member_data)
            except ValueError as e:
                return jsonify({"error": str(e)}), 400
        elif _payload_has_protected_feature_overrides(member_data):
            return jsonify({"error": "Protected features cannot be overridden."}), 400
        if not is_self and data_service.has_non_empty_feature_overrides(member_data) and not _can_assign_feature_overrides():
            return jsonify({"error": "Forbidden. Only Factory/Admin can assign feature overrides."}), 403
        member_data["id"] = member_id
        cur = data_service.get_current_user() or {}
        acting_id = cur.get("id")
        password_changed = "password" in member_data and member_data.get("password") not in (None, "")
        data_service.save_member(member_data, acting_user_id=acting_id)
        updated = data_service.get_member(member_id) or dict(member_data)
        sig = {
            "mode": "session",
            "username": (cur.get("username") or cur.get("name") or "").strip() or "--",
            "role": (cur.get("role") or "").strip() or "--",
        }
        uname = updated.get("username") or updated.get("name") or ""
        if password_changed:
            _audit_event(
                action="Password changed",
                outcome="success",
                entity_type="member",
                entity_id=member_id,
                entity_name=uname,
                details="Password changed for user: {}".format(uname),
                target_user=uname,
                signature=sig,
            )
        perm_audit = None
        try:
            perm_audit = rbac_service.build_permission_change_audit(before_member, updated, uname)
        except Exception:
            perm_audit = None
        if perm_audit:
            _audit_event(
                action="User permissions updated",
                outcome="success",
                entity_type="member",
                entity_id=member_id,
                entity_name=uname,
                details=perm_audit.get("details") or "User permissions updated",
                target_user=uname,
                before=perm_audit.get("before"),
                after=perm_audit.get("after"),
                signature=sig,
                extra=perm_audit.get("extra") or {},
            )
        _audit_event(
            action="User update",
            outcome="success",
            entity_type="member",
            entity_id=member_id,
            entity_name=uname,
            details="Member updated: {}".format(uname),
            target_user=uname,
            before=data_service.sanitize_member_for_client(before_member) if before_member else None,
            after=data_service.sanitize_member_for_client(updated) or updated,
            signature=sig,
        )
        safe = data_service.sanitize_member_for_client(updated) or dict(updated)
        return jsonify({"id": member_id, "member": safe}), 200
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        app.logger.exception("Error updating member")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/members/<int:member_id>", methods=["DELETE"])
def delete_member(member_id):
    try:
        gate = _require_session_internal("user-delete", "Forbidden. You do not have permission to delete users.")
        if gate:
            return gate
        member = data_service.get_member(member_id)
        if not member:
            return jsonify({"error": "Member not found"}), 404
        target = (member.get("username") or member.get("name") or "").strip() or "--"
        actor_info = _audit_actor()
        actor = (actor_info.get("user") or "").strip() or "--"
        actor_role = (actor_info.get("role") or "").strip() or "--"
        before_member = dict(member)
        # Soft-disable only; keep fingerprint on sensor. Disabled status blocks login.
        member = data_service.disable_member(member_id)
        _audit_event(
            action="User disabled",
            outcome="success",
            entity_type="member",
            entity_id=member_id,
            entity_name=target,
            details="{} disabled {}".format(actor, target),
            target_user=target,
            before=before_member,
            after=member,
            signature={"mode": "session", "username": actor, "role": actor_role},
            actor_user=actor,
            actor_role=actor_role,
        )
        return jsonify({"success": True, "member": member}), 200
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        app.logger.exception("Error deleting member")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/members/<int:member_id>/unlock", methods=["POST"])
def unlock_member_route(member_id):
    if not _session_has_internal("user-unlock"):
        return jsonify({"error": "Forbidden. Unlock requires profile management permission."}), 403
    try:
        before_member = data_service.get_member(member_id)
        cur = data_service.get_current_user() or {}
        sig = {
            "mode": "session",
            "username": (cur.get("username") or cur.get("name") or "").strip() or "--",
            "role": (cur.get("role") or "").strip() or "--",
        }
        member = data_service.unlock_member(member_id)
        _audit_event(
            action="User unlocked",
            outcome="success",
            entity_type="member",
            entity_id=member_id,
            entity_name=member.get("username") or member.get("name") or "",
            details="Member unlocked: {}".format(member.get("username") or member.get("name") or ""),
            target_user=member.get("username") or "",
            before=data_service.sanitize_member_for_client(before_member) if before_member else None,
            after=data_service.sanitize_member_for_client(member) or member,
            signature=sig,
        )
        safe = data_service.sanitize_member_for_client(member) or dict(member)
        return jsonify({"success": True, "member": safe}), 200
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        app.logger.exception("Error unlocking member")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/members/<int:member_id>/enable", methods=["POST"])
def enable_member_route(member_id):
    if not _session_has_internal("user-enable"):
        return jsonify({"error": "Forbidden. Enable requires profile management permission."}), 403
    try:
        before_member = data_service.get_member(member_id)
        cur = data_service.get_current_user() or {}
        sig = {
            "mode": "session",
            "username": (cur.get("username") or cur.get("name") or "").strip() or "--",
            "role": (cur.get("role") or "").strip() or "--",
        }
        member = data_service.enable_member(member_id)
        target = (member.get("username") or member.get("name") or "").strip() or "--"
        actor = (sig.get("username") or "--").strip() or "--"
        _audit_event(
            action="User enabled",
            outcome="success",
            entity_type="member",
            entity_id=member_id,
            entity_name=target,
            details="{} enabled {}".format(actor, target),
            target_user=target,
            before=data_service.sanitize_member_for_client(before_member) if before_member else None,
            after=data_service.sanitize_member_for_client(member) or member,
            signature=sig,
            actor_user=actor,
        )
        safe = data_service.sanitize_member_for_client(member) or dict(member)
        return jsonify({"success": True, "member": safe}), 200
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        app.logger.exception("Error enabling member")
        return jsonify({"error": str(e)}), 500


# =================== DATA: FACTORY SETTINGS ==========================


@app.route("/api/data/factory-settings", methods=["GET"])
def get_factory_settings():
    try:
        raw = data_service.get_factory_settings() or {}
        if not isinstance(raw, dict):
            raw = {}
        settings = dict(raw)
        enriched = report_service.enrich_factory_settings(raw) or {}
        if isinstance(enriched, dict):
            for key in ("lastValidationDate", "nextValidationDate"):
                if enriched.get(key):
                    settings[key] = enriched[key]
        return jsonify({"settings": settings}), 200
    except Exception as e:
        app.logger.exception("Error getting factory settings")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/factory-settings", methods=["POST"])
def save_factory_settings():
    try:
        settings = request.get_json(force=True, silent=True) or {}
        data_service.save_factory_settings(settings)
        _audit(None, None, "Factory settings changed", "")
        return jsonify({"success": True, "settings": settings}), 200
    except Exception as e:
        app.logger.exception("Error saving factory settings")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/factory-reset", methods=["POST"])
def factory_reset():
    try:
        user = data_service.get_current_user()
        if not user or (user.get("role") or "").strip().lower() != "factory":
            return jsonify({"error": "Forbidden. Factory role required."}), 403

        data_service.delete_session_power_audit_pending()
        result = data_service.factory_reset()
        data_service.touch_app_clean_stop_flag()

        audit_removed = audit_service.clear_all_entries()
        audit_remaining = audit_service.entry_count()
        if audit_remaining > 0:
            audit_removed += audit_service.clear_all_entries()
            audit_remaining = audit_service.entry_count()

        biometric_cleared = False
        try:
            bio_result = biometric_service.clear_templates()
            biometric_cleared = bool(bio_result and bio_result.get("ok"))
        except Exception as bio_err:
            app.logger.warning("Factory reset: biometric clear skipped: %s", bio_err)

        if DATETIME_STORAGE.exists():
            try:
                DATETIME_STORAGE.unlink()
            except Exception:
                pass

        return jsonify({
            "success": True,
            "deleted": result["deleted"],
            "auditRowsRemoved": audit_removed,
            "auditRowsRemaining": audit_remaining,
            "biometricTemplatesCleared": biometric_cleared,
            "requiresLogin": True,
            "settings": result.get("factorySettings") or {},
            "preservedFactorySettings": bool(result.get("preservedFactorySettings")),
        }), 200
    except Exception as e:
        app.logger.exception("Error during factory reset")
        return jsonify({"error": str(e)}), 500


# =================== DATA: AUTH ==========================


def _password_strength_error(password: str) -> str:
    pwd = str(password or "")
    if len(pwd) < 8:
        return "Password must be at least 8 characters."
    if not any(ch.isupper() for ch in pwd):
        return "Password must include at least one uppercase letter."
    if not any(ch.islower() for ch in pwd):
        return "Password must include at least one lowercase letter."
    if not any(ch.isdigit() for ch in pwd):
        return "Password must include at least one numeric digit."
    if pwd.isalnum():
        return "Password must include at least one special character."
    return ""


def _release_esp_pressure_on_login():
    """Best-effort ESP stop after successful login so trapped vacuum/pressure is released."""
    try:
        hardware_service.cmd_stop()
    except Exception:
        app.logger.exception("ESP stop after login failed (login still succeeds)")


@app.route("/api/data/auth/login", methods=["POST"])
def login():
    try:
        credentials = request.get_json(force=True, silent=True) or {}
        if not isinstance(credentials, dict):
            credentials = {}
        username = (credentials.get("username") or "").strip()
        raw_pw = credentials.get("password")
        if isinstance(raw_pw, str):
            password = raw_pw
        elif raw_pw is None:
            password = ""
        else:
            password = str(raw_pw)
        # Factory user: special case, not subject to lockout
        if username.upper() == data_service.FACTORY_USERNAME.upper():
            user = data_service.authenticate_user(username, password)
            if user:
                data_service.save_current_user(user)
                data_service.write_session_power_audit_pending(user)
                _audit_event(
                    action="Login",
                    outcome="success",
                    entity_type="session",
                    entity_name="password",
                    details="User logged in: {}".format(username),
                    target_user=username,
                    after={"username": user.get("username"), "role": user.get("role")},
                )
                _release_esp_pressure_on_login()
                return jsonify({"success": True, "user": data_service.sanitize_member_for_client(user) or user}), 200
            return jsonify({"error": "Invalid username or password"}), 401

        # Normal member: check status first
        member = data_service.get_member_by_username(username)
        if member:
            status = str(member.get("status") or "active").strip().lower()
            if status == "locked":
                _audit_event(
                    action="Login",
                    outcome="denied",
                    entity_type="session",
                    entity_name="password",
                    details="{} tried to log in. Account is locked.".format(username),
                    target_user=username,
                    actor_user=username,
                )
                return jsonify({"error": "Account locked. Contact admin."}), 403
            if status == "disabled":
                _audit_event(
                    action="Login",
                    outcome="denied",
                    entity_type="session",
                    entity_name="password",
                    details="{} tried to log in. Account is disabled.".format(username),
                    target_user=username,
                    actor_user=username,
                )
                return jsonify({"error": "Account disabled by admin."}), 403

        # Try authenticate
        user = data_service.authenticate_user(username, password)
        if user:
            member = data_service.get_member_by_username(username)
            if member:
                if bool(member.get("mustChangePassword")):
                    _audit_event(
                        action="Login",
                        outcome="denied",
                        entity_type="session",
                        entity_name="password",
                        details="Mandatory password reset required before login",
                        target_user=username,
                    )
                    return jsonify(
                        {
                            "error": "Password change required before login.",
                            "passwordChangeRequired": True,
                            "username": username,
                        }
                    ), 403
                expiry = data_service.get_member_password_expiry_state(member)
                if bool(expiry.get("expired")):
                    _audit_event(
                        action="Login",
                        outcome="denied",
                        entity_type="session",
                        entity_name="password",
                        details="Password expired - reset required",
                        target_user=username,
                        extra={"passwordExpiry": expiry},
                    )
                    return jsonify({
                        "error": "Password expired. Reset required.",
                        "passwordExpired": True,
                        "username": username,
                        "expiry": expiry,
                    }), 403
            data_service.record_successful_login(username)
            data_service.save_current_user(user)
            data_service.refresh_current_user_from_member()
            data_service.write_session_power_audit_pending(data_service.get_current_user() or user)
            _audit_event(
                action="Login",
                outcome="success",
                entity_type="session",
                entity_name="password",
                details="User logged in: {}".format(username),
                target_user=username,
                after={"username": user.get("username"), "role": user.get("role")},
            )
            safe_user = data_service.sanitize_member_for_client(data_service.get_current_user() or user) or user
            _release_esp_pressure_on_login()
            return jsonify({"success": True, "user": safe_user}), 200

        # Wrong password: increment failedAttempts (may lock at 3)
        updated = data_service.record_failed_login(username)
        if updated:
            status = str(updated.get("status") or "").strip().lower()
            try:
                fa = int(updated.get("failedAttempts") or 0)
            except (TypeError, ValueError):
                fa = 0
            remaining = max(0, 3 - fa)
            attempt_n = min(max(fa, 1), 3)
            _audit_event(
                action="Login",
                outcome="denied",
                entity_type="session",
                entity_name="password",
                details="Invalid password for {}: attempt {}/3".format(username, attempt_n),
                target_user=username,
                actor_user=username,
                extra={"failedAttempts": fa, "remainingAttempts": remaining, "attempt": attempt_n},
            )
            # If this attempt caused the account to become locked, show lockout immediately
            if status == "locked":
                _audit_event(
                    action="Login",
                    outcome="denied",
                    entity_type="session",
                    entity_name="password",
                    details="{} tried to log in. Account is locked.".format(username),
                    target_user=username,
                    actor_user=username,
                )
                _audit_event(
                    action="User locked",
                    outcome="denied",
                    entity_type="member",
                    entity_name=username,
                    details="Account locked for {} after failed password attempts (3/3)".format(username),
                    target_user=username,
                    after={"username": username, "status": "locked", "failedAttempts": fa},
                )
                return jsonify({
                    "error": "Account locked. Contact admin.",
                    "remainingAttempts": 0
                }), 403
            return jsonify({
                "error": "Invalid username or password.",
                "remainingAttempts": remaining
            }), 401
        return jsonify({"error": "Invalid username or password"}), 401
    except Exception as e:
        app.logger.exception("Error during login")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/auth/change-password", methods=["POST"])
def change_own_password():
    """Logged-in member changes own password after verifying the current password."""
    try:
        err = _require_auth()
        if err:
            return err
        payload = request.get_json(force=True, silent=True) or {}
        old_password = str(payload.get("oldPassword") or "")
        new_password = str(payload.get("newPassword") or "")
        if not old_password or not new_password:
            return jsonify({"ok": False, "error": "oldPassword and newPassword are required"}), 400
        member, cur = _resolve_session_member_record()
        if not member:
            if cur and str((cur.get("username") or "")).strip().upper() == data_service.FACTORY_USERNAME.upper():
                return jsonify({"ok": False, "error": "Factory password cannot be changed from Profile."}), 400
            return jsonify({"ok": False, "error": "Member not found"}), 404
        username = str(member.get("username") or "").strip()
        if not username:
            return jsonify({"ok": False, "error": "Member not found"}), 404
        auth_user = data_service.authenticate_user(username, old_password)
        if not auth_user:
            return jsonify({"ok": False, "error": "Current password is incorrect"}), 401
        pwd_err = _password_strength_error(new_password)
        if pwd_err:
            return jsonify({"ok": False, "error": pwd_err}), 400
        if old_password == new_password:
            return jsonify({"ok": False, "error": "New password must be different from your current password."}), 400
        member_id = int(member.get("id"))
        data_service.set_member_password(member_id, new_password)
        data_service.clear_mandatory_password_reset_flags(member_id)
        updated = data_service.get_member(member_id) or member
        data_service.refresh_current_user_from_member()
        cur_after = data_service.get_current_user() or {}
        sig = {
            "mode": "self",
            "username": (cur_after.get("username") or cur_after.get("name") or "").strip() or "--",
            "role": (cur_after.get("role") or "").strip() or "--",
        }
        uname = updated.get("username") or updated.get("name") or ""
        _audit_event(
            action="Password changed",
            outcome="success",
            entity_type="member",
            entity_id=member_id,
            entity_name=uname,
            details="Password changed (self, verified current password) for user: {}".format(uname),
            target_user=uname,
            signature=sig,
        )
        safe = data_service.sanitize_member_for_client(updated) or dict(updated)
        return jsonify({"ok": True, "member": safe}), 200
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    except Exception as e:
        app.logger.exception("Error changing own password")
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/data/auth/password-expired-reset", methods=["POST"])
def password_expired_reset():
    try:
        payload = request.get_json(force=True, silent=True) or {}
        username = str(payload.get("username") or "").strip()
        old_password = str(payload.get("oldPassword") or "")
        new_password = str(payload.get("newPassword") or "")
        if not username or not old_password or not new_password:
            return jsonify({"ok": False, "error": "username, oldPassword and newPassword are required"}), 400
        member = data_service.get_member_by_username(username)
        if not member:
            return jsonify({"ok": False, "error": "Invalid username or password"}), 401
        if str(member.get("username", "")).strip().upper() == data_service.FACTORY_USERNAME.upper():
            return jsonify({"ok": False, "error": "Factory account is excluded from this flow"}), 403
        auth_user = data_service.authenticate_user(username, old_password)
        if not auth_user:
            return jsonify({"ok": False, "error": "Invalid username or password"}), 401
        expiry = data_service.get_member_password_expiry_state(member)
        if not bool(expiry.get("expired")):
            return jsonify({"ok": False, "error": "Password is not expired for this account"}), 400
        pwd_err = _password_strength_error(new_password)
        if pwd_err:
            return jsonify({"ok": False, "error": pwd_err}), 400
        if old_password == new_password:
            return jsonify({"ok": False, "error": "New password must be different from old password"}), 400
        updated_member = data_service.set_member_password(int(member.get("id")), new_password)
        data_service.clear_mandatory_password_reset_flags(int(member.get("id")))
        updated_member = data_service.get_member(int(member.get("id"))) or updated_member
        data_service.record_successful_login(username)
        safe_member = data_service.sanitize_member_for_client(updated_member) or dict(updated_member)
        _audit_event(
            action="Password reset",
            outcome="success",
            entity_type="member",
            entity_id=updated_member.get("id"),
            entity_name=updated_member.get("username") or updated_member.get("name") or "",
            details="Password reset after expiry",
            target_user=updated_member.get("username") or "",
        )
        return jsonify({"ok": True, "member": safe_member}), 200
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    except Exception as e:
        app.logger.exception("Error resetting expired password")
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/data/auth/mandatory-password-reset", methods=["POST"])
def mandatory_password_reset():
    try:
        payload = request.get_json(force=True, silent=True) or {}
        username = str(payload.get("username") or "").strip()
        old_password = str(payload.get("oldPassword") or "")
        new_password = str(payload.get("newPassword") or "")
        if not username or not old_password or not new_password:
            return jsonify({"ok": False, "error": "username, oldPassword and newPassword are required"}), 400
        member = data_service.get_member_by_username(username)
        if not member:
            return jsonify({"ok": False, "error": "Invalid username or password"}), 401
        if str(member.get("username", "")).strip().upper() == data_service.FACTORY_USERNAME.upper():
            return jsonify({"ok": False, "error": "Factory account is excluded from this flow"}), 403
        if not bool(member.get("mustChangePassword")):
            return jsonify({"ok": False, "error": "Password change is not required for this account"}), 400
        auth_user = data_service.authenticate_user(username, old_password)
        if not auth_user:
            return jsonify({"ok": False, "error": "Invalid username or password"}), 401
        pwd_err = _password_strength_error(new_password)
        if pwd_err:
            return jsonify({"ok": False, "error": pwd_err}), 400
        if old_password == new_password:
            return jsonify({"ok": False, "error": "New password must be different from your current password."}), 400
        if data_service.new_password_matches_creation_commitment(member, new_password):
            return jsonify(
                {"ok": False, "error": "New password must be different from the password set when your account was created."}
            ), 400
        data_service.complete_mandatory_password_reset(username, new_password)
        data_service.record_successful_login(username)
        refreshed = data_service.get_member(int(member.get("id")))
        user = dict(refreshed) if refreshed else dict(auth_user)
        user.pop("password", None)
        user.pop("creationPasswordSalt", None)
        user.pop("creationPasswordHash", None)
        data_service.save_current_user(user)
        data_service.write_session_power_audit_pending(user)
        safe_user = data_service.sanitize_member_for_client(user) or user
        _audit_event(
            action="Password reset",
            outcome="success",
            entity_type="member",
            entity_id=member.get("id"),
            entity_name=member.get("username") or member.get("name") or "",
            details="Mandatory first password change completed",
            target_user=member.get("username") or "",
        )
        return jsonify({"ok": True, "user": safe_user}), 200
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    except Exception as e:
        app.logger.exception("Error during mandatory password reset")
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/data/auth/login-biometric", methods=["POST"])
def login_biometric():
    try:
        if not _is_biometric_enabled():
            return jsonify({"error": "Biometric login is disabled by Factory Settings."}), 403
        payload = request.get_json(force=True, silent=True) or {}
        timeout_sec = float(payload.get("timeoutSec") or BIOMETRIC_LOGIN_TIMEOUT_SEC)
        identified = biometric_service.identify(timeout_sec=timeout_sec)
        if not identified.get("ok"):
            return jsonify({"error": identified.get("error") or "Fingerprint not recognized"}), 401

        template_id = identified.get("templateId")
        member = data_service.get_member_by_fingerprint_template(template_id)
        if not member:
            # After power-loss remount-ro the bridge may be on empty SD storage.
            # Re-seed from USB (if readable) and re-resolve storage, then retry once.
            try:
                data_service._seed_storage_from_readonly_usb(data_service._sd_storage_dir())
            except Exception:
                pass
            try:
                data_service._refresh_storage_dir()
            except Exception:
                pass
            member = data_service.get_member_by_fingerprint_template(template_id)
        if not member:
            return jsonify({
                "error": (
                    "Fingerprint template {} is not linked to any member on the current account. "
                    "Use password login, or re-enroll the fingerprint for this user."
                ).format(template_id)
            }), 404

        username = member.get("username") or ""
        status = str(member.get("status") or "active").strip().lower()
        if status == "locked":
            _audit_event(
                action="Biometric login",
                outcome="denied",
                entity_type="session",
                entity_name="biometric",
                details="{} tried to log in. Account is locked.".format(username),
                target_user=username,
                actor_user=username,
                extra={"templateId": template_id},
            )
            return jsonify({"error": "Account locked. Contact admin."}), 403
        if status == "disabled":
            _audit_event(
                action="Biometric login",
                outcome="denied",
                entity_type="session",
                entity_name="biometric",
                details="{} tried to log in. Account is disabled.".format(username),
                target_user=username,
                actor_user=username,
                extra={"templateId": template_id},
            )
            return jsonify({"error": "Account disabled by admin."}), 403

        if not bool(member.get("biometricEnabled", True)):
            _audit_event(action="Biometric login", outcome="denied", entity_type="session", entity_name="biometric", details="Biometric disabled for member", target_user=username, extra={"templateId": template_id})
            return jsonify({"error": "Biometric login is disabled for this account"}), 403

        if bool(member.get("mustChangePassword")):
            _audit_event(
                action="Biometric login",
                outcome="denied",
                entity_type="session",
                entity_name="biometric",
                details="Mandatory password reset required before login",
                target_user=username,
                extra={"templateId": template_id},
            )
            return jsonify(
                {
                    "error": "Password change required before login.",
                    "passwordChangeRequired": True,
                    "username": username,
                }
            ), 403

        user = dict(member)
        user.pop("password", None)
        user.pop("creationPasswordSalt", None)
        user.pop("creationPasswordHash", None)
        data_service.record_successful_login(username)
        data_service.save_current_user(user)
        data_service.write_session_power_audit_pending(user)
        _audit_event(
            action="Biometric login",
            outcome="success",
            entity_type="session",
            entity_name="biometric",
            details="User logged in (biometric): {}".format(username),
            target_user=username,
            after={"username": user.get("username"), "role": user.get("role")},
            extra={"templateId": template_id, "confidence": identified.get("confidence")},
        )
        _release_esp_pressure_on_login()
        return jsonify({"success": True, "user": data_service.sanitize_member_for_client(user) or user, "templateId": template_id, "confidence": identified.get("confidence")}), 200
    except Exception as e:
        app.logger.exception("Error during biometric login")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/auth/logout", methods=["POST"])
def logout():
    try:
        payload = request.get_json(force=True, silent=True) or {}
        reason = str(payload.get("reason") or "user").strip().lower()
        user = data_service.get_current_user()
        if user:
            un = (user.get("username") or user.get("name") or "").strip()
            role = (user.get("role") or "").strip()
            if audit_service.is_hidden_factory_actor(un, role):
                audit_time = _audit_time_fields()
                audit_service.log_structured_event(
                    user="--",
                    role="--",
                    action="Logout",
                    outcome="success",
                    entity_type="session",
                    entity_name="logout",
                    details="Privileged factory session ended",
                    event_type="compliance",
                    request_source="POST /api/data/auth/logout",
                    timestamp_ms=audit_time.get("timestamp_ms"),
                    date_time=audit_time.get("date_time"),
                )
            else:
                if reason == "inactivity":
                    fs = data_service.get_factory_settings() or {}
                    mins = fs.get("autoLogoutMinutes")
                    try:
                        mins = int(mins) if mins is not None else 0
                    except (TypeError, ValueError):
                        mins = 0
                    detail = "User logged out due to inactivity timeout: {}".format(un)
                    _audit_event(
                        action="Logout (inactivity timeout)",
                        outcome="success",
                        entity_type="session",
                        entity_name="logout",
                        details=detail,
                        target_user=un,
                        extra={"autoLogoutMinutes": mins} if mins > 0 else None,
                    )
                else:
                    _audit_event(
                        action="Logout",
                        outcome="success",
                        entity_type="session",
                        entity_name="logout",
                        details="User logged out: {}".format(un),
                        target_user=un,
                    )
        data_service.touch_app_clean_stop_flag()
        data_service.delete_session_power_audit_pending()
        data_service.clear_current_user()
        return jsonify({"success": True}), 200
    except Exception as e:
        app.logger.exception("Error during logout")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/auth/session-ui-reset", methods=["POST"])
def session_ui_reset():
    """Clear persisted kiosk session when the browser loads or refreshes.

    Not a user-initiated logout: no audit entry (avoids false Logout on every refresh).
    """
    try:
        data_service.delete_session_power_audit_pending()
        data_service.clear_current_user()
        return jsonify({"success": True}), 200
    except Exception as e:
        app.logger.exception("Error during session UI reset")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/auth/approval-verify", methods=["POST"])
def approval_verify():
    try:
        payload = request.get_json(force=True, silent=True) or {}
        method = str(payload.get("method") or "credentials").strip().lower()
        purpose = str(payload.get("purpose") or "recipe").strip().lower()
        if purpose not in ("recipe", "report", "user_admin", "export"):
            return jsonify({"ok": False, "error": "purpose must be recipe, report, or user_admin"}), 400
        verifier = None
        username = (payload.get("username") or "").strip()

        if method == "credentials":
            password = str(payload.get("password") or "").strip()
            if not username or not password:
                return jsonify({"ok": False, "error": "Username and password are required"}), 400
            verifier = data_service.authenticate_user(username, password)
            if not verifier:
                _audit_event(
                    action="Approval verification",
                    outcome="failed",
                    entity_type="verification",
                    entity_name=purpose,
                    details="Invalid credentials",
                    target_user=username,
                    extra={"purpose": purpose, "attemptedUser": username, "method": "credentials"},
                )
                return jsonify({"ok": False, "error": "Invalid verifier username or password"}), 401
        elif method == "biometric":
            if not _is_biometric_enabled():
                return jsonify({"ok": False, "error": "Biometric login is disabled by Factory Settings."}), 403
            timeout_sec = float(payload.get("timeoutSec") or BIOMETRIC_LOGIN_TIMEOUT_SEC)
            identified = biometric_service.identify(timeout_sec=timeout_sec)
            if not identified.get("ok"):
                _audit_event(
                    action="Approval verification",
                    outcome="failed",
                    entity_type="verification",
                    entity_name=purpose,
                    details=identified.get("error") or "Biometric identify failed",
                    target_user="--",
                    extra={"purpose": purpose, "method": "biometric"},
                )
                return jsonify({"ok": False, "error": identified.get("error") or "Fingerprint not recognized"}), 401
            template_id = identified.get("templateId")
            member = data_service.get_member_by_fingerprint_template(template_id)
            if not member:
                try:
                    data_service._refresh_storage_dir()
                except Exception:
                    pass
                member = data_service.get_member_by_fingerprint_template(template_id)
            if not member:
                _audit_event(
                    action="Approval verification",
                    outcome="failed",
                    entity_type="verification",
                    entity_name=purpose,
                    details="No member mapped to fingerprint",
                    target_user="--",
                    extra={"purpose": purpose, "method": "biometric", "templateId": template_id},
                )
                return jsonify({
                    "ok": False,
                    "error": "Fingerprint is not linked to any member account (template {}).".format(template_id)
                }), 404
            status = str(member.get("status") or "active").strip().lower()
            if status != "active":
                _audit_event(
                    action="Approval verification",
                    outcome="denied",
                    entity_type="verification",
                    entity_name=purpose,
                    details="Verifier account not active",
                    target_user=member.get("username") or "--",
                    extra={"purpose": purpose, "method": "biometric", "templateId": template_id},
                )
                return jsonify({"ok": False, "error": "Verifier account is not active"}), 403
            if not bool(member.get("biometricEnabled", True)):
                _audit_event(
                    action="Approval verification",
                    outcome="denied",
                    entity_type="verification",
                    entity_name=purpose,
                    details="Verifier biometric disabled",
                    target_user=member.get("username") or "--",
                    extra={"purpose": purpose, "method": "biometric", "templateId": template_id},
                )
                return jsonify({"ok": False, "error": "Biometric login is disabled for this account"}), 403
            verifier = dict(member)
            username = verifier.get("username") or ""
        else:
            return jsonify({"ok": False, "error": "Unsupported verification method"}), 400

        verifier_role = str(verifier.get("role") or "").strip().lower()
        report_type = _normalize_report_approval_type(payload.get("reportType") or payload.get("report_type"))
        if purpose == "report":
            eligible = _approval_verifier_eligible_for_report(verifier, report_type)
        elif purpose == "recipe":
            eligible = _approval_verifier_eligible_for_recipe(verifier)
        elif purpose == "export":
            eligible = rbac_service.member_has_internal(
                _approval_verifier_member(verifier), "export-approve"
            )
        else:
            eligible = _approval_verifier_eligible_for_user_admin(verifier)
        if not eligible:
            _audit_event(
                action="Approval verification",
                outcome="denied",
                entity_type="verification",
                entity_name=purpose,
                details="Verifier lacks required permission",
                target_user=verifier.get("username") or username,
                extra={
                    "purpose": purpose,
                    "reportType": report_type if purpose == "report" else None,
                    "verifierRole": verifier_role,
                    "method": method,
                },
            )
            err = "Verifier does not have permission for this approval"
            if purpose == "report" and report_type == "calibration":
                err = "Verifier does not have calibration report approval permission"
            return jsonify({"ok": False, "error": err}), 403

        if verifier_role != "factory":
            member = data_service.get_member_by_username(verifier.get("username") or username)
            if member:
                status = str(member.get("status") or "active").strip().lower()
                if status != "active":
                    _audit_event(
                        action="Approval verification",
                        outcome="denied",
                        entity_type="verification",
                        entity_name=purpose,
                        details="Verifier account not active",
                        target_user=verifier.get("username") or username,
                        extra={"purpose": purpose, "method": method},
                    )
                    return jsonify({"ok": False, "error": "Verifier account is not active"}), 403

        token, token_payload = _issue_approval_verify_token(
            verifier, purpose, report_type if purpose == "report" else None
        )
        vname = verifier.get("username") or username
        _audit_event(
            action="Approval verification",
            outcome="success",
            entity_type="verification",
            entity_name=purpose,
            details="Verification token issued",
            target_user=vname,
            signature={"mode": method, "username": vname, "role": verifier_role},
            extra={"purpose": purpose, "method": method},
        )
        return jsonify(
            {
                "ok": True,
                "token": token,
                "expiresInSec": APPROVAL_VERIFY_TTL_SECONDS,
                "verifier": {
                    "username": token_payload.get("username"),
                    "name": token_payload.get("name"),
                    "role": token_payload.get("role"),
                },
            }
        ), 200
    except Exception as e:
        app.logger.exception("Error during approval verification")
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/data/auth/current-user", methods=["GET"])
def get_current_user_route():
    try:
        user = data_service.refresh_current_user_from_member() or data_service.get_current_user()
        if user:
            user = data_service.sanitize_member_for_client(user) or user
        return jsonify({"user": user}), 200
    except Exception as e:
        app.logger.exception("Error getting current user")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/auth/profile", methods=["GET"])
def get_own_profile():
    """Any logged-in member may read their own profile (for the User Profile screen)."""
    try:
        err = _require_auth()
        if err:
            return err
        member, cur = _resolve_session_member_record()
        if member:
            return jsonify({"member": data_service.sanitize_member_for_client(member) or member}), 200
        if cur:
            return jsonify({"member": data_service.sanitize_member_for_client(cur) or cur}), 200
        return jsonify({"error": "Member not found"}), 404
    except Exception as e:
        app.logger.exception("Error getting own profile")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/auth/profile", methods=["PUT"])
def update_own_profile():
    """Any logged-in member may change their own display name and password."""
    try:
        err = _require_auth()
        if err:
            return err
        payload = request.get_json(force=True, silent=True) or {}
        member, cur = _resolve_session_member_record()
        if not member:
            if cur and str((cur.get("username") or "")).strip().upper() == data_service.FACTORY_USERNAME.upper():
                return jsonify({"error": "Factory profile is managed locally on this device."}), 400
            return jsonify({"error": "Member not found"}), 404
        member_id = int(member.get("id"))
        before_member = dict(member)
        try:
            member_data = _self_profile_payload_from_request(before_member, payload)
        except ValueError as e:
            return jsonify({"error": str(e)}), 400
        name_in = "name" in payload and str(payload.get("name") or "").strip()
        pwd_in = "password" in payload and str(payload.get("password") or "").strip()
        if not name_in and not pwd_in:
            return jsonify({"error": "Provide a name and/or new password to save."}), 400
        acting_id = _session_member_id()
        password_changed = pwd_in
        data_service.save_member(member_data, acting_user_id=acting_id)
        updated = data_service.get_member(member_id) or member_data
        data_service.refresh_current_user_from_member()
        cur_after = data_service.get_current_user() or {}
        sig = {
            "mode": "self",
            "username": (cur_after.get("username") or cur_after.get("name") or "").strip() or "--",
            "role": (cur_after.get("role") or "").strip() or "--",
        }
        uname = updated.get("username") or updated.get("name") or ""
        if password_changed:
            _audit_event(
                action="Password changed",
                outcome="success",
                entity_type="member",
                entity_id=member_id,
                entity_name=uname,
                details="Password changed (self) for user: {}".format(uname),
                target_user=uname,
                signature=sig,
            )
        _audit_event(
            action="Profile updated",
            outcome="success",
            entity_type="member",
            entity_id=member_id,
            entity_name=uname,
            details="Profile updated (self)",
            target_user=uname,
            before=data_service.sanitize_member_for_client(before_member),
            after=data_service.sanitize_member_for_client(updated) or updated,
            signature=sig,
        )
        safe = data_service.sanitize_member_for_client(updated) or dict(updated)
        return jsonify({"ok": True, "member": safe}), 200
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        app.logger.exception("Error updating own profile")
        return jsonify({"error": str(e)}), 500


# =================== DATA: AUDIT LOG ==========================


def _require_export_usb_and_verification_json():
    cur = data_service.get_current_user()
    if not cur:
        return jsonify({"success": False, "error": "Unauthorized"}), 401
    data_service.refresh_current_user_from_member()
    if not _session_has_internal("export-usb"):
        return jsonify({"success": False, "error": "Forbidden. Export to USB is not permitted for this account."}), 403
    role = str(cur.get("role") or "").strip().lower()
    if role != "factory":
        _verified, verify_err = _consume_approval_verify_token("export")
        if verify_err:
            return jsonify({"success": False, "error": verify_err}), 401
    return None


@app.route("/api/data/audit-log", methods=["GET"])
def get_audit_log():
    """Return audit log entries. Requires audit-view permission (Factory bypass in RBAC)."""
    try:
        cur = data_service.get_current_user()
        if not cur:
            return jsonify({"error": "Unauthorized"}), 401
        if not _session_has_internal("audit-view"):
            return jsonify({"error": "Forbidden. You do not have permission to view the audit log."}), 403

        _audit(
            cur.get("username") or cur.get("name"),
            cur.get("role"),
            "Audit log viewed",
            "",
        )

        user = request.args.get("user")
        filter_role = request.args.get("role")
        action = request.args.get("action")
        from_ts = request.args.get("from")
        to_ts = request.args.get("to")
        filters = {}
        if user:
            filters["user"] = user
        if filter_role:
            filters["role"] = filter_role
        if action:
            filters["action"] = action
        if from_ts:
            try:
                filters["from"] = int(from_ts)
            except (TypeError, ValueError):
                pass
        if to_ts:
            try:
                filters["to"] = int(to_ts)
            except (TypeError, ValueError):
                pass
        entries = audit_service.list_entries(filters)
        return jsonify({"entries": _prepare_audit_entries_for_display(entries)}), 200
    except Exception as e:
        app.logger.exception("Error listing audit log")
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/audit-log/event", methods=["POST"])
def create_client_audit_event():
    """Allow UI to emit lifecycle audit events for run navigation/actions."""
    try:
        cur = data_service.get_current_user()
        if not cur or not (cur.get("username") or cur.get("name")):
            return jsonify({"ok": False, "error": "Authentication required"}), 401
        payload = request.get_json(force=True, silent=True) or {}
        action = str(payload.get("action") or "").strip()
        details = str(payload.get("details") or "").strip()
        if not action:
            return jsonify({"ok": False, "error": "action is required"}), 400
        actor = _audit_actor()
        outcome = str(payload.get("outcome") or "success").strip() or "success"
        event_type = str(payload.get("eventType") or payload.get("event_type") or "lifecycle").strip() or "lifecycle"
        entity_type = str(payload.get("entityType") or payload.get("entity_type") or "").strip()
        entity_name = str(payload.get("entityName") or payload.get("entity_name") or "").strip()
        entity_id = payload.get("entityId", payload.get("entity_id"))
        reason = str(payload.get("reason") or "").strip()
        extra = payload.get("extra")
        if extra is None and payload.get("extraJson"):
            extra = payload.get("extraJson")
        audit_time = _audit_time_fields()
        audit_service.log_structured_event(
            user=actor.get("user"),
            role=actor.get("role"),
            action=action,
            details=details,
            event_type=event_type,
            entity_type=entity_type,
            entity_id=entity_id,
            entity_name=entity_name,
            outcome=outcome,
            reason=reason,
            session_user=actor.get("user"),
            session_role=actor.get("role"),
            request_source="POST /api/data/audit-log/event",
            extra=extra,
            timestamp_ms=audit_time.get("timestamp_ms"),
            date_time=audit_time.get("date_time"),
        )
        return jsonify({"ok": True}), 200
    except Exception as e:
        app.logger.exception("Error creating client audit event")
        return jsonify({"ok": False, "error": str(e)}), 500


def _html_escape(value):
    """HTML-escape a value, treating None as empty."""
    if value is None:
        return ""
    s = str(value)
    return (
        s.replace("&", "&amp;")
         .replace("<", "&lt;")
         .replace(">", "&gt;")
         .replace('"', "&quot;")
         .replace("'", "&#39;")
    )


def _format_wall_datetime_for_audit(dt_value) -> str:
    """Human-readable date/time for audit details (dd/mm/yyyy HH:MM:SS)."""
    if dt_value is None:
        return "--"
    s = str(dt_value).strip()
    if not s:
        return "--"
    try:
        clean = s.replace("Z", "").strip()
        if "+" in clean:
            clean = clean.split("+", 1)[0].strip()
        if clean.count("-") > 2:
            clean = clean.rsplit("-", 1)[0].strip()
        dt_obj = datetime.fromisoformat(clean)
        if getattr(dt_obj, "tzinfo", None) is not None:
            dt_obj = dt_obj.replace(tzinfo=None)
        return dt_obj.strftime("%d/%m/%Y %H:%M:%S")
    except Exception:
        return s


def _humanize_audit_details(action: str, details: str) -> str:
    """Normalize verbose/internal audit detail text for UI and PDF export."""
    action = str(action or "").strip()
    details = audit_service._details_audit_display(details)
    if not details:
        return details
    if action == "Power interruption":
        import re
        if "privileged factory session" in details.lower():
            return "Unclean shutdown during factory session"
        m = re.search(r"User\s+([^\s]+)\s+was logged in", details, re.I)
        if m:
            return "Unclean shutdown while {} was logged in".format(m.group(1))
        m2 = re.search(r"Unclean shutdown while\s+([^\s]+)", details, re.I)
        if m2:
            return "Unclean shutdown while {} was logged in".format(m2.group(1))
        if "kiosk-bridge" in details.lower() or "clean shutdown" in details.lower():
            return "Unclean shutdown during active session"
        return details
    if action == "Reports exported":
        import re
        if details.lower().startswith("exported "):
            return details
        m = re.search(r"\bok=(\d+)", details)
        if m:
            n = int(m.group(1))
            return "Exported {} report{} to USB".format(n, "" if n == 1 else "s")
        return "Exported report(s) to USB"
    if action in ("Print thermal", "Print A4"):
        details = (
            details.replace(" | full data", "")
            .replace("| full data", "")
            .replace(" | inline", "")
            .replace("| inline", "")
            .strip()
        )
        import re
        m = re.search(r"report\s+id\s+(\d+)", details, re.I)
        if m:
            return "Report id {}".format(m.group(1))
        return details
    if action == "Report PDF generated":
        import re
        m = re.search(r"report\s+id\s+(\d+)", details, re.I)
        if not m:
            m = re.search(r"report\s+(\d+)", details, re.I)
        if m:
            rid = m.group(1)
            if "aborted PDF" in details:
                return "Report id {} | aborted PDF".format(rid)
            pf = re.search(r"\|\s*(PASS|FAIL)\s*\|", details, re.I)
            if pf and "approved PDF" in details:
                return "Report id {} | {} | approved PDF".format(rid, pf.group(1))
            if "approved PDF" in details:
                return "Report id {} | approved PDF".format(rid)
            return "Report id {}".format(rid)
        return "Report PDF saved"
    if action in ("Report aborted", "Report aborted (power loss)", "Report approved", "Test performed", "Quick test performed", "Validation performed"):
        import re
        details = re.sub(
            r"\s*\|\s*awaiting approval \(PDF after approval\)",
            " | awaiting approval",
            details,
            flags=re.I,
        )
        return details
    if action == "System date change":
        if details.lower().startswith("changed from"):
            return details
        import re
        if re.match(r"^\d{4}-\d{2}-\d{2}T", details):
            return "Set to {}".format(_format_wall_datetime_for_audit(details))
        return _format_wall_datetime_for_audit(details)
    if "/opt/kiosk/" in details or "/media/" in details:
        import re
        details = re.sub(
            r"report\s+(\d+)\s*->\s*\S+",
            r"Report id \1",
            details,
            flags=re.I,
        )
        details = re.sub(r"\s*\|\s*dir\s+\S+", "", details, flags=re.I)
    return details


def _audit_entry_should_omit(entry: dict) -> bool:
    """Drop noisy or sensitive rows from operator-facing audit views."""
    action = str(entry.get("action") or "").strip()
    outcome = str(entry.get("outcome") or "").strip().lower()
    details = str(entry.get("details") or "").strip().lower()
    if action == "Login" and "invalid username" in details:
        return True
    return False


def _prepare_audit_entries_for_display(entries):
    out = []
    for entry in entries or []:
        if _audit_entry_should_omit(entry):
            continue
        row = dict(entry)
        row["role"] = _display_role_label(row.get("role"))
        row["details"] = _humanize_audit_details(row.get("action"), row.get("details"))
        out.append(row)
    return out


def _build_audit_trail_html(entries, filters, factory):
    """Build a printable A4 audit-trail HTML document.

    Layout: branded header (company/model/serial from factory settings),
    filter summary, then a wide rows-table. Long detail strings wrap. The
    document is rendered to PDF by pdf_generator.render_html_to_pdf, which
    produces an inherently write-protected file.
    """
    factory = factory or {}
    company = _html_escape(factory.get("companyName") or "")
    model = _html_escape(factory.get("modelNo") or "")
    serial = _html_escape(factory.get("serialNo") or "")
    location = _html_escape(factory.get("companyLocation") or factory.get("location") or "")
    instrument_no = _html_escape(factory.get("instrumentId") or "")
    generated_at = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime())

    def _fmt_ts(ts):
        try:
            ts_int = int(ts)
        except (TypeError, ValueError):
            return _html_escape(ts) if ts else ""
        if ts_int <= 0:
            return ""
        if ts_int > 10 ** 12:
            ts_int = ts_int // 1000
        return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(ts_int))

    def _split_date_time_cell(raw, timestamp_fallback):
        """Return (date_html, time_html). Splits any 'DATE TIME' string on the first space.

        Accepts the pre-formatted 'dateTime' string from the audit entry (preferred)
        or a numeric timestamp fallback. Either field is HTML-escaped before return.
        Empty inputs yield ('--', '').
        """
        raw_str = ""
        if raw:
            raw_str = str(raw).strip()
        elif timestamp_fallback is not None:
            raw_str = _fmt_ts(timestamp_fallback).strip()
        if not raw_str:
            return ("--", "")
        date_part, time_part = raw_str, ""
        idx = raw_str.find(" ")
        if idx > 0:
            date_part = raw_str[:idx].strip()
            time_part = raw_str[idx + 1:].strip()
        return (_html_escape(date_part), _html_escape(time_part))

    chips = []
    if filters.get("user"):
        chips.append("User = " + _html_escape(filters["user"]))
    if filters.get("role"):
        chips.append("Role = " + _html_escape(filters["role"]))
    if filters.get("action"):
        chips.append("Action = " + _html_escape(filters["action"]))
    if filters.get("from"):
        chips.append("From = " + _fmt_ts(filters["from"]))
    if filters.get("to"):
        chips.append("To = " + _fmt_ts(filters["to"]))
    chips_html = (
        '<div class="chips">' +
        "".join('<span class="chip">' + c + "</span>" for c in chips) +
        "</div>"
    ) if chips else '<div class="chips muted">No filters applied (all entries).</div>'

    if entries:
        rows = []
        for i, e in enumerate(entries, start=1):
            date_part, time_part = _split_date_time_cell(e.get("dateTime"), e.get("timestamp"))
            usr = _html_escape(e.get("user") or "--")
            rol = _html_escape(e.get("role") or "--")
            act = _html_escape(e.get("action") or "")
            det = _html_escape(e.get("details") or "")
            outcome = _html_escape(e.get("outcome") or "")
            rows.append(
                "<tr>"
                "<td class=\"col-sl\">{sl}</td>"
                "<td class=\"col-dt\">"
                  "<span class=\"dt-date\">{d}</span>"
                  "<span class=\"dt-time\">{t}</span>"
                "</td>"
                "<td>{usr}</td>"
                "<td>{rol}</td>"
                "<td>{act}</td>"
                "<td class=\"col-out\">{out}</td>"
                "<td class=\"col-det\">{det}</td>"
                "</tr>".format(sl=i, d=date_part, t=time_part, usr=usr, rol=rol, act=act, out=outcome, det=det)
            )
        rows_html = "".join(rows)
    else:
        rows_html = '<tr><td colspan="7" class="empty">No audit entries match the filters.</td></tr>'

    return (
        '<!doctype html><html><head><meta charset="utf-8"><title>Audit Trail Export</title>'
        '<style>'
        '@page { size: A4 landscape; margin: 10mm 8mm; }'
        'html, body { margin: 0; padding: 0; background:#ffffff; color:#111;'
        '   font-family: "Inter", "Segoe UI", Roboto, Arial, sans-serif; font-size: 9.5pt; }'
        'h1 { font-size: 14pt; margin: 0 0 4px 0; letter-spacing: 0.5px; }'
        'h2 { font-size: 11pt; margin: 0 0 8px 0; color:#444; font-weight: 600; }'
        '.brand { display:flex; justify-content:space-between; align-items:flex-end; '
        '         border-bottom: 2px solid #111; padding-bottom: 6px; margin-bottom: 8px; }'
        '.brand .meta { text-align: right; font-size: 9pt; color:#333; }'
        '.brand .meta div { line-height: 1.35; }'
        '.brand .meta strong { color:#111; }'
        '.chips { margin: 4px 0 8px 0; }'
        '.chip { display:inline-block; padding: 2px 8px; margin-right: 6px; margin-bottom: 4px;'
        '        background:#eef2ff; color:#1e3a8a; border-radius: 12px; font-size: 8.5pt; }'
        '.muted { color:#666; font-style: italic; font-size: 8.5pt; }'
        'table { width:100%; border-collapse: collapse; table-layout: fixed; }'
        'thead th { background:#111827; color:#fff; padding: 6px 6px; text-align: left;'
        '           font-weight:600; font-size: 9pt; border: 1px solid #111827; }'
        'tbody td { border: 1px solid #d1d5db; padding: 5px 6px; vertical-align: top;'
        '           word-wrap: break-word; overflow-wrap: break-word; }'
        'tbody tr:nth-child(even) td { background: #f9fafb; }'
        '.col-sl  { width: 4%; text-align: right; font-variant-numeric: tabular-nums; }'
        '.col-dt  { width: 11%; font-variant-numeric: tabular-nums; line-height: 1.25; }'
        '.col-dt .dt-date { display: block; white-space: nowrap; font-weight: 600; }'
        '.col-dt .dt-time { display: block; white-space: nowrap; font-size: 8.5pt; color: #444; }'
        '.col-out { width: 9%; }'
        '.col-det { width: 36%; }'
        '.empty { text-align: center; padding: 18px 0; color:#666; font-style: italic; }'
        '.footer { margin-top: 10px; font-size: 8pt; color:#555; '
        '          border-top: 1px solid #d1d5db; padding-top: 6px; }'
        '.footer .left  { float: left; }'
        '.footer .right { float: right; }'
        '.footer::after { content: ""; display: block; clear: both; }'
        '</style></head><body>'
        '<div class="brand">'
        '  <div>'
        '    <h1>AUDIT TRAIL EXPORT</h1>'
        '    <h2>' + (company or "Leak Test Tester") + '</h2>'
        '  </div>'
        '  <div class="meta">'
        '    <div><strong>Model:</strong> ' + (model or "--") + '</div>'
        '    <div><strong>Serial:</strong> ' + (serial or "--") + '</div>'
        '    <div><strong>Instrument:</strong> ' + (instrument_no or "--") + '</div>'
        '    <div><strong>Location:</strong> ' + (location or "--") + '</div>'
        '    <div><strong>Generated:</strong> ' + _html_escape(generated_at) + '</div>'
        '    <div><strong>Entries:</strong> ' + str(len(entries)) + '</div>'
        '  </div>'
        '</div>'
        + chips_html +
        '<table>'
        '  <thead><tr>'
        '    <th class="col-sl">#</th>'
        '    <th class="col-dt">Date &amp; Time</th>'
        '    <th>User</th>'
        '    <th>Role</th>'
        '    <th>Action</th>'
        '    <th class="col-out">Outcome</th>'
        '    <th class="col-det">Details</th>'
        '  </tr></thead>'
        '  <tbody>' + rows_html + '</tbody>'
        '</table>'
        '<div class="footer">'
        '  <span class="left">This document is auto-generated and write-protected (PDF).</span>'
        '  <span class="right">' + _html_escape(generated_at) + '</span>'
        '</div>'
        '</body></html>'
    )


@app.route("/api/audit/export", methods=["POST"])
def export_audit_trails():
    """Export filtered audit entries as a write-protected PDF on the external pendrive.

    Restricted to factory/admin roles. The PDF is the read-only "preview" format that
    replaces the previous JSON dump (which was editable).
    """
    mounted_now = None
    try:
        gate = _require_export_usb_and_verification_json()
        if gate is not None:
            return gate
        audit_gate = _require_session_internal(
            "audit-view",
            "Forbidden. You do not have permission to export audit trails.",
        )
        if audit_gate:
            return audit_gate
        cur = data_service.get_current_user()

        data = request.get_json(force=True, silent=True) or {}
        filters_in = data.get("filters") or {}
        device_path = (data.get("device_path") or "").strip() or None
        export_path = (data.get("export_path") or "").strip() or None

        user = filters_in.get("user")
        filter_role = filters_in.get("role")
        action = filters_in.get("action")
        from_ts = filters_in.get("from")
        to_ts = filters_in.get("to")
        filters = {}
        if user:
            filters["user"] = user
        if filter_role:
            filters["role"] = filter_role
        if action:
            filters["action"] = action
        if from_ts:
            try:
                filters["from"] = int(from_ts)
            except (TypeError, ValueError):
                pass
        if to_ts:
            try:
                filters["to"] = int(to_ts)
            except (TypeError, ValueError):
                pass

        export_dir, err, devices, mounted_now = _resolve_export_destination(device_path, export_path)
        if err == "MULTIPLE_PENDRIVES":
            return jsonify({"success": False, "error": "Multiple pendrives detected. Choose one.", "devices": devices, "code": "MULTIPLE_PENDRIVES"}), 409
        if err:
            return jsonify({"success": False, "error": err, "devices": devices}), 400
        export_dir.mkdir(parents=True, exist_ok=True)

        entries = _prepare_audit_entries_for_display(audit_service.list_entries(filters))
        try:
            factory = data_service.get_factory_settings() or {}
        except Exception:
            factory = {}
        html = _build_audit_trail_html(entries, filters, factory)
        timestamp = time.strftime("%Y-%m-%d_%H%M%S", time.localtime())
        out_path = export_dir / "audit_trail_{}.pdf".format(timestamp)
        pdf_generator.render_html_to_pdf(html, out_path)
        # Make the file read-only on the filesystem if the target FS supports it.
        # vfat ignores chmod, but ext4 / exfat-utils etc. will keep it.
        try:
            os.chmod(out_path, 0o444)
        except OSError:
            pass

        unmount_detail = None
        if mounted_now and not export_path:
            power_off = bool(data.get("power_off") or False)
            unmount_detail = usb_export.sync_and_unmount_pendrive(mounted_now, power_off=power_off)

        _audit(
            cur.get("username") or cur.get("name"),
            cur.get("role"),
            "Audit trail exported",
            "pdf {} | entries {}".format(out_path, len(entries)),
        )
        return jsonify({
            "success": True,
            "path": str(out_path),
            "export_directory": str(export_dir),
            "format": "pdf",
            "entries": len(entries),
            "unmount_detail": unmount_detail,
        }), 200
    except Exception as e:
        if mounted_now:
            try:
                usb_export.sync_and_unmount_pendrive(mounted_now, power_off=False)
            except Exception:
                pass
        app.logger.exception("Error exporting audit trails")
        return jsonify({"success": False, "error": _friendly_export_error(e)}), 500


# =================== CALCULATE ==========================


@app.route("/api/calculate/recipe-validate", methods=["POST"])
def validate_recipe_endpoint():
    try:
        gate = _require_any_session_internal(
            ["recipe-manage", "recipe-test", "quick-test"],
            "Forbidden. You do not have permission to manage recipes.",
        )
        if gate:
            return gate
        recipe_data = request.get_json(force=True, silent=True) or {}
        result = calculation_service.validate_recipe(recipe_data)
        return jsonify(result), 200
    except Exception as e:
        app.logger.exception("Error validating recipe")
        return jsonify({"error": str(e)}), 500

    
# =================== REPORTS PREVIEW / EXPORT ==========================


@app.route("/api/reports/<int:report_id>/preview", methods=["GET"])
def get_report_preview(report_id):
    try:
        gate = _require_session_internal("reports-view", "Forbidden. You do not have permission to view reports.")
        if gate:
            return gate
        report = data_service.get_report(report_id)
        if not report:
            return jsonify({"error": "Report not found"}), 404
        rtype = (report.get("type") or "").strip().lower() or "report"
        _audit(
            None,
            None,
            "Report preview viewed",
            "Report id {} | type {}".format(report_id, rtype),
        )
        preview_data = report_service.get_report_preview_data(report)
        return jsonify({"preview": preview_data}), 200
    except Exception as e:
        app.logger.exception("Error getting report preview")
        return jsonify({"error": str(e)}), 500


@app.route("/api/usb/list", methods=["GET"])
def list_usb_pendrives():
    """List external pendrives suitable for export (excludes OS root + internal USB)."""
    try:
        gate = _require_session_internal("export-usb", "Forbidden. Export to USB is not permitted for this account.")
        if gate:
            return gate
        devices = usb_export.list_external_pendrives()
        return jsonify({"success": True, "devices": devices}), 200
    except Exception as e:
        app.logger.exception("Error listing USB devices")
        return jsonify({"success": False, "error": str(e), "devices": []}), 500


def _report_pdf_path(report_id):
    return REPORTS_DIR / "report_{}.pdf".format(int(report_id))


def _report_pdf_status_allowed(report: dict) -> bool:
    """PDF files are written only for approved or aborted test/validation reports."""
    if not report or not _report_requires_approval(report):
        return True
    st = str(report.get("reportApprovalStatus") or "").strip().lower()
    return st in ("approved", "aborted")


def _remove_report_pdf_file(report_id: int) -> None:
    try:
        path = _report_pdf_path(report_id)
        if path.exists():
            path.unlink()
    except OSError:
        pass


def _generate_report_pdf_file(report_id: int, html: str = None, write_audit: bool = True) -> bool:
    """Render report PDF from client HTML or server-built HTML. Overwrites any existing file."""
    report = data_service.get_report(report_id)
    if not report:
        return False
    if not _report_pdf_status_allowed(report):
        _remove_report_pdf_file(report_id)
        return False
    try:
        if not isinstance(html, str) or not html.strip():
            html = report_service.build_report_pdf_html(report)
        out_path = _report_pdf_path(report_id)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        pdf_generator.render_html_to_pdf(html, out_path)
        ok = out_path.exists() and out_path.stat().st_size > 0
        if ok and write_audit:
            _audit_report_pdf_generated(report_id, report)
        return ok
    except Exception:
        app.logger.exception("Report PDF generation failed for id %s", report_id)
        return False


def _friendly_export_error(exc_or_msg):
    """Translate any internal export failure into a single short user-facing message.

    The audit/reports export pipeline touches Chromium, udisks2, polkit, vfat/exFAT,
    and the kernel block layer. Their raw messages (dbus warnings, polkit codes,
    SCSI I/O errors, FAT short-name issues, ...) are useless to operators. Almost
    every recoverable failure on this hardware is resolved by re-formatting the
    pendrive cleanly, so we surface a single instruction.
    """
    text = (str(exc_or_msg) if exc_or_msg is not None else "").lower()
    if "no external pendrive" in text or "not detected" in text:
        return "No external pendrive detected. Please connect a USB pendrive and try again."
    if "multiple pendrives" in text:
        return "Multiple pendrives detected. Please disconnect extras and try again."
    if "could not mount" in text or "mount failed" in text or "not authorized" in text:
        return "Could not access the pendrive. Reconnect it and try again."
    if "no space left" in text or "disk full" in text:
        return "Pendrive is full. Free space or use a different pendrive."
    return "Failed to export. Please format the pendrive (FAT32 or exFAT) and try again."


@app.route("/api/reports/<int:report_id>/pdf", methods=["POST"])
def save_report_pdf(report_id):
    """Render the supplied HTML for a report to PDF and store it next to the .txt files.

    Body: { "html": "<full document or fragment>" }
    """
    try:
        gate = _require_session_internal("reports-view", "Forbidden. You do not have permission to view reports.")
        if gate:
            return gate
        report = data_service.get_report(report_id)
        if not report:
            return jsonify({"success": False, "error": "Report not found"}), 404
        if not _report_pdf_status_allowed(report):
            return jsonify({
                "success": False,
                "error": "PDF is available only after the report is approved or marked aborted.",
            }), 403
        payload = request.get_json(force=True, silent=True) or {}
        html = payload.get("html")
        if not isinstance(html, str) or not html.strip():
            return jsonify({"success": False, "error": "html is required"}), 400
        if not _generate_report_pdf_file(report_id, html=html, write_audit=True):
            return jsonify({"success": False, "error": "PDF generation failed"}), 500
        out_path = _report_pdf_path(report_id)
        return jsonify({"success": True, "path": str(out_path), "size_bytes": out_path.stat().st_size}), 200
    except Exception as e:
        app.logger.exception("Error rendering report PDF")
        return jsonify({"success": False, "error": str(e)}), 500


def _resolve_export_destination(device_path, requested_export_path):
    """Pick the destination directory on the external pendrive.

    Returns (pathlib.Path | None, error_str, devices_list, mounted_now_device_path | None).
    The caller may unmount mounted_now_device_path after writing.
    """
    if requested_export_path:
        # Caller forced a path (typically used by dev). No mount magic.
        return pathlib.Path(requested_export_path), None, [], None
    devices = usb_export.list_external_pendrives()
    if not devices:
        return None, "No external pendrive detected. Please connect a USB pendrive and try again.", [], None
    if device_path:
        match = next((d for d in devices if d.get("path") == device_path), None)
        if not match:
            return None, "Selected pendrive '{}' is no longer connected.".format(device_path), devices, None
        chosen = match
    elif len(devices) == 1:
        chosen = devices[0]
    else:
        return None, "MULTIPLE_PENDRIVES", devices, None
    mounted_now = None
    if not chosen.get("mounted") or not chosen.get("mountpoint"):
        mount_res = usb_export.ensure_pendrive_mounted(chosen["path"])
        if not mount_res.get("ok"):
            return None, "Could not mount {}: {}".format(chosen["path"], mount_res.get("error") or "unknown"), devices, None
        chosen["mountpoint"] = mount_res.get("mountpoint")
        if not mount_res.get("already_mounted"):
            mounted_now = chosen["path"]
    mountpoint = chosen.get("mountpoint")
    if not mountpoint:
        return None, "Pendrive {} reported no mountpoint.".format(chosen.get("path")), devices, mounted_now
    subfolder_rel = usb_export.export_subfolder_name(EXPORT_SUBFOLDER)
    export_dir = pathlib.Path(mountpoint) / subfolder_rel
    return export_dir, None, devices, mounted_now


@app.route("/api/reports/export", methods=["POST"])
def export_reports():
    """Export selected reports (PDFs) to the connected external pendrive.

    Body:
      report_ids:        [int, ...]                       (required)
      device_path:       "/dev/sdb1"                      (optional; required if multiple pendrives)
      pdf_html_by_id:    { "<report_id>": "<html>", ... } (optional; auto-generate any missing PDFs)
      export_path:       "/abs/path"                      (optional; override mount detection for dev)

    Returns 409 with `devices` list when multiple pendrives are connected and none chosen.
    """
    mounted_now = None
    try:
        data = request.get_json(force=True, silent=True) or {}
        raw_ids = data.get("report_ids", [])
        report_ids = []
        for rid in raw_ids:
            try:
                report_ids.append(int(rid))
            except (TypeError, ValueError):
                continue
        if not report_ids:
            return jsonify({"success": False, "error": "No report IDs provided"}), 400
        gate = _require_export_usb_and_verification_json()
        if gate is not None:
            return gate
        device_path = (data.get("device_path") or "").strip() or None
        requested_export_path = (data.get("export_path") or "").strip() or None
        pdf_html_by_id = data.get("pdf_html_by_id") or {}
        if isinstance(pdf_html_by_id, dict):
            pdf_html_by_id = {str(k): v for k, v in pdf_html_by_id.items() if isinstance(v, str) and v.strip()}
        else:
            pdf_html_by_id = {}

        # Ensure PDFs exist (only approved/aborted reports may have PDF files).
        generated = []
        missing = []
        for rid in report_ids:
            report = data_service.get_report(rid) or {}
            if _report_requires_approval(report):
                st = str(report.get("reportApprovalStatus") or "").strip().lower()
                if st == "pending":
                    missing.append(rid)
                    continue
            pdf_path = _report_pdf_path(rid)
            if pdf_path.exists() and pdf_path.stat().st_size > 0:
                continue
            html = pdf_html_by_id.get(str(rid))
            if html and _report_pdf_status_allowed(report):
                try:
                    pdf_generator.render_html_to_pdf(html, pdf_path)
                    generated.append(rid)
                except Exception as e:
                    app.logger.warning("[EXPORT] PDF generation failed for report %s: %s", rid, e)
                    missing.append(rid)
            elif _generate_report_pdf_file(rid):
                generated.append(rid)
            else:
                missing.append(rid)
        if missing:
            return jsonify({
                "success": False,
                "error": (
                    "PDF unavailable for report(s): {}. Approve the report first, "
                    "or ensure aborted reports were saved correctly."
                ).format(", ".join(str(i) for i in missing)),
                "missing_pdfs": missing,
            }), 400

        export_dir, err, devices, mounted_now = _resolve_export_destination(device_path, requested_export_path)
        if err == "MULTIPLE_PENDRIVES":
            return jsonify({"success": False, "error": "Multiple pendrives detected. Choose one.", "devices": devices, "code": "MULTIPLE_PENDRIVES"}), 409
        if err:
            return jsonify({"success": False, "error": err, "devices": devices}), 400

        for rid in report_ids:
            blocked = _check_report_approved_for_print_export(report_id=rid)
            if blocked is not None:
                return blocked

        export_dir.mkdir(parents=True, exist_ok=True)

        exported_files = []
        failed = []
        for rid in report_ids:
            src = _report_pdf_path(rid)
            if not src.exists():
                failed.append({"id": rid, "error": "PDF missing"})
                continue
            report = data_service.get_report(rid) or {}
            recipe = report.get("recipe") if isinstance(report.get("recipe"), dict) else {}
            product = (recipe.get("productName") or report.get("name") or "report")
            safe_name = "".join(c for c in str(product) if c.isalnum() or c in "-_") or "report"
            ts_raw = str(report.get("createdAt") or "")
            safe_ts = "".join(c for c in ts_raw if c.isalnum() or c in "-_.T") or "ts"
            dest = export_dir / "{}_{}_{}.pdf".format(safe_name, rid, safe_ts)
            try:
                with open(src, "rb") as fin, open(dest, "wb") as fout:
                    while True:
                        chunk = fin.read(1024 * 1024)
                        if not chunk:
                            break
                        fout.write(chunk)
                exported_files.append(str(dest))
            except Exception as e:
                failed.append({"id": rid, "error": str(e)})

        # Best-effort sync + unmount (only if we mounted it here).
        # Default is power_off=False so repeat exports don't require re-plugging.
        unmount_detail = None
        if mounted_now and not requested_export_path:
            power_off = bool(data.get("power_off") or False)
            unmount_detail = usb_export.sync_and_unmount_pendrive(mounted_now, power_off=power_off)

        ok_count = len(exported_files)
        _audit(
            None, None,
            "Reports exported",
            "Exported {} report{} to USB".format(
                ok_count, "" if ok_count == 1 else "s"
            ),
        )
        return jsonify({
            "success": (len(failed) == 0),
            "count": len(exported_files),
            "exported_files": exported_files,
            "failed": failed,
            "export_directory": str(export_dir),
            "generated_pdfs_now": generated,
            "unmount_detail": unmount_detail,
            "device_path": device_path or (devices[0]["path"] if len(devices) == 1 else None),
        }), 200
    except Exception as e:
        if mounted_now:
            try:
                usb_export.sync_and_unmount_pendrive(mounted_now, power_off=False)
            except Exception:
                pass
        app.logger.exception("Error exporting reports")
        return jsonify({"success": False, "error": _friendly_export_error(e)}), 500


@app.route("/api/reports/export/stream", methods=["POST"])
def export_reports_stream():
    """NDJSON progress stream for bulk report export.

    Emits one JSON object per line. Events:
      {event:"start", total:N}
      {event:"stage", stage:"detect-usb"|"mount"|"copying"|"unmount", percent:int}
      {event:"report", current:i, total:N, percent:int, id:<rid>, status:"generating"|"copied"|"failed"}
      {event:"done", ok:bool, count:int, failed:[...], export_directory:str, percent:100}
      {event:"error", message:str}

    Why streaming: lets the UI show a real progress bar with percentage as each
    report PDF is rendered + copied, instead of a static spinner.
    """
    data = request.get_json(force=True, silent=True) or {}
    raw_ids = data.get("report_ids", [])
    report_ids = []
    for rid in raw_ids:
        try:
            report_ids.append(int(rid))
        except (TypeError, ValueError):
            continue
    if not report_ids:
        return jsonify({"success": False, "error": "No report IDs provided"}), 400
    device_path = (data.get("device_path") or "").strip() or None
    requested_export_path = (data.get("export_path") or "").strip() or None
    pdf_html_by_id_raw = data.get("pdf_html_by_id") or {}
    if isinstance(pdf_html_by_id_raw, dict):
        pdf_html_by_id = {str(k): v for k, v in pdf_html_by_id_raw.items() if isinstance(v, str) and v.strip()}
    else:
        pdf_html_by_id = {}
    power_off = bool(data.get("power_off") or False)

    gate = _require_export_usb_and_verification_json()
    if gate is not None:
        return gate
    for rid in report_ids:
        blocked = _check_report_approved_for_print_export(report_id=rid)
        if blocked is not None:
            return blocked

    def _emit(obj):
        return (json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8")

    def gen():
        total = len(report_ids)
        # Budget allocation (sums to 100):
        #   3% detect-usb, 7% mount, 80% per-report PDF + copy, 8% sync+unmount, 2% done
        gen_copy_budget = 80.0
        per_report_pct = (gen_copy_budget / total) if total else 0.0
        accumulated = 10.0  # after detect + mount stages
        mounted_now = None
        result = {
            "ok": False,
            "count": 0,
            "exported_files": [],
            "failed": [],
            "export_directory": None,
            "device_path": None,
        }
        try:
            yield _emit({"event": "start", "total": total, "percent": 0})

            yield _emit({"event": "stage", "stage": "detect-usb", "percent": 3,
                         "message": "Detecting external pendrive..."})

            export_dir, err, devices, mounted_now = _resolve_export_destination(device_path, requested_export_path)
            if err == "MULTIPLE_PENDRIVES":
                yield _emit({"event": "error", "code": "MULTIPLE_PENDRIVES",
                             "message": "Multiple pendrives detected. Choose one.",
                             "devices": devices})
                return
            if err:
                yield _emit({"event": "error", "message": _friendly_export_error(err), "devices": devices})
                return
            result["export_directory"] = str(export_dir)
            result["device_path"] = device_path or (devices[0]["path"] if devices and len(devices) == 1 else None)

            yield _emit({"event": "stage", "stage": "mount", "percent": 10,
                         "message": "Mounted pendrive. Preparing files..."})

            try:
                export_dir.mkdir(parents=True, exist_ok=True)
            except OSError as oe:
                yield _emit({"event": "error", "message": _friendly_export_error(oe)})
                return

            for i, rid in enumerate(report_ids, start=1):
                this_progress_at = accumulated + per_report_pct * (i - 1)
                next_progress_at = accumulated + per_report_pct * i
                report = data_service.get_report(rid) or {}
                if _report_requires_approval(report):
                    st = str(report.get("reportApprovalStatus") or "").strip().lower()
                    if st == "pending":
                        result["failed"].append({"id": rid, "reason": "pending"})
                        yield _emit({"event": "report", "current": i, "total": total,
                                     "percent": int(next_progress_at), "id": rid,
                                     "status": "failed"})
                        continue
                # 1) Ensure a PDF exists for this report (generate if needed).
                pdf_src = _report_pdf_path(rid)
                if not (pdf_src.exists() and pdf_src.stat().st_size > 0):
                    html = pdf_html_by_id.get(str(rid))
                    yield _emit({"event": "report", "current": i, "total": total,
                                 "percent": int(this_progress_at + per_report_pct * 0.3), "id": rid,
                                 "status": "generating",
                                 "message": "Generating PDF for report {} of {}...".format(i, total)})
                    ok = False
                    if html and _report_pdf_status_allowed(report):
                        try:
                            pdf_generator.render_html_to_pdf(html, pdf_src)
                            ok = pdf_src.exists() and pdf_src.stat().st_size > 0
                        except Exception as e:
                            app.logger.warning("[EXPORT-STREAM] PDF render failed for %s: %s", rid, e)
                    if not ok:
                        ok = _generate_report_pdf_file(rid)
                    if not ok:
                        result["failed"].append({"id": rid, "reason": "render"})
                        yield _emit({"event": "report", "current": i, "total": total,
                                     "percent": int(next_progress_at), "id": rid,
                                     "status": "failed"})
                        continue

                # 2) Copy to pendrive destination.
                recipe = report.get("recipe") if isinstance(report.get("recipe"), dict) else {}
                product = recipe.get("productName") or report.get("name") or "report"
                safe_name = "".join(c for c in str(product) if c.isalnum() or c in "-_") or "report"
                ts_raw = str(report.get("createdAt") or "")
                safe_ts = "".join(c for c in ts_raw if c.isalnum() or c in "-_.T") or "ts"
                dest = export_dir / "{}_{}_{}.pdf".format(safe_name, rid, safe_ts)
                yield _emit({"event": "report", "current": i, "total": total,
                             "percent": int(this_progress_at + per_report_pct * 0.7), "id": rid,
                             "status": "copying",
                             "message": "Writing report {} of {} to pendrive...".format(i, total)})
                try:
                    pdf_generator._copy_to_destination(pdf_src, dest)  # robust chunked copy
                    result["exported_files"].append(str(dest))
                    result["count"] += 1
                    yield _emit({"event": "report", "current": i, "total": total,
                                 "percent": int(next_progress_at), "id": rid,
                                 "status": "copied", "file": str(dest)})
                except Exception as e:
                    app.logger.warning("[EXPORT-STREAM] Copy failed for %s: %s", rid, e)
                    result["failed"].append({"id": rid, "reason": "copy"})
                    yield _emit({"event": "report", "current": i, "total": total,
                                 "percent": int(next_progress_at), "id": rid,
                                 "status": "failed"})

            yield _emit({"event": "stage", "stage": "unmount", "percent": 95,
                         "message": "Syncing and unmounting pendrive..."})
            unmount_detail = None
            if mounted_now and not requested_export_path:
                unmount_detail = usb_export.sync_and_unmount_pendrive(mounted_now, power_off=power_off)
                mounted_now = None

            ok_count = result["count"]
            _audit(
                None, None,
                "Reports exported",
                "Exported {} report{} to USB".format(
                    ok_count, "" if ok_count == 1 else "s"
                ),
            )

            result["ok"] = (len(result["failed"]) == 0 and result["count"] > 0)
            yield _emit({
                "event": "done",
                "percent": 100,
                "ok": result["ok"],
                "count": result["count"],
                "failed": result["failed"],
                "exported_files": result["exported_files"],
                "export_directory": result["export_directory"],
                "device_path": result["device_path"],
                "unmount_detail": unmount_detail,
            })
        except Exception as e:
            app.logger.exception("[EXPORT-STREAM] Unexpected failure")
            try:
                yield _emit({"event": "error", "message": _friendly_export_error(e)})
            except Exception:
                pass
        finally:
            # Best-effort unmount on early exit.
            if mounted_now and not requested_export_path:
                try:
                    usb_export.sync_and_unmount_pendrive(mounted_now, power_off=False)
                except Exception:
                    pass

    return Response(stream_with_context(gen()), mimetype="application/x-ndjson")



def _load_report_data_for_print(report_id, report_data_fallback=None):
    """Load full saved report (including testData) for printing."""
    if report_id is not None:
        stored = data_service.get_report(int(report_id))
        if stored:
            return report_service.enrich_report_context(dict(stored))
    if report_data_fallback:
        rd = dict(report_data_fallback)
        if not rd.get("factorySettings"):
            try:
                rd["factorySettings"] = report_service.enrich_factory_settings(
                    data_service.get_factory_settings() or {}
                )
            except Exception:
                pass
        return report_service.enrich_report_context(rd)
    return None

# =================== PRINT ==========================


@app.route("/api/print/a4", methods=["POST"])
def print_a4():
    try:
        data = request.get_json(force=True, silent=True) or {}
        if data.get("type") == "recipe" and data.get("recipe_data"):
            gate = _require_any_session_internal(
                ["recipe-list", "recipe-edit", "reports-view"],
                "Forbidden. You do not have permission to print recipes.",
            )
            if gate:
                _log_print_auth_failure(gate)
                return gate
        else:
            gate = _require_session_internal("reports-view", "Forbidden. You do not have permission to print reports.")
            if gate:
                _log_print_auth_failure(gate)
                return gate
        print_actor = _audit_actor()
        actor_user = print_actor.get("user") or "--"
        actor_role = print_actor.get("role") or "--"
        if data.get("type") == "recipe" and data.get("recipe_data"):
            recipe_data = dict(data["recipe_data"])
            if not recipe_data.get("factorySettings"):
                try:
                    recipe_data["factorySettings"] = report_service.enrich_factory_settings(
                        data_service.get_factory_settings() or {}
                    )
                except Exception:
                    pass
            result = print_service.print_recipe_a4(recipe_data)
            rname = recipe_data.get("productName") or recipe_data.get("name") or ""
            _audit(actor_user, actor_role, "Print A4", "recipe | {}".format(rname or "—"))
            return jsonify(result), 200
        report_data = data.get("report_data", {}) or {}
        report_id = report_data.get("id")
        if report_id is not None:
            blocked = _check_report_approved_for_print_export(report_id=report_id)
            if blocked is not None:
                return blocked
            loaded = _load_report_data_for_print(report_id, report_data)
            if loaded:
                report_data = loaded
                try:
                    print_service.save_report_text_files(report_data, int(report_id), REPORTS_DIR)
                except Exception:
                    pass
                result = print_service.print_a4_report(report_data)
                if result.get("success"):
                    _audit(actor_user, actor_role, "Print A4", "Report id {}".format(report_id))
                return jsonify(result), 200 if result.get("success") else 500
        blocked = _check_report_approved_for_print_export(report_data=report_data)
        if blocked is not None:
            return blocked
        if not report_data.get("factorySettings"):
            try:
                report_data = dict(report_data)
                report_data["factorySettings"] = report_service.enrich_factory_settings(
                    data_service.get_factory_settings() or {}
                )
            except Exception:
                pass
        report_data = report_service.enrich_report_context(dict(report_data))
        result = print_service.print_a4_report(report_data)
        rid = report_data.get("id")
        _audit(
            actor_user,
            actor_role,
            "Print A4",
            "Report id {}".format(rid if rid is not None else "—"),
        )
        return jsonify(result), 200
    except Exception as e:
        app.logger.exception("Error printing A4")
        return jsonify({"error": str(e)}), 500


@app.route("/api/print/thermal", methods=["POST"])
def print_thermal():
    try:
        data = request.get_json(force=True, silent=True) or {}
        if data.get("type") == "recipe" and data.get("recipe_data"):
            gate = _require_any_session_internal(
                ["recipe-list", "recipe-edit", "reports-view"],
                "Forbidden. You do not have permission to print recipes.",
            )
            if gate:
                _log_print_auth_failure(gate)
                return gate
        else:
            gate = _require_session_internal("reports-view", "Forbidden. You do not have permission to print reports.")
            if gate:
                _log_print_auth_failure(gate)
                return gate
        print_actor = _audit_actor()
        actor_user = print_actor.get("user") or "--"
        actor_role = print_actor.get("role") or "--"
        if data.get("type") == "recipe" and data.get("recipe_data"):
            recipe_data = dict(data["recipe_data"])
            if not recipe_data.get("factorySettings"):
                try:
                    recipe_data["factorySettings"] = report_service.enrich_factory_settings(
                        data_service.get_factory_settings() or {}
                    )
                except Exception:
                    pass
            result = print_service.print_recipe_thermal(recipe_data)
            rname = recipe_data.get("productName") or recipe_data.get("name") or ""
            _audit(actor_user, actor_role, "Print thermal", "recipe | {}".format(rname or "—"))
            return jsonify(result), 200
        report_data = data.get("report_data", {}) or {}
        report_id = report_data.get("id")
        if report_id is not None:
            blocked = _check_report_approved_for_print_export(report_id=report_id)
            if blocked is not None:
                return blocked
            loaded = _load_report_data_for_print(report_id, report_data)
            if loaded:
                report_data = loaded
                try:
                    print_service.save_report_text_files(report_data, int(report_id), REPORTS_DIR)
                except Exception:
                    pass
                result = print_service.print_thermal_report(report_data)
                if result.get("success"):
                    _audit(actor_user, actor_role, "Print thermal", "Report id {}".format(report_id))
                return jsonify(result), 200 if result.get("success") else 500
        blocked = _check_report_approved_for_print_export(report_data=report_data)
        if blocked is not None:
            return blocked
        if not report_data.get("factorySettings"):
            try:
                report_data = dict(report_data)
                report_data["factorySettings"] = report_service.enrich_factory_settings(
                    data_service.get_factory_settings() or {}
                )
            except Exception:
                pass
        report_data = report_service.enrich_report_context(dict(report_data))
        result = print_service.print_thermal_report(report_data)
        rid = report_data.get("id")
        _audit(
            actor_user,
            actor_role,
            "Print thermal",
            "Report id {}".format(rid if rid is not None else "—"),
        )
        return jsonify(result), 200
    except Exception as e:
        app.logger.exception("Error printing thermal")
        return jsonify({"error": str(e)}), 500


@app.route("/api/print/status", methods=["GET"])
def print_status():
    try:
        printer_type = request.args.get("type", "a4")
        status = print_service.check_printer_status(printer_type)
        return jsonify(status), 200
    except Exception as e:
        app.logger.exception("Error checking printer status")
        return jsonify({"error": str(e)}), 500


# =================== HARDWARE ==========================


@app.route("/api/hardware/stream", methods=["GET"])
def hardware_stream():
    gate = _require_any_session_internal(
        ["quick-test", "recipe-test", "validation-test", "calibration-menu"],
        "Forbidden. You do not have permission to use hardware controls.",
    )
    if gate:
        return gate
    return hardware_service.start_sse_stream()


@app.route("/api/hardware/log/reset", methods=["POST"])
def hardware_log_reset():
    gate = _require_any_session_internal(
        ["quick-test", "recipe-test", "validation-test", "calibration-menu"],
        "Forbidden. You do not have permission to use hardware controls.",
    )
    if gate:
        return gate
    result = hardware_service.reset_uart_log(reason="ui_refresh")
    code = 200 if result.get("ok") else 500
    return jsonify(result), code


@app.route("/api/hardware/command", methods=["POST"])
def hardware_command():
    gate = _require_any_session_internal(
        ["quick-test", "recipe-test", "validation-test", "calibration-menu"],
        "Forbidden. You do not have permission to use hardware controls.",
    )
    if gate:
        return gate
    data = request.get_json(force=True, silent=True) or {}
    cmd = data.get("command", "")
    if not cmd:
        return jsonify({"error": "No command provided"}), 400
    result = hardware_service.send_command(cmd)
    c = str(cmd).strip()
    if len(c) > 120:
        c = c[:117] + "…"
    return jsonify(result)


@app.route("/api/hardware/status", methods=["GET"])
def hardware_status():
    gate = _require_any_session_internal(
        ["quick-test", "recipe-test", "validation-test", "calibration-menu"],
        "Forbidden. You do not have permission to use hardware controls.",
    )
    if gate:
        return gate
    result = hardware_service.cmd_status()
    return jsonify(result)


@app.route("/api/hardware/calibrate/tare", methods=["POST"])
def calibrate_tare():
    return jsonify({"ok": False, "error": "Tare command is not supported by current ESP firmware"}), 400




def _adapter_kind_from_check_result(result):
    """Parse #GET_PRESSURE response (#PRESSURE:NNN) or legacy usp,chk lines."""
    if not result or not result.get("ok"):
        return None
    norm = hardware_service.normalize_line(result.get("normalized") or result.get("response") or "")
    s = str(norm).lower().lstrip("#")
    if s.startswith("pressure:"):
        return "ok"
    if "adapt" in s and "error" in s:
        return "error"
    if "usp1" in s and "ok" in s:
        return "usp1"
    if "usp2" in s and "ok" in s:
        return "usp2"
    return None

@app.route("/api/hardware/validation/load/start", methods=["POST"])
def validation_load_start():
    gate = _require_session_internal("validation-test", "Forbidden. You do not have permission to run validation.")
    if gate:
        return gate
    data = request.get_json(force=True, silent=True) or {}
    mode = str(data.get("mode") or "usp2").strip().lower()
    if mode not in ("usp1", "usp2"):
        mode = "usp2"
    check = hardware_service.cmd_check_adapter()
    detected = _adapter_kind_from_check_result(check)
    if detected != mode:
        audit_action = (
            "check adaptor and holder" if mode == "usp2" else "holder error"
        )
        user_message = (
            "Check adaptor and holder"
            if mode == "usp2"
            else "Holder error"
        )
        _audit_event(
            action=audit_action,
            outcome="failed",
            entity_type="hardware",
            entity_name="holder",
            details="Validation start blocked: expected {}, detected {}".format(
                mode, detected or "none"
            ),
            extra={"expected": mode, "detected": detected, "mode": mode},
        )
        return jsonify({
            "ok": False,
            "error": "adapter_mismatch",
            "expected": mode,
            "detected": detected,
            "message": user_message,
            "response": (check.get("response") if check else None),
        }), 400
    result = hardware_service.cmd_start_validation(mode)
    return jsonify(result), (200 if result.get("ok") else 400)


@app.route("/api/hardware/validation/vacuum/start", methods=["POST"])
def validation_vacuum_start():
    gate = _require_session_internal("validation-test", "Forbidden. You do not have permission to run validation.")
    if gate:
        return gate
    data = request.get_json(force=True, silent=True) or {}
    try:
        vacuum_mmhg = float(data.get("vacuumMmHg"))
        duration_sec = float(data.get("durationSec"))
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "vacuumMmHg and durationSec are required"}), 400
    if vacuum_mmhg < 1 or duration_sec < 1:
        return jsonify({"ok": False, "error": "Vacuum and duration must be at least 1"}), 400
    factory = data_service.get_factory_settings() or {}
    max_vac = float(factory.get("maxVacuumMmHg") or 650)
    max_vac = min(650.0, max(1.0, max_vac))
    if vacuum_mmhg > max_vac:
        return jsonify({
            "ok": False,
            "error": f"Vacuum exceeds factory maximum of {int(max_vac)} mmHg",
        }), 400
    result = hardware_service.cmd_start_vacuum_validation(vacuum_mmhg, duration_sec)
    return jsonify(result), (200 if result.get("ok") else 400)


@app.route("/api/hardware/calibration/start", methods=["POST"])
def hardware_calibration_start():
    gate = _require_session_internal(
        "calibration-menu",
        "Forbidden. You do not have permission to run calibration.",
    )
    if gate:
        return gate
    data = request.get_json(force=True, silent=True) or {}
    factory = data_service.get_factory_settings() or {}
    try:
        target = float(data.get("targetVacuumMmHg") or factory.get("calibrationTargetVacuumMmHg") or 400)
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "Invalid calibration target vacuum"}), 400
    max_vac = float(factory.get("maxVacuumMmHg") or 650)
    max_vac = min(650.0, max(1.0, max_vac))
    if target < 1 or target > max_vac:
        return jsonify({
            "ok": False,
            "error": f"Calibration target must be 1–{int(max_vac)} mmHg",
        }), 400
    result = hardware_service.cmd_start_calibration(target)
    return jsonify(result), (200 if result.get("ok") else 400)


@app.route("/api/hardware/calibration/esp-start", methods=["POST"])
def hardware_calibration_esp_start():
    """Send #START_CALIB* after the operator enters the external gauge reading."""
    gate = _require_session_internal(
        "calibration-menu",
        "Forbidden. You do not have permission to run calibration.",
    )
    if gate:
        return gate
    result = hardware_service.cmd_esp_start_calib()
    return jsonify(result), (200 if result.get("ok") else 400)


@app.route("/api/hardware/calibration/apply", methods=["POST"])
def hardware_calibration_apply():
    gate = _require_session_internal(
        "calibration-menu",
        "Forbidden. You do not have permission to run calibration.",
    )
    if gate:
        return gate
    data = request.get_json(force=True, silent=True) or {}
    factory = data_service.get_factory_settings() or {}
    try:
        # Absolute external-gauge reading the operator entered (not a difference).
        if data.get("gaugeValue") is not None:
            calib_value = float(data.get("gaugeValue"))
        elif data.get("calibValue") is not None:
            calib_value = float(data.get("calibValue"))
        else:
            return jsonify({"ok": False, "error": "gaugeValue (actual pressure) is required"}), 400
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "Invalid calibration value"}), 400
    try:
        release_time = int(
            data.get("releaseTimeSec")
            if data.get("releaseTimeSec") is not None
            else factory.get("calibrationReleaseTimeSec") or 80
        )
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "Invalid release time"}), 400
    gauge_value = calib_value
    set_vacuum = data.get("setVacuumMmHg")
    try:
        if set_vacuum is not None:
            set_vacuum = float(set_vacuum)
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "Invalid set vacuum"}), 400
    result = hardware_service.cmd_apply_calibration(
        calib_value,
        release_time_sec=release_time,
        gauge_value=gauge_value,
        set_vacuum_mmhg=set_vacuum,
    )
    if result.get("ok"):
        token = result.get("calibValueToken") or str(int(round(calib_value)))
        _audit_event(
            action="Calibration applied",
            outcome="success",
            entity_type="calibration",
            entity_name="vacuum",
            details=f"CALIBVALUE={token} gauge={gauge_value} set={set_vacuum}",
            extra={
                "calibValue": calib_value,
                "calibValueToken": token,
                "gaugeValue": gauge_value,
                "setVacuumMmHg": set_vacuum,
                "releaseTimeSec": release_time,
            },
        )
    return jsonify(result), (200 if result.get("ok") else 400)


@app.route("/api/hardware/calibration/stop-calib", methods=["POST"])
def hardware_calibration_stop_calib():
    """Send #STOP_CALIB* and wait for #STOP_CALIB_ACK* after CALIBVALUE."""
    gate = _require_session_internal(
        "calibration-menu",
        "Forbidden. You do not have permission to run calibration.",
    )
    if gate:
        return gate
    result = hardware_service.cmd_esp_stop_calib()
    return jsonify(result), (200 if result.get("ok") else 400)


@app.route("/api/hardware/calibration/stop", methods=["POST"])
def hardware_calibration_stop():
    gate = _require_session_internal(
        "calibration-menu",
        "Forbidden. You do not have permission to run calibration.",
    )
    if gate:
        return gate
    return jsonify(hardware_service.cmd_stop())


@app.route("/api/hardware/validation/load/stop", methods=["POST"])
def validation_load_stop():
    gate = _require_session_internal("validation-test", "Forbidden. You do not have permission to run validation.")
    if gate:
        return gate
    return jsonify(hardware_service.cmd_stop())


@app.route("/api/hardware/adapter/check", methods=["POST"])
def hardware_check_adapter():
    gate = _require_any_session_internal(
        ["validation-test", "quick-test", "recipe-test"],
        "Forbidden. You do not have permission to use hardware controls.",
    )
    if gate:
        return gate
    result = hardware_service.cmd_check_adapter()
    detected = _adapter_kind_from_check_result(result)
    if detected == "error" or (result and not result.get("ok") and detected is None):
        _audit_event(
            action="Holder check error",
            outcome="failed",
            entity_type="hardware",
            entity_name="holder",
            details=(result.get("response") if isinstance(result, dict) else None) or "Holder check failed",
            extra={"detected": detected, "response": result},
        )
    return jsonify(result)


@app.route("/api/hardware/leak/start", methods=["POST"])
def hardware_leak_start():
    gate = _require_any_session_internal(
        ["quick-test", "recipe-test"],
        "Forbidden. You do not have permission to run tests.",
    )
    if gate:
        return gate
    data = request.get_json(force=True, silent=True) or {}
    factory = data_service.get_factory_settings() or {}
    try:
        vacuum_mmhg = float(data.get("vacuumMmHg"))
    except (TypeError, ValueError):
        vacuum_mmhg = None
    if vacuum_mmhg is not None:
        max_vac = float(factory.get("maxVacuumMmHg") or 650)
        max_vac = min(650.0, max(1.0, max_vac))
        if vacuum_mmhg < 1:
            return jsonify({"ok": False, "error": "Vacuum must be at least 1 mmHg"}), 400
        if vacuum_mmhg > max_vac:
            return jsonify({
                "ok": False,
                "error": "Vacuum exceeds factory maximum of {} mmHg".format(int(max_vac)),
            }), 400
    result = hardware_service.cmd_start_test(data)
    return jsonify(result), (200 if result.get("ok") else 400)


@app.route("/api/hardware/leak/stop", methods=["POST"])
def hardware_leak_stop():
    gate = _require_any_session_internal(
        ["quick-test", "recipe-test", "validation-test", "calibration-menu"],
        "Forbidden. You do not have permission to stop hardware.",
    )
    if gate:
        return gate
    result = hardware_service.cmd_stop()
    return jsonify(result)


# =================== BIOMETRIC ==========================


@app.route("/api/biometric/status", methods=["GET"])
def biometric_status():
    try:
        if not _is_biometric_enabled():
            return jsonify({"ok": False, "error": "Biometric disabled by factory settings"}), 403
        result = biometric_service.status()
        return jsonify(result), 200 if result.get("ok") else 500
    except Exception as e:
        app.logger.exception("Error checking biometric status")
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/biometric/enroll", methods=["POST"])
def biometric_enroll():
    try:
        if not _is_biometric_enabled():
            return jsonify({"ok": False, "error": "Biometric enrollment is disabled by Factory Settings."}), 403
        payload = request.get_json(force=True, silent=True) or {}
        username = str(payload.get("username") or "").strip()
        if not username:
            return jsonify({"ok": False, "error": "username is required"}), 400
        member = data_service.get_member_by_username(username)
        if not member:
            _audit_event(action="Biometric enroll", outcome="failed", entity_type="member", entity_name=username, details="Member not found for provided username", target_user=username)
            return jsonify({"ok": False, "error": "Member not found for the provided username"}), 404
        before_member = dict(member)
        status = str(member.get("status") or "active").strip().lower()
        if status != "active":
            _audit_event(action="Biometric enroll", outcome="denied", entity_type="member", entity_id=member.get("id"), entity_name=username, details="Member account is not active", target_user=username, before=before_member)
            return jsonify({"ok": False, "error": "Member account is not active"}), 403
        template_id_raw = payload.get("templateId")
        if template_id_raw is None:
            template_id = data_service.get_next_fingerprint_template_id()
        else:
            template_id = int(template_id_raw)
        timeout_sec = float(payload.get("captureTimeoutSec") or BIOMETRIC_ENROLL_TIMEOUT_SEC)
        enrolled = biometric_service.enroll(template_id, capture_timeout_sec=timeout_sec)
        if not enrolled.get("ok"):
            _audit_event(action="Biometric enroll", outcome="failed", entity_type="member", entity_id=member.get("id"), entity_name=username, details=enrolled.get("error") or "Unknown error", target_user=username, before=before_member, extra={"templateId": template_id})
            return jsonify(enrolled), 400
        previous_owner = data_service.get_member_by_fingerprint_template(template_id)
        if previous_owner and previous_owner.get("id") != member.get("id"):
            previous_owner["fingerprintTemplateId"] = None
            previous_owner["biometricEnrollmentStatus"] = "not_enrolled"
            previous_owner["biometricEnrolledAt"] = None
            data_service.save_member(previous_owner)
        member["fingerprintTemplateId"] = template_id
        member["biometricEnrollmentStatus"] = "enrolled"
        member["biometricEnrolledAt"] = int(time.time())
        member["biometricEnabled"] = True
        data_service.save_member(member)
        _audit_event(
            action="Biometric enroll",
            outcome="success",
            entity_type="member",
            entity_id=member.get("id"),
            entity_name=username,
            details="Fingerprint enrolled and linked",
            target_user=username,
            before=before_member,
            after=member,
            extra={"templateId": template_id},
        )
        return jsonify({"ok": True, "templateId": template_id, "linked": True, "memberId": member.get("id")}), 200
    except Exception as e:
        app.logger.exception("Error during biometric enrollment")
        return jsonify({"ok": False, "error": str(e)}), 500




def _clear_enroll_session(username):
    key = str(username or "").strip().lower()
    if not key:
        return
    with _enroll_sessions_lock:
        _enroll_sessions.pop(key, None)


def _get_enroll_session(username):
    key = str(username or "").strip().lower()
    with _enroll_sessions_lock:
        return dict(_enroll_sessions.get(key) or {})


def _set_enroll_session(username, data):
    key = str(username or "").strip().lower()
    with _enroll_sessions_lock:
        _enroll_sessions[key] = dict(data or {})


@app.route("/api/biometric/enroll/capture", methods=["POST"])
def biometric_enroll_capture():
    """Step 1 or 2 of fingerprint enrollment (two scans of the same finger)."""
    try:
        if not _is_biometric_enabled():
            return jsonify({"ok": False, "error": "Biometric enrollment is disabled by Factory Settings."}), 403
        payload = request.get_json(force=True, silent=True) or {}
        username = str(payload.get("username") or "").strip()
        if not username:
            return jsonify({"ok": False, "error": "username is required"}), 400
        try:
            step = int(payload.get("step") or 0)
        except (TypeError, ValueError):
            step = 0
        if step not in (1, 2):
            return jsonify({"ok": False, "error": "step must be 1 or 2"}), 400
        member = data_service.get_member_by_username(username)
        if not member:
            return jsonify({"ok": False, "error": "Member not found for the provided username"}), 404
        status = str(member.get("status") or "active").strip().lower()
        if status != "active":
            return jsonify({"ok": False, "error": "Member account is not active"}), 403
        before_member = dict(member)
        timeout_sec = float(payload.get("captureTimeoutSec") or BIOMETRIC_ENROLL_TIMEOUT_SEC)

        if step == 1:
            template_id_raw = payload.get("templateId")
            if template_id_raw is None:
                template_id = data_service.get_next_fingerprint_template_id()
            else:
                template_id = int(template_id_raw)
            captured = biometric_service.capture_enroll_finger(0x01, timeout_sec=timeout_sec)
            if not captured.get("ok"):
                _clear_enroll_session(username)
                return jsonify(captured), 400
            _set_enroll_session(username, {"templateId": template_id, "step1Done": True, "startedAt": int(time.time())})
            return jsonify({
                "ok": True,
                "step": 1,
                "nextStep": 2,
                "templateId": template_id,
                "message": "First scan complete. Remove your finger from the scanner.",
                "nextMessage": "Place the same finger on the scanner again for the second scan.",
            }), 200

        session = _get_enroll_session(username)
        if not session.get("step1Done"):
            return jsonify({"ok": False, "error": "Complete capture step 1 before step 2."}), 400
        template_id = int(session.get("templateId") or 0)
        if template_id <= 0:
            _clear_enroll_session(username)
            return jsonify({"ok": False, "error": "Enrollment session expired. Start again."}), 400

        captured = biometric_service.capture_enroll_finger(0x02, timeout_sec=timeout_sec)
        if not captured.get("ok"):
            _clear_enroll_session(username)
            return jsonify(captured), 400

        finalized = biometric_service.finalize_enroll(template_id)
        _clear_enroll_session(username)
        if not finalized.get("ok"):
            _audit_event(
                action="Biometric enroll",
                outcome="failed",
                entity_type="member",
                entity_id=member.get("id"),
                entity_name=username,
                details=finalized.get("error") or "Unknown error",
                target_user=username,
                before=before_member,
                extra={"templateId": template_id},
            )
            return jsonify(finalized), 400

        previous_owner = data_service.get_member_by_fingerprint_template(template_id)
        if previous_owner and previous_owner.get("id") != member.get("id"):
            previous_owner["fingerprintTemplateId"] = None
            previous_owner["biometricEnrollmentStatus"] = "not_enrolled"
            previous_owner["biometricEnrolledAt"] = None
            data_service.save_member(previous_owner)
        member["fingerprintTemplateId"] = template_id
        member["biometricEnrollmentStatus"] = "enrolled"
        member["biometricEnrolledAt"] = int(time.time())
        member["biometricEnabled"] = True
        data_service.save_member(member)
        _audit_event(
            action="Biometric enroll",
            outcome="success",
            entity_type="member",
            entity_id=member.get("id"),
            entity_name=username,
            details="Fingerprint enrolled and linked (2 captures)",
            target_user=username,
            before=before_member,
            after=member,
            extra={"templateId": template_id},
        )
        return jsonify({
            "ok": True,
            "step": 2,
            "templateId": template_id,
            "linked": True,
            "memberId": member.get("id"),
            "message": "Fingerprint registered successfully.",
        }), 200
    except Exception as e:
        app.logger.exception("Error during biometric enroll capture")
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/biometric/enroll/cancel", methods=["POST"])
def biometric_enroll_cancel():
    try:
        payload = request.get_json(force=True, silent=True) or {}
        username = str(payload.get("username") or "").strip()
        if username:
            _clear_enroll_session(username)
        return jsonify({"ok": True}), 200
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

@app.route("/api/biometric/delete", methods=["POST"])
def biometric_delete():
    try:
        payload = request.get_json(force=True, silent=True) or {}
        template_id = payload.get("templateId")
        username = str(payload.get("username") or "").strip()
        member_id = payload.get("memberId")
        if template_id is None and not username and member_id is None:
            return jsonify({"ok": False, "error": "templateId, username, or memberId is required"}), 400
        member = None
        if member_id is not None:
            try:
                member = data_service.get_member(int(member_id))
            except (TypeError, ValueError):
                member = None
        if member is None and username:
            member = data_service.get_member_by_username(username)
        if template_id is None and member is not None:
            template_id = member.get("fingerprintTemplateId")
        if template_id is None:
            # Nothing on sensor; still clear member link if requested
            if member and member.get("id") is not None:
                data_service.clear_member_biometric(int(member["id"]))
            return jsonify({"ok": True, "templateId": None, "cleared": True}), 200
        result = biometric_service.delete_template(template_id)
        if result.get("ok"):
            if member and member.get("id") is not None:
                data_service.clear_member_biometric(int(member["id"]))
            elif username or member_id is not None:
                # Template deleted; clear any member still pointing at this slot
                by_tpl = data_service.get_member_by_fingerprint_template(int(template_id))
                if by_tpl and by_tpl.get("id") is not None:
                    data_service.clear_member_biometric(int(by_tpl["id"]))
            _audit_event(
                action="Biometric template delete",
                outcome="success",
                entity_type="biometric_template",
                entity_id=template_id,
                entity_name="template {}".format(template_id),
                details="Template deleted from sensor",
                extra={"templateId": int(template_id)},
            )
            return jsonify({"ok": True, "templateId": int(template_id)}), 200
        _audit_event(
            action="Biometric template delete",
            outcome="failed",
            entity_type="biometric_template",
            entity_id=template_id,
            entity_name="template {}".format(template_id),
            details=result.get("error") or "Delete failed",
            extra={"templateId": int(template_id)},
        )
        return jsonify(result), 400
    except Exception as e:
        app.logger.exception("Error deleting biometric template")
        return jsonify({"ok": False, "error": str(e)}), 500


# =================== DATETIME / RTC ==========================


def _get_stored_datetime():
    """Return local wall time from the DS1307 (hwclock on /dev/rtc0), not NTP/network."""
    return rtc_service.get_device_wall_datetime_payload()


@app.route("/api/get_datetime", methods=["GET"])
def get_datetime():
    compare = str(request.args.get("compare") or request.args.get("network") or "").strip().lower() in (
        "1", "true", "yes",
    )
    return jsonify(rtc_service.get_device_wall_datetime_payload(compare_network=compare))


def _set_datetime_common():
    denied = _require_edit_datetime()
    if denied:
        return denied
    data = request.get_json(force=True, silent=True) or {}
    dt_str = data.get("datetime", "")
    if not dt_str:
        return jsonify({"ok": False, "error": "datetime required"}), 400
    prev_payload = _get_stored_datetime()
    prev_raw = (prev_payload.get("datetime") or "").strip()
    try:
        clean = dt_str.strip().replace("Z", "")
        if "+" in clean:
            clean = clean.split("+", 1)[0]
        if clean.count("-") > 2:
            clean = clean.rsplit("-", 1)[0]
        dt_obj = datetime.fromisoformat(clean)
        if getattr(dt_obj, "tzinfo", None) is not None:
            dt_obj = dt_obj.replace(tzinfo=None)
    except Exception:
        return jsonify({"ok": False, "error": "invalid datetime"}), 400
    rtc_ok, rtc_err = rtc_service.apply_user_wall_time(dt_obj)
    if not rtc_ok:
        return jsonify({"ok": False, "error": rtc_err or "Failed to set RTC time"}), 500
    try:
        STORAGE_DIR.mkdir(parents=True, exist_ok=True)
        with open(DATETIME_STORAGE, "w", encoding="utf-8") as f:
            json.dump({"datetime": dt_obj.strftime("%Y-%m-%dT%H:%M:%S"), "last_tick": time.time()}, f)
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500
    applied = rtc_service.get_device_wall_datetime_payload()
    new_raw = (applied.get("datetime") or dt_obj.strftime("%Y-%m-%dT%H:%M:%S")).strip()
    _audit(
        None,
        None,
        "System date change",
        "Changed from {} to {}".format(
            _format_wall_datetime_for_audit(prev_raw),
            _format_wall_datetime_for_audit(new_raw),
        ),
    )
    return jsonify({
        "ok": True,
        "datetime": applied.get("datetime") or dt_obj.strftime("%Y-%m-%dT%H:%M:%S"),
        "source": applied.get("source", "rtc"),
    })


@app.route("/api/set_datetime", methods=["POST"])
def set_datetime():
    # Backward-compatible route used by older frontend builds.
    return _set_datetime_common()


@app.route("/api/set_device_datetime", methods=["POST"])
def set_device_datetime():
    # Reference-project route used by updated frontend flow.
    return _set_datetime_common()


@app.route("/api/rtc/date", methods=["GET"])
def get_rtc_date():
    result = rtc_service.get_rtc_date()
    return jsonify(result), 200


@app.route("/api/rtc/date", methods=["POST"])
def set_rtc_date_route():
    denied = _require_edit_datetime()
    if denied:
        return denied
    data = request.get_json(force=True, silent=True) or {}
    dt_str = data.get("datetime", "")
    if not dt_str:
        return jsonify({"success": False, "error": "datetime required"}), 400
    try:
        from datetime import datetime
        dt_obj = datetime.fromisoformat(dt_str.replace("Z", "+00:00"))
    except Exception:
        return jsonify({"success": False, "error": "invalid datetime"}), 400
    result = rtc_service.set_rtc_date(dt_obj)
    if result.get("success"):
        _audit(None, None, "RTC date set", dt_str)
    return jsonify(result), 200 if result.get("success") else 500


@app.route("/api/system/network-addresses", methods=["GET"])
def get_network_addresses():
    denied = _require_auth()
    if denied:
        return denied
    try:
        payload = network_service.list_non_tailscale_addresses()
        if not isinstance(payload, dict):
            payload = {"ok": False, "error": "Invalid network payload", "wlan": None, "lan": None}
        elif payload.get("ok") is not False and "ok" not in payload:
            payload["ok"] = True
        _audit(
            None,
            None,
            "IP addresses viewed",
            "lan={} wlan={}".format(payload.get("lan") or "—", payload.get("wlan") or "—"),
        )
        return jsonify(payload), 200
    except Exception as exc:
        app.logger.exception("network-addresses failed")
        return jsonify({"ok": False, "error": str(exc), "wlan": None, "lan": None}), 500


_startup_session_power_audit()
_register_clean_shutdown_signals()
_register_clean_shutdown_atexit()


@app.route("/<path:path>", methods=["GET"])
def serve_static(path):
    if path.startswith("api/"):
        return jsonify({"error": "Not found"}), 404
    return send_from_directory(APP_ROOT, path)


# =================== MAIN ==========================


if __name__ == "__main__":
    app.run(host=FLASK_HOST, port=FLASK_PORT, debug=False, threaded=True)
