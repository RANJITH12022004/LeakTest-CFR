#!/usr/bin/env python3
"""Patch Leak Test app.py: audit-log failed USB report exports."""

from __future__ import annotations

import pathlib
import sys

APP = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "/opt/kiosk/app.py")

OLD_LOG = '''def _log_usb_export_audit(cur, verifier, action: str, detail: str) -> None:
    exported_by = _export_actor_snapshot(cur or {})
    approved_by = _export_actor_from_verifier(verifier) if verifier else dict(exported_by)
    ex_u = (exported_by or {}).get("username") or "--"
    ex_e = (exported_by or {}).get("employee_id") or "--"
    exporter_line = "exported by {} ({})".format(ex_u, ex_e)
    if verifier:
        if exporter_line not in detail:
            detail = "{} | {}".format(detail, exporter_line) if detail else exporter_line
    else:
        actors = _format_export_actors_detail(exported_by, approved_by)
        if actors and actors not in detail:
            detail = "{} | {}".format(detail, actors)
    signature = {}
    if verifier:
        signature = {
            "mode": "export_approval",
            "username": approved_by.get("username") or "--",
            "role": approved_by.get("role") or "--",
        }
    extra = {
        "exportedBy": exported_by,
        "exportApprovedBy": approved_by,
    }
    approver_user = (approved_by or {}).get("username") if verifier else None
    approver_role = (approved_by or {}).get("role") if verifier else None
    _audit_event(
        action=action,
        outcome="success",
        details=detail,
        event_type="compliance",
        signature=signature,
        extra=extra,
        actor_user=approver_user,
        actor_role=approver_role,
    )'''

NEW_LOG = '''def _audit_error_from_response(resp) -> str:
    try:
        if resp is not None:
            data = resp.get_json(silent=True) or {}
            return str(data.get("error") or data.get("message") or "").strip()
    except Exception:
        pass
    return ""


def _audit_report_ids_label(report_ids) -> str:
    out = []
    for rid in report_ids or []:
        try:
            out.append(int(rid))
        except (TypeError, ValueError):
            continue
    return ", ".join(str(i) for i in out)


def _log_usb_export_audit(
    cur,
    verifier,
    action: str,
    detail: str,
    *,
    outcome: str = "success",
    attribute_approver: bool = True,
    extra: dict = None,
) -> None:
    exported_by = _export_actor_snapshot(cur or {})
    approved_by = _export_actor_from_verifier(verifier) if verifier else dict(exported_by)
    ex_u = (exported_by or {}).get("username") or "--"
    ex_e = (exported_by or {}).get("employee_id") or "--"
    exporter_line = "exported by {} ({})".format(ex_u, ex_e)
    if verifier and attribute_approver and outcome == "success":
        if exporter_line not in detail:
            detail = "{} | {}".format(detail, exporter_line) if detail else exporter_line
    elif outcome == "success":
        actors = _format_export_actors_detail(exported_by, approved_by)
        if actors and actors not in detail:
            detail = "{} | {}".format(detail, actors)
    elif exporter_line not in detail:
        detail = "{} | {}".format(detail, exporter_line) if detail else exporter_line
    signature = {}
    if verifier and attribute_approver and outcome == "success":
        signature = {
            "mode": "export_approval",
            "username": approved_by.get("username") or "--",
            "role": approved_by.get("role") or "--",
        }
    audit_extra = {
        "exportedBy": exported_by,
        "exportApprovedBy": approved_by,
    }
    if extra:
        audit_extra.update(extra)
    approver_user = None
    approver_role = None
    if verifier and attribute_approver and outcome == "success":
        approver_user = (approved_by or {}).get("username")
        approver_role = (approved_by or {}).get("role")
    _audit_event(
        action=action,
        outcome=outcome,
        details=detail,
        event_type="compliance",
        signature=signature,
        extra=audit_extra,
        actor_user=approver_user,
        actor_role=approver_role,
    )


def _log_reports_export_failure(cur, verifier, reason: str, report_ids=None, extra=None) -> None:
    detail = str(reason or "Report export failed").strip() or "Report export failed"
    label = _audit_report_ids_label(report_ids)
    if label:
        detail = "{} | report ids: {}".format(detail, label)
    fail_extra = dict(extra or {})
    if label:
        fail_extra["reportIds"] = label
    _log_usb_export_audit(
        cur,
        verifier,
        "Reports export failed",
        detail,
        outcome="failed",
        attribute_approver=False,
        extra=fail_extra,
    )'''


def main() -> int:
    text = APP.read_text(encoding="utf-8")
    if "_log_reports_export_failure" in text:
        print("Already patched", APP)
        return 0
    if OLD_LOG not in text:
        print("Could not find _log_usb_export_audit block", file=sys.stderr)
        return 1
    text = text.replace(OLD_LOG, NEW_LOG, 1)
    APP.write_text(text, encoding="utf-8")
    print("Patched helpers in", APP)
    print("NOTE: Apply export_reports/stream call-site patches from deploy script or manual merge.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
