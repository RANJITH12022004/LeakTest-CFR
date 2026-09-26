#!/usr/bin/env python3
"""Patch leak-test kiosk for audit permission label + export approval audit logging."""
from pathlib import Path

APP = Path("/opt/kiosk/app.py")
RBAC = Path("/opt/kiosk/rbac_service.py")

OLD_REQUIRE = '''def _require_export_usb_and_verification_json():
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
'''

NEW_REQUIRE = '''def _require_export_usb_and_verification_json():
    """Return (error_response_or_None, export_approval_verifier_payload_or_None)."""
    cur = data_service.get_current_user()
    if not cur:
        return (jsonify({"success": False, "error": "Unauthorized"}), 401), None
    data_service.refresh_current_user_from_member()
    if not _session_has_internal("export-usb"):
        return (
            jsonify({"success": False, "error": "Forbidden. Export to USB is not permitted for this account."}),
            403,
        ), None
    role = str(cur.get("role") or "").strip().lower()
    verifier = None
    if role != "factory":
        _verified, verify_err = _consume_approval_verify_token("export")
        if verify_err:
            return (jsonify({"success": False, "error": verify_err}), 401), None
        exporter_un = _norm_username(cur.get("username") or cur.get("name"))
        verifier_un = _norm_username((_verified or {}).get("username") or (_verified or {}).get("name"))
        if exporter_un and verifier_un and exporter_un == verifier_un:
            return (
                jsonify({
                    "success": False,
                    "error": "You cannot approve your own export. Another user with export approval permission must verify.",
                }),
                403,
            ), None
        verifier = _verified
    return None, verifier


def _resolve_employee_id(username: str, role: str = "") -> str:
    uname = str(username or "").strip()
    if not uname:
        return "--"
    member = data_service.get_member_by_username(uname)
    if member:
        emp = member.get("employeeId") or member.get("employee_id")
        if emp is not None and str(emp).strip():
            return str(emp).strip()
    return uname


def _export_actor_snapshot(user_dict: dict) -> dict:
    username = str(user_dict.get("username") or user_dict.get("name") or "").strip() or "--"
    role = str(user_dict.get("role") or "").strip() or "--"
    return {
        "username": username,
        "employee_id": _resolve_employee_id(username, role),
        "role": role,
    }


def _export_actor_from_verifier(verifier: dict) -> dict:
    if not verifier:
        return {}
    return _export_actor_snapshot(
        {
            "username": verifier.get("username") or verifier.get("name"),
            "role": verifier.get("role"),
        }
    )


def _format_export_actors_detail(exported_by, approved_by):
    ex_u = (exported_by or {}).get("username") or "--"
    ex_e = (exported_by or {}).get("employee_id") or "--"
    ap_u = (approved_by or {}).get("username") or "--"
    ap_e = (approved_by or {}).get("employee_id") or "--"
    return "exported by {} ({}) | approved by {} ({})".format(ex_u, ex_e, ap_u, ap_e)


def _log_usb_export_audit(cur, verifier, action: str, detail: str) -> None:
    exported_by = _export_actor_snapshot(cur or {})
    approved_by = _export_actor_from_verifier(verifier) if verifier else dict(exported_by)
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
    _audit_event(
        action=action,
        outcome="success",
        details=detail,
        event_type="compliance",
        signature=signature,
        extra=extra,
    )
'''

OLD_AUDIT_EXPORT_AUDIT = '''        _audit(
            cur.get("username") or cur.get("name"),
            cur.get("role"),
            "Audit trail exported",
            "pdf {} | entries {}".format(out_path, len(entries)),
        )'''

NEW_AUDIT_EXPORT_AUDIT = '''        _log_usb_export_audit(
            cur,
            verifier,
            "Audit trail exported",
            "pdf {} | entries {}".format(out_path, len(entries)),
        )'''

