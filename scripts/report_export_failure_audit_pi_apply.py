#!/usr/bin/env python3
"""Full Pi patch: audit failed USB report exports (helpers + export routes)."""

from __future__ import annotations

import pathlib
import sys

APP = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "/opt/kiosk/app.py")

# Import helper patch
import importlib.util

spec = importlib.util.spec_from_file_location(
    "helper_patch",
    pathlib.Path(__file__).with_name("report_export_failure_audit_patch.py"),
)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)  # type: ignore


def main() -> int:
    helper.main()
    text = APP.read_text(encoding="utf-8")

    # --- export_reports_stream: pre-gen gate ---
    old = """    if not report_ids:
        return jsonify({"success": False, "error": "No report IDs provided"}), 400
    device_path = (data.get("device_path") or "").strip() or None
    requested_export_path = (data.get("export_path") or "").strip() or None
    pdf_html_by_id_raw = data.get("pdf_html_by_id") or {}
    if isinstance(pdf_html_by_id_raw, dict):
        pdf_html_by_id = {str(k): v for k, v in pdf_html_by_id_raw.items() if isinstance(v, str) and v.strip()}
    else:
        pdf_html_by_id = {}
    power_off = bool(data.get("power_off") or False)

    gate, verifier = _require_export_usb_and_verification_json()
    if gate is not None:
        return gate
    cur = data_service.get_current_user()
    for rid in report_ids:
        blocked = _check_report_approved_for_print_export(report_id=rid)
        if blocked is not None:
            return blocked

    def _emit(obj):
        return (json.dumps(obj, ensure_ascii=False) + "\\n").encode("utf-8")

    def gen():
        total = len(report_ids)"""

    new = """    if not report_ids:
        _log_reports_export_failure(data_service.get_current_user(), None, "No report IDs provided", report_ids=[])
        return jsonify({"success": False, "error": "No report IDs provided"}), 400
    device_path = (data.get("device_path") or "").strip() or None
    requested_export_path = (data.get("export_path") or "").strip() or None
    pdf_html_by_id_raw = data.get("pdf_html_by_id") or {}
    if isinstance(pdf_html_by_id_raw, dict):
        pdf_html_by_id = {str(k): v for k, v in pdf_html_by_id_raw.items() if isinstance(v, str) and v.strip()}
    else:
        pdf_html_by_id = {}
    power_off = bool(data.get("power_off") or False)

    gate, verifier = _require_export_usb_and_verification_json()
    cur = data_service.get_current_user()
    if gate is not None:
        _log_reports_export_failure(
            cur,
            verifier,
            _audit_error_from_response(gate[0]) or "Export approval or permission denied",
            report_ids=report_ids,
        )
        return gate
    for rid in report_ids:
        blocked = _check_report_approved_for_print_export(report_id=rid)
        if blocked is not None:
            _log_reports_export_failure(
                cur,
                verifier,
                _audit_error_from_response(blocked[0]) or "Report must be approved before export",
                report_ids=report_ids,
            )
            return blocked

    def _emit(obj):
        return (json.dumps(obj, ensure_ascii=False) + "\\n").encode("utf-8")

    def gen():
        audit_logged = False

        def _audit_stream_failure(reason, extra=None):
            nonlocal audit_logged
            if audit_logged:
                return
            audit_logged = True
            _log_reports_export_failure(cur, verifier, reason, report_ids=report_ids, extra=extra)

        def _audit_stream_finish():
            nonlocal audit_logged
            if audit_logged:
                return
            audit_logged = True
            failed = result.get("failed") or []
            ok_count = int(result.get("count") or 0)
            if ok_count > 0 and not failed:
                detail = "Exported {} report{} to USB (stream)".format(
                    ok_count, "" if ok_count == 1 else "s"
                )
                _log_usb_export_audit(cur, verifier, "Reports exported", detail)
                return
            fail_detail = "Exported {} of {} report(s) (stream)".format(ok_count, total)
            if failed:
                fail_detail = "{} | failures: {}".format(fail_detail, failed)
            _log_reports_export_failure(cur, verifier, fail_detail, report_ids=report_ids, extra={"failed": failed})

        total = len(report_ids)"""

    if old in text:
        text = text.replace(old, new, 1)
    else:
        print("stream header block not found", file=sys.stderr)

    old_err = """            if err == "MULTIPLE_PENDRIVES":
                yield _emit({"event": "error", "code": "MULTIPLE_PENDRIVES",
                             "message": "Multiple pendrives detected. Choose one.",
                             "devices": devices})
                return
            if err:
                yield _emit({"event": "error", "message": _friendly_export_error(err), "devices": devices})
                return"""
    new_err = """            if err == "MULTIPLE_PENDRIVES":
                _audit_stream_failure("Multiple pendrives detected. Choose one.")
                yield _emit({"event": "error", "code": "MULTIPLE_PENDRIVES",
                             "message": "Multiple pendrives detected. Choose one.",
                             "devices": devices})
                return
            if err:
                _audit_stream_failure(_friendly_export_error(err))
                yield _emit({"event": "error", "message": _friendly_export_error(err), "devices": devices})
                return"""
    text = text.replace(old_err, new_err, 1)

    old_mk = """            except OSError as oe:
                yield _emit({"event": "error", "message": _friendly_export_error(oe)})
                return

            for i, rid in enumerate(report_ids, start=1):"""
    new_mk = """            except OSError as oe:
                _audit_stream_failure(_friendly_export_error(oe))
                yield _emit({"event": "error", "message": _friendly_export_error(oe)})
                return

            for i, rid in enumerate(report_ids, start=1):"""
    text = text.replace(old_mk, new_mk, 1)

    old_done = """            ok_count = result["count"]
            detail = "Exported {} report{} to USB (stream)".format(
                ok_count, "" if ok_count == 1 else "s"
            )
            _log_usb_export_audit(cur, verifier, "Reports exported", detail)

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
                pass"""
    new_done = """            _audit_stream_finish()

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
            _audit_stream_failure(_friendly_export_error(e))
            try:
                yield _emit({"event": "error", "message": _friendly_export_error(e)})
            except Exception:
                pass"""
    text = text.replace(old_done, new_done, 1)

    # --- export_reports (non-stream) ---
    old_er = """        if not report_ids:
            return jsonify({"success": False, "error": "No report IDs provided"}), 400
        gate, verifier = _require_export_usb_and_verification_json()
        if gate is not None:
            return gate
        cur = data_service.get_current_user()"""
    new_er = """        if not report_ids:
            cur = data_service.get_current_user()
            _log_reports_export_failure(cur, None, "No report IDs provided", report_ids=[])
            return jsonify({"success": False, "error": "No report IDs provided"}), 400
        gate, verifier = _require_export_usb_and_verification_json()
        cur = data_service.get_current_user()
        if gate is not None:
            _log_reports_export_failure(
                cur,
                verifier,
                _audit_error_from_response(gate[0]) or "Export approval or permission denied",
                report_ids=report_ids,
            )
            return gate"""
    text = text.replace(old_er, new_er, 1)

    old_miss = """        if missing:
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
                return blocked"""
    new_miss = """        if missing:
            err_msg = (
                "PDF unavailable for report(s): {}. Approve the report first, "
                "or ensure aborted reports were saved correctly."
            ).format(", ".join(str(i) for i in missing))
            _log_reports_export_failure(cur, verifier, err_msg, report_ids=report_ids, extra={"missing_pdfs": missing})
            return jsonify({
                "success": False,
                "error": err_msg,
                "missing_pdfs": missing,
            }), 400

        export_dir, err, devices, mounted_now = _resolve_export_destination(device_path, requested_export_path)
        if err == "MULTIPLE_PENDRIVES":
            _log_reports_export_failure(
                cur, verifier, "Multiple pendrives detected. Choose one.", report_ids=report_ids
            )
            return jsonify({"success": False, "error": "Multiple pendrives detected. Choose one.", "devices": devices, "code": "MULTIPLE_PENDRIVES"}), 409
        if err:
            _log_reports_export_failure(cur, verifier, str(err), report_ids=report_ids)
            return jsonify({"success": False, "error": err, "devices": devices}), 400

        for rid in report_ids:
            blocked = _check_report_approved_for_print_export(report_id=rid)
            if blocked is not None:
                _log_reports_export_failure(
                    cur,
                    verifier,
                    _audit_error_from_response(blocked[0]) or "Report must be approved before export",
                    report_ids=report_ids,
                )
                return blocked"""
    text = text.replace(old_miss, new_miss, 1)

    old_fin = """        ok_count = len(exported_files)
        ids_label = ", ".join(str(i) for i in report_ids[:ok_count]) if ok_count else ""
        detail = "Exported {} report{} to USB".format(ok_count, "" if ok_count == 1 else "s")
        if ids_label:
            detail = "{} (ids: {})".format(detail, ids_label)
        _log_usb_export_audit(cur, verifier, "Reports exported", detail)
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
        return jsonify({"success": False, "error": _friendly_export_error(e)}), 500"""
    new_fin = """        ok_count = len(exported_files)
        if failed or ok_count == 0:
            fail_detail = "Exported {} of {} report(s); failures: {}".format(
                ok_count, len(report_ids), failed or "none copied"
            )
            _log_reports_export_failure(cur, verifier, fail_detail, report_ids=report_ids, extra={"failed": failed})
        else:
            ids_label = ", ".join(str(i) for i in report_ids[:ok_count])
            detail = "Exported {} report{} to USB".format(ok_count, "" if ok_count == 1 else "s")
            if ids_label:
                detail = "{} (ids: {})".format(detail, ids_label)
            _log_usb_export_audit(cur, verifier, "Reports exported", detail)
        return jsonify({
            "success": (len(failed) == 0 and ok_count > 0),
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
        try:
            _log_reports_export_failure(
                cur or data_service.get_current_user(),
                verifier,
                _friendly_export_error(e),
                report_ids=report_ids,
            )
        except Exception:
            pass
        return jsonify({"success": False, "error": _friendly_export_error(e)}), 500"""
    text = text.replace(old_fin, new_fin, 1)

    # Fix export_reports try init
    if "report_ids = []\n    cur = None" not in text:
        text = text.replace(
            "    mounted_now = None\n    try:\n        data = request.get_json(force=True, silent=True) or {}",
            "    mounted_now = None\n    report_ids = []\n    cur = None\n    verifier = None\n    try:\n        data = request.get_json(force=True, silent=True) or {}",
            1,
        )

    APP.write_text(text, encoding="utf-8")
    print("Applied export route patches to", APP)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
