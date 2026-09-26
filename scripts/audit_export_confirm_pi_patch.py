#!/usr/bin/env python3
"""Add audit USB export staging + /api/audit/export/confirm on Leak Test kiosk (Pi)."""

from __future__ import annotations

import pathlib
import sys

APP = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "/opt/kiosk/app.py")
AUDIT = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 else "/opt/kiosk/audit_service.py")

AUDIT_CONSTANT = "AUDIT_LOG_CAP = 5000"
AUDIT_CONSTANT_NEW = """AUDIT_LOG_CAP = 5000
AUDIT_EXPORT_RETENTION_MS = 24 * 60 * 60 * 1000"""

AUDIT_BLOCK_MARKER = "def stage_audit_export_pending("
AUDIT_INSERT_BEFORE = "def clear_all_entries() -> int:"

AUDIT_SCHEDULE_BLOCK = '''

def _audit_export_schedule_path() -> Optional[pathlib.Path]:
    if not _storage_dir:
        return None
    return _storage_dir / "audit_export_schedule.json"


def _load_audit_export_schedule() -> Dict[str, Any]:
    path = _audit_export_schedule_path()
    if not path or not path.is_file():
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _save_audit_export_schedule(data: Dict[str, Any]) -> None:
    path = _audit_export_schedule_path()
    if not path:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def clear_audit_export_schedule() -> None:
    """Remove pending audit export purge schedule (factory reset)."""
    path = _audit_export_schedule_path()
    if path and path.exists():
        try:
            path.unlink()
        except Exception:
            pass


def stage_audit_export_pending(
    *,
    export_id: str,
    entry_ids: List[Any],
    exported_by: Dict[str, Any],
    approved_by: Dict[str, Any],
    pdf_path: str = "",
) -> None:
    """Store a successful USB audit export awaiting operator verification (no purge yet)."""
    now_ms = int(time.time() * 1000)
    ids = []
    for x in entry_ids or []:
        try:
            n = int(x)
            if n > 0:
                ids.append(n)
        except (TypeError, ValueError):
            s = str(x).strip()
            if s:
                ids.append(s)
    state = _load_audit_export_schedule()
    state["staged"] = {
        "export_id": str(export_id or "").strip(),
        "entry_ids": ids,
        "exported_by": dict(exported_by or {}),
        "approved_by": dict(approved_by or {}),
        "exported_at_ms": now_ms,
        "pdf_path": str(pdf_path or "").strip(),
    }
    _save_audit_export_schedule(state)


def confirm_audit_export_verified(export_id: str) -> Optional[Dict[str, Any]]:
    """Operator confirmed USB PDF OK: schedule purge in 24h."""
    want = str(export_id or "").strip()
    if not want:
        return None
    state = _load_audit_export_schedule()
    staged = state.get("staged") if isinstance(state.get("staged"), dict) else {}
    if str(staged.get("export_id") or "").strip() != want:
        return None
    now_ms = int(time.time() * 1000)
    scheduled = {
        "export_id": want,
        "entry_ids": list(staged.get("entry_ids") or []),
        "exported_by": dict(staged.get("exported_by") or {}),
        "approved_by": dict(staged.get("approved_by") or {}),
        "exported_at_ms": int(staged.get("exported_at_ms") or now_ms),
        "pdf_path": str(staged.get("pdf_path") or "").strip(),
        "confirmed_at_ms": now_ms,
        "purge_at_ms": now_ms + AUDIT_EXPORT_RETENTION_MS,
    }
    state["scheduled"] = scheduled
    state.pop("staged", None)
    _save_audit_export_schedule(state)
    return scheduled


def delete_entries_by_ids(entry_ids: List[Any]) -> int:
    """Delete audit rows with matching primary keys only."""
    if not entry_ids or not _audit_db_path or not _audit_db_path.exists():
        return 0
    ids = []
    for eid in entry_ids:
        if eid is None:
            continue
        s = str(eid).strip()
        if s:
            ids.append(s)
    if not ids:
        return 0
    conn = _db_connect()
    if not conn:
        return 0
    try:
        removed = 0
        chunk_size = 400
        for i in range(0, len(ids), chunk_size):
            chunk = ids[i : i + chunk_size]
            placeholders = ",".join("?" for _ in chunk)
            cur = conn.execute(
                "DELETE FROM audit_entries WHERE id IN ({})".format(placeholders),
                tuple(chunk),
            )
            conn.commit()
            if cur.rowcount is not None and cur.rowcount >= 0:
                removed += int(cur.rowcount)
        try:
            conn.execute("VACUUM")
            conn.commit()
        except Exception:
            pass
        return removed
    except Exception:
        return 0
    finally:
        conn.close()


def run_due_audit_export_purge() -> Optional[Dict[str, Any]]:
    """If a confirmed audit export purge is due, delete only its entry_ids."""
    state = _load_audit_export_schedule()
    scheduled = state.get("scheduled") if isinstance(state.get("scheduled"), dict) else {}
    purge_at = scheduled.get("purge_at_ms")
    if purge_at is None:
        return None
    try:
        purge_at_ms = int(purge_at)
    except (TypeError, ValueError):
        return None
    now_ms = int(time.time() * 1000)
    if now_ms < purge_at_ms:
        return None
    entry_ids = list(scheduled.get("entry_ids") or [])
    delete_entries_by_ids(entry_ids)
    state.pop("scheduled", None)
    _save_audit_export_schedule(state)
    out = dict(scheduled)
    out["purged_at_ms"] = now_ms
    out["rows_removed"] = len(entry_ids)
    return out


'''