OLD_REPORT_EXPORT_GATE = '''        gate = _require_export_usb_and_verification_json()
        if gate is not None:
            return gate
        device_path = (data.get("device_path") or "").strip() or None'''

NEW_REPORT_EXPORT_GATE = '''        gate, verifier = _require_export_usb_and_verification_json()
        if gate is not None:
            return gate
        cur = data_service.get_current_user()
        device_path = (data.get("device_path") or "").strip() or None'''

OLD_REPORT_EXPORT_AUDIT = '''        ok_count = len(exported_files)
        _audit(
            None, None,
            "Reports exported",
            "Exported {} report{} to USB".format(
                ok_count, "" if ok_count == 1 else "s"
            ),
        )'''

NEW_REPORT_EXPORT_AUDIT = '''        ok_count = len(exported_files)
        ids_label = ", ".join(str(i) for i in report_ids[:ok_count]) if ok_count else ""
        detail = "Exported {} report{} to USB".format(ok_count, "" if ok_count == 1 else "s")
        if ids_label:
            detail = "{} (ids: {})".format(detail, ids_label)
        _log_usb_export_audit(cur, verifier, "Reports exported", detail)'''

OLD_STREAM_GATE = '''    gate = _require_export_usb_and_verification_json()
    if gate is not None:
        return gate
'''

NEW_STREAM_GATE = '''    gate, verifier = _require_export_usb_and_verification_json()
    if gate is not None:
        return gate
    cur = data_service.get_current_user()
'''

OLD_STREAM_AUDIT = '''            ok_count = result["count"]
            _audit(
                None, None,
                "Reports exported",
                "Exported {} report{} to USB".format(
                    ok_count, "" if ok_count == 1 else "s"
                ),
            )'''

NEW_STREAM_AUDIT = '''            ok_count = result["count"]
            detail = "Exported {} report{} to USB (stream)".format(
                ok_count, "" if ok_count == 1 else "s"
            )
            _log_usb_export_audit(cur, verifier, "Reports exported", detail)'''


def patch_file(path: Path, replacements):
    text = path.read_text()
    for old, new, label in replacements:
        if old not in text:
            if new.split("\n", 1)[0] in text:
                print(path, label, "already applied")
                continue
            raise SystemExit(f"{path}: missing block for {label}")
        text = text.replace(old, new, 1)
        print(path, label, "patched")
    path.write_text(text)


def main():
    rbac = RBAC.read_text()
    rbac = rbac.replace(
        '"perm_audit_view": "View and print audit trails",',
        '"perm_audit_view": "View audit trails only",',
        1,
    )
    RBAC.write_text(rbac)
    print(RBAC, "perm_audit_view label patched")

    app_replacements = [
        (OLD_REQUIRE, NEW_REQUIRE, "_require_export_usb"),
        (OLD_AUDIT_EXPORT_AUDIT, NEW_AUDIT_EXPORT_AUDIT, "export_audit_trails audit"),
        (OLD_REPORT_EXPORT_GATE, NEW_REPORT_EXPORT_GATE, "export_reports gate"),
        (OLD_REPORT_EXPORT_AUDIT, NEW_REPORT_EXPORT_AUDIT, "export_reports audit"),
        (OLD_STREAM_GATE, NEW_STREAM_GATE, "export_reports_stream gate"),
        (OLD_STREAM_AUDIT, NEW_STREAM_AUDIT, "export_reports_stream audit"),
    ]
    # export_audit_trails gate
    app = APP.read_text()
    app = app.replace(
        '''        gate = _require_export_usb_and_verification_json()
        if gate is not None:
            return gate
        audit_gate = _require_session_internal(
            "audit-view",
''',
        '''        gate, verifier = _require_export_usb_and_verification_json()
        if gate is not None:
            return gate
        audit_gate = _require_session_internal(
            "audit-view",
''',
        1,
    )
    APP.write_text(app)
    patch_file(APP, app_replacements)


if __name__ == "__main__":
    main()
