#!/usr/bin/env python3
"""Apply audit User/User ID column fix to Leak Test Pi app.py (actor_user API)."""

from __future__ import annotations

import pathlib
import sys

APP = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "/opt/kiosk/app.py")


def main() -> int:
    text = APP.read_text(encoding="utf-8")
    changed = False

    if "_verifier_audit_actor" not in text:
        needle = "def _audit_event("
        if needle not in text:
            print("Missing _audit_event", file=sys.stderr)
            return 1
        insert = '''def _verifier_audit_actor(verifier: dict) -> dict:
    if not verifier:
        return _audit_actor()
    uname = str(verifier.get("username") or verifier.get("name") or "").strip()
    member = data_service.get_member_by_username(uname) if uname else None
    return _member_login_actor(member or verifier, uname)


_ACTIONS_ATTRIBUTED_TO_SIGNATURE_USER = frozenset(
    {"Approval verification", "Audit trail exported", "Reports exported"}
)


'''
        text = text.replace(needle, insert + needle, 1)
        changed = True

    old_audit = """def _audit_event(
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
        session_role=actor.get("role"),"""

    new_audit = """def _audit_event(
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
    kiosk_actor = _audit_actor()
    actor = dict(kiosk_actor)
    if actor_user is not None:
        actor["user"] = str(actor_user or "").strip() or "--"
    if actor_role is not None:
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
        session_user=kiosk_actor.get("user"),
        session_role=kiosk_actor.get("role"),"""

    if old_audit in text:
        text = text.replace(old_audit, new_audit, 1)
        changed = True

    old_fmt = """def _format_verification_token_issued_audit_details(verifier: dict, purpose: str, method: str) -> str:
    \"\"\"Human-readable audit text: who issued the short-lived approval verification token.\"\"\"
    actor = _export_actor_from_verifier(verifier)
    username = str(actor.get("username") or "--").strip() or "--"
    employee_id = str(actor.get("employee_id") or username).strip() or username
    purpose_text = str(purpose or "").strip().lower().replace("_", " ") or "approval"
    detail = "Verification token issued by {} ({}) for {}".format(username, employee_id, purpose_text)
    method_text = str(method or "").strip().lower()
    if method_text and method_text not in ("credentials",):
        detail = "{} | method: {}".format(detail, method_text)
    return detail"""

    new_fmt = """def _format_verification_token_issued_audit_details(
    verifier: dict, purpose: str, method: str, *, issuer_in_details: bool = True
) -> str:
    purpose_text = str(purpose or "").strip().lower().replace("_", " ") or "approval"
    method_text = str(method or "").strip().lower()
    if issuer_in_details:
        actor = _export_actor_from_verifier(verifier)
        username = str(actor.get("username") or "--").strip() or "--"
        employee_id = str(actor.get("employee_id") or username).strip() or username
        detail = "Verification token issued by {} ({}) for {}".format(username, employee_id, purpose_text)
    else:
        detail = "Verification token for {}".format(purpose_text)
    if method_text and method_text not in ("credentials",):
        detail = "{} | method: {}".format(detail, method_text)
    return detail"""

    if old_fmt in text:
        text = text.replace(old_fmt, new_fmt, 1)
        changed = True

    old_verify = """        issued_by = _export_actor_from_verifier(verifier)
        _audit_event(
            action="Approval verification",
            outcome="success",
            entity_type="verification",
            entity_name=purpose,
            details=_format_verification_token_issued_audit_details(verifier, purpose, method),
            target_user=vname,
            signature={"mode": method, "username": vname, "role": verifier_role},
            extra={
                "purpose": purpose,
                "method": method,
                "verificationTokenIssuedBy": issued_by,
            },
        )"""

    new_verify = """        issued_by = _export_actor_from_verifier(verifier)
        kiosk_actor = _audit_actor()
        _audit_event(
            action="Approval verification",
            outcome="success",
            entity_type="verification",
            entity_name=purpose,
            details=_format_verification_token_issued_audit_details(
                verifier, purpose, method, issuer_in_details=False
            ),
            target_user=vname,
            signature={"mode": method, "username": vname, "role": verifier_role},
            actor_user=vname,
            actor_role=verifier_role,
            extra={
                "purpose": purpose,
                "method": method,
                "verificationTokenIssuedBy": issued_by,
                "requestedBy": {
                    "username": kiosk_actor.get("user"),
                    "role": kiosk_actor.get("role"),
                },
            },
        )"""

    if old_verify in text:
        text = text.replace(old_verify, new_verify, 1)
        changed = True

    old_log = """def _log_usb_export_audit(cur, verifier, action: str, detail: str) -> None:
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
    )"""

    new_log = """def _log_usb_export_audit(cur, verifier, action: str, detail: str) -> None:
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
    )"""

    if old_log in text:
        text = text.replace(old_log, new_log, 1)
        changed = True

    if "_audit_entry_display_identity" not in text:
        old_prep = """def _prepare_audit_entries_for_display(entries):
    out = []
    for entry in entries or []:
        if _audit_entry_should_omit(entry):
            continue
        row = dict(entry)
        row["role"] = _display_role_label(row.get("role"))
        row["details"] = _humanize_audit_details(row.get("action"), row.get("details"), row)
        out.append(row)
    return out"""
        new_prep = """def _audit_entry_display_identity(entry: dict) -> dict:
    row = dict(entry or {})
    action = str(row.get("action") or "").strip()
    sig_user = str(row.get("signatureUser") or "").strip()
    stored_user = str(row.get("user") or "--").strip() or "--"
    attributed_username = stored_user
    attributed_role = row.get("role")
    if action in _ACTIONS_ATTRIBUTED_TO_SIGNATURE_USER and sig_user:
        attributed_username = sig_user
        attributed_role = row.get("signatureRole") or attributed_role
    member = None
    if attributed_username and attributed_username != "--":
        member = data_service.get_member_by_username(attributed_username)
    display_name = str((member or {}).get("name") or attributed_username or "--").strip() or "--"
    row["userId"] = attributed_username
    row["user"] = display_name
    row["role"] = _display_role_label(attributed_role)
    return row


def _prepare_audit_entries_for_display(entries):
    out = []
    for entry in entries or []:
        if _audit_entry_should_omit(entry):
            continue
        row = _audit_entry_display_identity(entry)
        row["details"] = _humanize_audit_details(row.get("action"), row.get("details"), row)
        out.append(row)
    return out"""
        if old_prep in text:
            text = text.replace(old_prep, new_prep, 1)
            changed = True

    # PDF export: User ID column
    if '<td>{usr}</td>"\n                "<td>{rol}</td>"' in text:
        text = text.replace(
            '<td>{usr}</td>"\n                "<td>{rol}</td>"',
            '<td>{usr}</td>"\n                "<td>{uid}</td>"\n                "<td>{rol}</td>"',
            1,
        )
        text = text.replace(
            'usr=usr, rol=rol, act=act, out=outcome, det=det',
            'usr=usr, uid=uid, rol=rol, act=act, out=outcome, det=det',
            1,
        )
        text = text.replace(
            'usr = _html_escape(e.get("user") or "--")\n            rol = _html_escape(e.get("role") or "--")',
            'usr = _html_escape(e.get("user") or "--")\n            uid = _html_escape(e.get("userId") or e.get("user") or "--")\n            rol = _html_escape(e.get("role") or "--")',
            1,
        )
        text = text.replace(
            "'    <th>User</th>'\n        '    <th>Role</th>'",
            "'    <th>User</th>'\n        '    <th>User ID</th>'\n        '    <th>Role</th>'",
            1,
        )
        text = text.replace(
            "colspan=\"7\" class=\"empty\">No audit entries",
            "colspan=\"8\" class=\"empty\">No audit entries",
            1,
        )
        changed = True

    if not changed:
        print("No changes (already patched?)")
        return 0
    APP.write_text(text, encoding="utf-8")
    print("Patched", APP)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