CLEAR_ALL_OLD = '''def clear_all_entries() -> int:
    """Delete the entire audit trail (DB + legacy/export files). Used by factory reset."""
    before = entry_count()'''

CLEAR_ALL_NEW = '''def clear_all_entries() -> int:
    """Delete the entire audit trail (DB + legacy/export files). Used by factory reset."""
    clear_audit_export_schedule()
    before = entry_count()'''

STAGE_AUDIT_FN = '''

def _stage_audit_usb_export(cur, verifier, entry_ids, pdf_path=""):
    ids = []
    for eid in entry_ids or []:
        if eid is None:
            continue
        if isinstance(eid, str):
            s = eid.strip()
            if s:
                ids.append(s)
            continue
        try:
            n = int(eid)
            if n > 0:
                ids.append(str(n))
        except (TypeError, ValueError):
            s = str(eid).strip()
            if s:
                ids.append(s)
    if not ids:
        return None, None, None
    export_id = secrets.token_urlsafe(16)
    exported_by = _export_actor_snapshot(cur or {})
    approved_by = _export_actor_from_verifier(verifier) if verifier else dict(exported_by)
    audit_service.stage_audit_export_pending(
        export_id=export_id,
        entry_ids=ids,
        exported_by=exported_by,
        approved_by=approved_by,
        pdf_path=str(pdf_path or ""),
    )
    return export_id, exported_by, approved_by


def _maybe_purge_scheduled_audit_export() -> None:
    try:
        purged = audit_service.run_due_audit_export_purge()
    except Exception:
        app.logger.exception("Audit export purge check failed")
        return
    if not purged:
        return
    exported = purged.get("exported_by") if isinstance(purged.get("exported_by"), dict) else {}
    approved = purged.get("approved_by") if isinstance(purged.get("approved_by"), dict) else {}
    details = (
        "Audit cycle started | Exported by: {} ({}) | Approved by: {} ({})"
    ).format(
        exported.get("username") or "--",
        exported.get("employee_id") or "--",
        approved.get("username") or "--",
        approved.get("employee_id") or "--",
    )
    _audit(None, None, "Audit cycle started", details)


'''

EXPORT_TAIL_OLD = '''        _log_export_completed_audit(
            cur,
            verifier,
            "Audit trail",
            "pdf {} | entries {}".format(out_path, len(entries)),
        )
        return jsonify({
            "success": True,
            "path": str(out_path),
            "export_directory": str(export_dir),
            "format": "pdf",
            "entries": len(entries),
            "unmount_detail": unmount_detail,
        }), 200'''

EXPORT_TAIL_NEW = '''        entry_ids = []
        for e in entries or []:
            if isinstance(e, dict) and e.get("id") is not None:
                entry_ids.append(e.get("id"))
        export_id, exported_by, approved_by = _stage_audit_usb_export(
            cur, verifier, entry_ids, pdf_path=str(out_path)
        )
        _log_export_completed_audit(
            cur,
            verifier,
            "Audit trail",
            "pdf {} | entries {}".format(out_path, len(entries)),
        )
        return jsonify({
            "success": True,
            "path": str(out_path),
            "export_directory": str(export_dir),
            "format": "pdf",
            "entries": len(entries),
            "unmount_detail": unmount_detail,
            "export_id": export_id,
            "entries_staged": len(entry_ids) if export_id else 0,
            "retentionNote": "After you verify the USB copy, exported audit rows are purged from this device after 24 hours.",
        }), 200'''

