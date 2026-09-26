#!/usr/bin/env python3
"""Log successful USB exports as action Export completed."""

from __future__ import annotations

import pathlib
import sys

APP = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "/opt/kiosk/app.py")

OLD_SET = '''_ACTIONS_ATTRIBUTED_TO_SIGNATURE_USER = frozenset(
    {"Approval verification", "Audit trail exported", "Reports exported"}
)'''

NEW_SET = '''_ACTIONS_ATTRIBUTED_TO_SIGNATURE_USER = frozenset(
    {
        "Approval verification",
        "Export completed",
        "Audit trail exported",
        "Reports exported",
    }
)


def _log_export_completed_audit(cur, verifier, export_kind: str, detail: str) -> None:
    kind = str(export_kind or "Export").strip() or "Export"
    body = str(detail or "").strip()
    prefix = "{} export completed".format(kind)
    if body.lower().startswith(prefix.lower()):
        audit_detail = body
    elif body:
        audit_detail = "{} | {}".format(prefix, body)
    else:
        audit_detail = prefix
    _log_usb_export_audit(cur, verifier, "Export completed", audit_detail, outcome="success")
'''

REPLACEMENTS = [
    (
        '_log_usb_export_audit(\n            cur,\n            verifier,\n            "Audit trail exported",',
        '_log_export_completed_audit(\n            cur,\n            verifier,\n            "Audit trail",',
    ),
    (
        '_log_usb_export_audit(cur, verifier, "Reports exported", detail)',
        '_log_export_completed_audit(cur, verifier, "Report", detail)',
    ),
    (
        '_log_usb_export_audit(cur, verifier, "Reports exported", audit_detail)',
        '_log_export_completed_audit(cur, verifier, "Report", audit_detail)',
    ),
]


def main() -> int:
    text = APP.read_text(encoding="utf-8")
    if "_log_export_completed_audit" not in text:
        if OLD_SET not in text:
            print("Could not find ACTIONS set", file=sys.stderr)
            return 1
        text = text.replace(OLD_SET, NEW_SET, 1)
    for old, new in REPLACEMENTS:
        if old in text:
            text = text.replace(old, new, 1)
    # humanize: add Export completed early return if missing
    needle = '    if action == "Reports exported":'
    insert = '    if action == "Export completed":\n        return details\n'
    if insert.strip() not in text and needle in text:
        text = text.replace(needle, insert + needle, 1)
    APP.write_text(text, encoding="utf-8")
    print("Patched", APP)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
