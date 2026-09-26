#!/usr/bin/env python3
"""Patch Leak Test app.py: log and display who issued approval verification tokens."""

from __future__ import annotations

import pathlib
import sys

APP = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "/opt/kiosk/app.py")

HELPER_BLOCK = '''

def _format_verification_token_issued_audit_details(verifier: dict, purpose: str, method: str) -> str:
    """Human-readable audit text: who issued the short-lived approval verification token."""
    actor = _export_actor_from_verifier(verifier)
    username = str(actor.get("username") or "--").strip() or "--"
    employee_id = str(actor.get("employee_id") or username).strip() or username
    purpose_text = str(purpose or "").strip().lower().replace("_", " ") or "approval"
    detail = "Verification token issued by {} ({}) for {}".format(username, employee_id, purpose_text)
    method_text = str(method or "").strip().lower()
    if method_text and method_text not in ("credentials",):
        detail = "{} | method: {}".format(detail, method_text)
    return detail


def _enrich_approval_verification_audit_details(details: str, entry: dict) -> str:
    """Ensure token-issue rows name the verifier (fixes legacy rows that only stored signatureUser)."""
    text = str(details or "").strip()
    if not text:
        return text
    lowered = text.lower()
    if "verification token issued" not in lowered:
        return text
    if " issued by " in lowered:
        return text
    issuer = str((entry or {}).get("signatureUser") or (entry or {}).get("targetUser") or "").strip()
    extra = (entry or {}).get("extra")
    if not issuer and isinstance(extra, dict):
        issued = extra.get("verificationTokenIssuedBy") or extra.get("exportApprovedBy")
        if isinstance(issued, dict):
            issuer = str(issued.get("username") or "").strip()
    if not issuer:
        return text
    employee_id = _resolve_employee_id(issuer)
    purpose = str((entry or {}).get("entityName") or "").strip().lower().replace("_", " ")
    if not purpose and isinstance(extra, dict):
        purpose = str(extra.get("purpose") or "").strip().lower().replace("_", " ")
    purpose_part = " for {}".format(purpose) if purpose else ""
    return "Verification token issued by {} ({}){}".format(issuer, employee_id, purpose_part)
'''

OLD_AUDIT_EVENT = '''        vname = verifier.get("username") or username
        _audit_event(
            action="Approval verification",
            outcome="success",
            entity_type="verification",
            entity_name=purpose,
            details="Verification token issued",
            target_user=vname,
            signature={"mode": method, "username": vname, "role": verifier_role},
            extra={"purpose": purpose, "method": method},
        )'''

NEW_AUDIT_EVENT = '''        vname = verifier.get("username") or username
        issued_by = _export_actor_from_verifier(verifier)
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
        )'''

OLD_HUMANIZE_SIG = "def _humanize_audit_details(action: str, details: str) -> str:"
NEW_HUMANIZE_SIG = "def _humanize_audit_details(action: str, details: str, entry: dict = None) -> str:"

OLD_HUMANIZE_HEAD = """    details = audit_service._details_audit_display(details)
    if not details:
        return details
    if action == "Power interruption":"""

NEW_HUMANIZE_HEAD = """    details = audit_service._details_audit_display(details)
    if not details:
        return details
    if action == "Approval verification":
        return _enrich_approval_verification_audit_details(details, entry or {})
    if action == "Power interruption":"""

OLD_PREPARE = '        row["details"] = _humanize_audit_details(row.get("action"), row.get("details"))'
NEW_PREPARE = '        row["details"] = _humanize_audit_details(row.get("action"), row.get("details"), row)'

MARKER = "def _format_export_actors_detail"


def main() -> int:
    text = APP.read_text(encoding="utf-8")
    changed = False
    if "_format_verification_token_issued_audit_details" not in text:
        if MARKER not in text:
            print("Could not find insertion point", MARKER, file=sys.stderr)
            return 1
        text = text.replace(MARKER, HELPER_BLOCK.strip() + "\n\n\n" + MARKER, 1)
        changed = True
    if OLD_AUDIT_EVENT in text:
        text = text.replace(OLD_AUDIT_EVENT, NEW_AUDIT_EVENT, 1)
        changed = True
    if OLD_HUMANIZE_SIG in text:
        text = text.replace(OLD_HUMANIZE_SIG, NEW_HUMANIZE_SIG, 1)
        changed = True
    if OLD_HUMANIZE_HEAD in text:
        text = text.replace(OLD_HUMANIZE_HEAD, NEW_HUMANIZE_HEAD, 1)
        changed = True
    if OLD_PREPARE in text:
        text = text.replace(OLD_PREPARE, NEW_PREPARE, 1)
        changed = True
    if not changed:
        print("No changes applied (already patched?)")
        return 0
    APP.write_text(text, encoding="utf-8")
    print("Patched", APP)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