CONFIRM_ROUTE = '''

@app.route("/api/audit/export/confirm", methods=["POST"])
def confirm_audit_export():
    """Operator confirmed USB audit export; starts 24h retention timer."""
    try:
        _maybe_purge_scheduled_audit_export()
        cur = data_service.get_current_user()
        if not cur:
            return jsonify({"success": False, "error": "Unauthorized"}), 401
        if not _session_has_internal("export-usb"):
            return jsonify({"success": False, "error": "Forbidden."}), 403
        data = request.get_json(force=True, silent=True) or {}
        export_id = (data.get("export_id") or "").strip()
        verified = bool(data.get("verified"))
        if not verified:
            return jsonify({"success": True, "verified": False, "scheduled": False}), 200
        if not export_id:
            return jsonify({"success": False, "error": "Missing export_id"}), 400
        scheduled = audit_service.confirm_audit_export_verified(export_id)
        if not scheduled:
            return jsonify({"success": False, "error": "Export session expired or invalid. Export again."}), 400
        _audit(
            cur.get("username") or cur.get("name"),
            cur.get("role"),
            "Audit export verified",
            "USB export verified; {} entries scheduled for removal after 24 hours".format(
                len(scheduled.get("entry_ids") or [])
            ),
        )
        return jsonify({
            "success": True,
            "verified": True,
            "scheduled": True,
            "purge_at_ms": int(scheduled.get("purge_at_ms") or 0),
            "entries_scheduled": len(scheduled.get("entry_ids") or []),
        }), 200
    except Exception as e:
        app.logger.exception("Error confirming audit export")
        return jsonify({"success": False, "error": str(e)}), 500


'''

STAGE_INSERT_BEFORE = "def _audit_error_from_response(resp) -> str:"
ROUTE_INSERT_BEFORE = "# =================== CALCULATE =========================="


def patch_audit_service(text: str) -> str:
    if AUDIT_BLOCK_MARKER in text:
        print("audit_service: schedule block already present")
    else:
        if "AUDIT_EXPORT_RETENTION_MS" not in text:
            if AUDIT_CONSTANT not in text:
                raise SystemExit("audit_service: missing AUDIT_LOG_CAP anchor")
            text = text.replace(AUDIT_CONSTANT, AUDIT_CONSTANT_NEW, 1)
        idx = text.find(AUDIT_INSERT_BEFORE)
        if idx < 0:
            raise SystemExit("audit_service: missing clear_all_entries")
        text = text[:idx] + AUDIT_SCHEDULE_BLOCK + text[idx:]
    if CLEAR_ALL_NEW.split("\n")[1] not in text:
        if CLEAR_ALL_OLD not in text:
            raise SystemExit("audit_service: could not patch clear_all_entries")
        text = text.replace(CLEAR_ALL_OLD, CLEAR_ALL_NEW, 1)
    return text


def patch_app(text: str) -> str:
    if "def _stage_audit_usb_export" not in text:
        anchor = STAGE_INSERT_BEFORE
        pos = text.find(anchor)
        if pos < 0:
            raise SystemExit("app: missing _audit_error_from_response anchor")
        text = text[:pos] + STAGE_AUDIT_FN + text[pos:]
    if EXPORT_TAIL_OLD in text:
        text = text.replace(EXPORT_TAIL_OLD, EXPORT_TAIL_NEW, 1)
    elif '"export_id": export_id' in text:
        print("app: export_audit_trails already returns export_id")
    else:
        raise SystemExit("app: could not patch export_audit_trails return")
    if '"/api/audit/export/confirm"' not in text:
        before = ROUTE_INSERT_BEFORE
        if before not in text:
            raise SystemExit("app: missing CALCULATE section anchor")
        text = text.replace(before, CONFIRM_ROUTE + before, 1)
    else:
        print("app: confirm route already present")
    return text


def main() -> int:
    audit_text = AUDIT.read_text(encoding="utf-8")
    audit_text = patch_audit_service(audit_text)
    AUDIT.write_text(audit_text, encoding="utf-8")
    print("Patched", AUDIT)

    app_text = APP.read_text(encoding="utf-8")
    app_text = patch_app(app_text)
    APP.write_text(app_text, encoding="utf-8")
    print("Patched", APP)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
