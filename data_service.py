#!/usr/bin/env python3
"""
data_service.py - Data storage and management service for Leak Test
Handles CRUD for recipes, reports, members, and factory settings.
All data stored as JSON files under STORAGE_DIR.
"""

import hashlib
import hmac
import json
import os
import pathlib
import secrets
import shutil
import tempfile
import threading
import time
from datetime import datetime, timedelta
from typing import Optional, Dict, List, Any

import rbac_service

_config = {}
_storage_dir = None
_reports_dir = None
_current_user = None
# Serialize session file writes; unique tmp names still protect all JSON files.
_session_save_lock = threading.Lock()
_json_write_locks_guard = threading.Lock()
_json_write_locks: Dict[str, threading.Lock] = {}

FACTORY_USERNAME = "RLERLT"
FACTORY_PASSWORD = "Rahul"
FACTORY_USER = {
    "id": 0,
    "name": "Factory",
    "username": FACTORY_USERNAME,
    "role": "Factory",
}

def _creation_password_pepper() -> str:
    return os.environ.get("KIOSK_PASSWORD_PEPPER", "leaktest-kiosk-default-pepper-v1")


def hash_creation_password(salt: str, password: str) -> str:
    """SHA-256 hex digest of pepper + salt + password (UTF-8). Used to detect reuse of admin-set initial password."""
    raw = f"{_creation_password_pepper()}:{salt}:{password}".encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def _set_creation_password_commitment(member: Dict[str, Any], password: str) -> None:
    salt = secrets.token_hex(16)
    member["creationPasswordSalt"] = salt
    member["creationPasswordHash"] = hash_creation_password(salt, password)


def _clear_creation_password_commitment(member: Dict[str, Any]) -> None:
    member.pop("creationPasswordSalt", None)
    member.pop("creationPasswordHash", None)
    member["mustChangePassword"] = False


def new_password_matches_creation_commitment(member: Dict[str, Any], new_password: str) -> bool:
    """True if new_password matches the stored admin-creation commitment (caller should reject)."""
    salt = str(member.get("creationPasswordSalt") or "")
    expected = str(member.get("creationPasswordHash") or "")
    if not salt or not expected:
        return False
    return hmac.compare_digest(hash_creation_password(salt, new_password), expected)


def sanitize_member_for_client(member: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Return a shallow copy safe for JSON responses (no password or creation commitment fields)."""
    if not member:
        return None
    safe = dict(member)
    safe.pop("password", None)
    safe.pop("creationPasswordSalt", None)
    safe.pop("creationPasswordHash", None)
    return safe


def complete_mandatory_password_reset(username: str, new_password: str) -> Dict[str, Any]:
    """Apply new password and clear mandatory-change flags after server-side checks elsewhere."""
    m = get_member_by_username(username)
    if not m:
        raise ValueError("Member not found")
    if str(m.get("username", "")).strip().upper() == FACTORY_USERNAME.upper():
        raise ValueError("The factory user cannot be modified.")
    if not bool(m.get("mustChangePassword")):
        raise ValueError("Password change is not required for this account")
    m["password"] = str(new_password or "")
    m["passwordLastChangedAt"] = datetime.utcnow().isoformat() + "Z"
    _clear_creation_password_commitment(m)
    _save_member_record(m)
    return m


def clear_mandatory_password_reset_flags(member_id: int) -> None:
    """Clear first-login mandatory flags after a successful password change (e.g. expiry reset)."""
    m = get_member(member_id)
    if not m:
        return
    if str(m.get("username", "")).strip().upper() == FACTORY_USERNAME.upper():
        return
    _clear_creation_password_commitment(m)
    _save_member_record(m)


PERMISSIONS_VERSION = rbac_service.PERMISSIONS_VERSION
FEATURE_CATALOG_KEYS = rbac_service.FEATURE_CATALOG_KEYS


def init(config):
    """Initialize data service with config."""
    global _config, _storage_dir, _reports_dir
    _config = dict(config)
    _refresh_storage_dir()
    _reports_dir = pathlib.Path(_config.get("REPORTS_DIR", "./reports"))
    _storage_dir.mkdir(parents=True, exist_ok=True)
    _reports_dir.mkdir(parents=True, exist_ok=True)


def _configured_storage_dir() -> Optional[pathlib.Path]:
    """Explicit STORAGE_DIR from env or init config (production internal USB)."""
    for raw in (
        os.environ.get("STORAGE_DIR"),
        (_config.get("STORAGE_DIR") if _config else None),
    ):
        if raw:
            return pathlib.Path(raw)
    return None


def _internal_usb_storage_dir() -> Optional[pathlib.Path]:
    internal = pathlib.Path(os.environ.get("INTERNAL_USB_PATH", "/media/usb_internal"))
    if internal.is_dir():
        return internal / "storage"
    return None


def _storage_dir_candidates() -> List[pathlib.Path]:
    """Storage roots when no explicit STORAGE_DIR is configured."""
    seen = set()
    out: List[pathlib.Path] = []

    def _add(p: pathlib.Path) -> None:
        try:
            key = str(p.resolve())
        except OSError:
            key = str(p)
        if key not in seen:
            seen.add(key)
            out.append(p)

    internal_storage = _internal_usb_storage_dir()
    if internal_storage is not None:
        _add(internal_storage)
    app_root = _config.get("APP_ROOT") if _config else None
    if app_root:
        _add(pathlib.Path(app_root) / "storage")
    if not out:
        _add(pathlib.Path("./storage"))
    return out


def _storage_dir_score(path: pathlib.Path) -> int:
    """Prefer a tree that already has persisted factory settings (fallback mode only)."""
    fs_file = path / "factorySettings.json"
    if not fs_file.is_file():
        return 0
    try:
        data = _load_json_file(fs_file, default={})
        if isinstance(data, dict) and data:
            return 2
    except Exception:
        pass
    return 1


def _path_is_writable(path: pathlib.Path) -> bool:
    """True if we can create the dir and write a probe file (USB remount-ro fails here)."""
    try:
        path.mkdir(parents=True, exist_ok=True)
        probe = path / ".kiosk_write_probe"
        with open(probe, "w", encoding="utf-8") as f:
            f.write("ok")
            f.flush()
            os.fsync(f.fileno())
        try:
            probe.unlink()
        except OSError:
            pass
        return True
    except OSError:
        return False


_CRITICAL_JSON_NAMES = frozenset(
    {
        "members.json",
        "recipes.json",
        "reports.json",
        "factorySettings.json",
        "roles.json",
        "current_user.json",
        "session_power_audit_pending.json",
    }
)


def _sd_storage_dir() -> pathlib.Path:
    app_root = None
    if _config:
        app_root = _config.get("APP_ROOT")
    if not app_root:
        app_root = os.environ.get("APP_ROOT", "/opt/kiosk")
    return pathlib.Path(app_root) / "storage"


def _json_richness_score(name: str, data, path: Optional[pathlib.Path] = None) -> int:
    """Higher = prefer this copy (survives empty SD placeholders after remount-ro fallback)."""
    if data is None:
        return -1
    score = 0
    if isinstance(data, list):
        score = len(data) * 100
        if name == "members.json":
            enrolled = 0
            for m in data:
                if not isinstance(m, dict):
                    continue
                if m.get("fingerprintTemplateId") not in (None, "", 0, "0"):
                    enrolled += 1
            score += enrolled * 10
    elif isinstance(data, dict):
        score = len(data) * 10
        if data:
            score += 5
    else:
        return 0
    if path is not None:
        try:
            score += min(50, int(path.stat().st_mtime) % 100000 // 2000)
        except OSError:
            pass
    return score


def _candidate_storage_dirs_for_read() -> List[pathlib.Path]:
    """USB (even if RO) + active storage + SD mirror — used to avoid empty fallback views."""
    seen = set()
    out: List[pathlib.Path] = []

    def _add(p: Optional[pathlib.Path]) -> None:
        if p is None:
            return
        try:
            key = str(p.resolve())
        except OSError:
            key = str(p)
        if key in seen:
            return
        seen.add(key)
        out.append(p)

    _add(_internal_usb_storage_dir())
    if _storage_dir is not None:
        _add(_storage_dir)
    _add(_sd_storage_dir())
    configured = _configured_storage_dir()
    _add(configured)
    return out


def _load_critical_json(name: str, default=None):
    """Load critical JSON from the richest readable copy (USB RO / USB RW / SD mirror)."""
    if default is None:
        default = []
    best = None
    best_score = -1
    for root in _candidate_storage_dirs_for_read():
        path = root / name
        if not path.is_file():
            continue
        data = _load_json_file(path, default=None)
        score = _json_richness_score(name, data, path)
        if score > best_score:
            best_score = score
            best = data
    if best is None:
        return default
    return best


def _mirror_critical_json(filepath: pathlib.Path, data) -> None:
    """Dual-write critical files to SD (and USB when available) so remount-ro cannot erase login data."""
    name = filepath.name
    if name not in _CRITICAL_JSON_NAMES:
        return
    usb = _internal_usb_storage_dir()
    sd = _sd_storage_dir()
    try:
        primary = filepath.resolve()
    except OSError:
        primary = filepath
    targets: List[pathlib.Path] = []
    try:
        if usb is not None and primary.parent.resolve() == usb.resolve():
            targets.append(sd / name)
        elif primary.parent.resolve() == sd.resolve():
            if usb is not None and _path_is_writable(usb):
                targets.append(usb / name)
        else:
            # Unexpected path — still keep an SD mirror.
            targets.append(sd / name)
            if usb is not None and _path_is_writable(usb):
                targets.append(usb / name)
    except OSError:
        targets.append(sd / name)

    for target in targets:
        try:
            if target.resolve() == primary:
                continue
        except OSError:
            if str(target) == str(filepath):
                continue
        try:
            _save_json_file_atomic(target, data)
        except Exception:
            pass


def _storage_file_needs_seed(path: pathlib.Path) -> bool:
    """True when dest is missing or is an empty JSON placeholder ([] / {})."""
    if not path.is_file():
        return True
    try:
        size = path.stat().st_size
    except OSError:
        return True
    if size <= 0:
        return True
    # "[]" / "{}" are 2 bytes — treat as empty so RO-USB seed is not skipped.
    if size <= 4:
        try:
            raw = path.read_text(encoding="utf-8").strip()
            if raw in ("", "[]", "{}", "null"):
                return True
        except OSError:
            return True
    try:
        data = _load_json_file(path, default=None)
        if data is None:
            return True
        if isinstance(data, list) and len(data) == 0:
            return True
        if isinstance(data, dict) and len(data) == 0:
            return True
    except Exception:
        return True
    return False


def _seed_storage_from_readonly_usb(dest: pathlib.Path) -> None:
    """If USB is readable but RO, copy critical JSON so login/recipes still work on SD."""
    usb_storage = _internal_usb_storage_dir()
    if usb_storage is None or not usb_storage.is_dir():
        return
    try:
        dest.mkdir(parents=True, exist_ok=True)
    except OSError:
        return
    for name in (
        "members.json",
        "factorySettings.json",
        "recipes.json",
        "roles.json",
        "reports.json",
    ):
        src = usb_storage / name
        dst = dest / name
        if not src.is_file():
            continue
        if not _storage_file_needs_seed(dst):
            # Still refresh when USB clearly has more members/recipes than empty-looking SD.
            try:
                if name in ("members.json", "recipes.json", "reports.json"):
                    src_data = _load_json_file(src, default=[])
                    dst_data = _load_json_file(dst, default=[])
                    if isinstance(src_data, list) and isinstance(dst_data, list):
                        if _json_richness_score(name, src_data, src) > _json_richness_score(name, dst_data, dst):
                            shutil.copy2(src, dst)
                continue
            except Exception:
                continue
        try:
            shutil.copy2(src, dst)
        except OSError:
            pass


def _refresh_storage_dir() -> None:
    """Re-resolve STORAGE_DIR; always prefer writable USB when present.

    After power-loss the launcher may start on SD fallback while USB is still RO.
    Once USB is repaired/writable again, switch back so members/recipes/reports return.
    """
    global _storage_dir
    usb = _internal_usb_storage_dir()
    sd_fallback = _sd_storage_dir()
    if usb is not None and _path_is_writable(usb):
        _storage_dir = usb
        return
    # USB absent or remount-ro — seed SD from readable USB so login/recipes are not empty.
    _seed_storage_from_readonly_usb(sd_fallback)
    configured = _configured_storage_dir()
    if configured is not None and _path_is_writable(configured):
        _storage_dir = configured
        return
    candidates = _storage_dir_candidates()
    writable = [p for p in candidates if _path_is_writable(p)]
    if writable:
        if len(writable) == 1:
            _storage_dir = writable[0]
        else:
            _storage_dir = max(writable, key=_storage_dir_score)
        return
    _storage_dir = sd_fallback


def _get_storage_path(filename: str) -> pathlib.Path:
    _refresh_storage_dir()
    safe_name = "".join(c for c in filename if c.isalnum() or c in "-_.")
    return _storage_dir / safe_name


def _json_write_lock_for(filepath: pathlib.Path) -> threading.Lock:
    key = str(filepath)
    with _json_write_locks_guard:
        lock = _json_write_locks.get(key)
        if lock is None:
            lock = threading.Lock()
            _json_write_locks[key] = lock
        return lock


def _load_json_file(filepath: pathlib.Path, default=None):
    if default is None:
        default = []
    if not filepath.exists():
        return default
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if data is not None else default
    except Exception:
        return default


def _save_json_file_atomic(filepath: pathlib.Path, data):
    """Atomic JSON write (no mirroring)."""
    filepath.parent.mkdir(parents=True, exist_ok=True)
    lock = _json_write_lock_for(filepath)
    with lock:
        fd = None
        tmp_path = None
        try:
            fd, tmp_path = tempfile.mkstemp(
                prefix=filepath.name + ".",
                suffix=".tmp",
                dir=str(filepath.parent),
            )
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                fd = None  # ownership transferred to the file object
                json.dump(data, f, indent=2, ensure_ascii=False)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp_path, filepath)
            tmp_path = None
            try:
                dir_fd = os.open(str(filepath.parent), os.O_RDONLY)
                try:
                    os.fsync(dir_fd)
                finally:
                    os.close(dir_fd)
            except OSError:
                pass
        except OSError:
            if fd is not None:
                try:
                    os.close(fd)
                except OSError:
                    pass
            if tmp_path:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass
            raise


def _save_json_file(filepath: pathlib.Path, data):
    """Atomic JSON write + dual-write critical files to SD/USB mirror."""
    _save_json_file_atomic(filepath, data)
    try:
        _mirror_critical_json(filepath, data)
    except Exception:
        pass


# =================== RECIPE OPERATIONS ==========================


def list_recipes(filter_type=None):
    """List all recipes, optionally filtered by type."""
    recipes = _load_critical_json("recipes.json", default=[])
    if not isinstance(recipes, list):
        recipes = []
    if filter_type:
        recipes = [r for r in recipes if r.get("type") == filter_type]
    return recipes


def get_recipe(recipe_id: int):
    """Get recipe by ID."""
    want = _norm_recipe_id(recipe_id)
    if want is None:
        return None
    recipes = list_recipes()
    for recipe in recipes:
        if _norm_recipe_id(recipe.get("id")) == want:
            return recipe
    return None


def _norm_recipe_id(recipe_id) -> Optional[int]:
    if recipe_id is None:
        return None
    try:
        n = int(recipe_id)
        return n if n > 0 else None
    except (TypeError, ValueError):
        return None


def save_recipe(recipe_data: Dict[str, Any]) -> int:
    """Save recipe (create or update). Enforces maxRecipes from factory settings."""
    recipes_path = _get_storage_path("recipes.json")
    recipes = list_recipes()
    recipe_id = _norm_recipe_id(recipe_data.get("id"))
    if recipe_id is not None:
        recipe_data["id"] = recipe_id
    is_update = recipe_id is not None and any(
        _norm_recipe_id(r.get("id")) == recipe_id for r in recipes
    )

    if not is_update:
        fs = get_factory_settings()
        max_recipes = int(fs.get("maxRecipes") or 150)
        if len(recipes) >= max_recipes:
            raise ValueError("Your limit for recipes reached. Contact support for upgrade.")

    if recipe_id and is_update:
        for i, r in enumerate(recipes):
            if r.get("id") == recipe_id:
                recipes[i] = recipe_data
                _save_json_file(recipes_path, recipes)
                return recipe_id

    if recipe_id and not is_update:
        recipe_data["id"] = recipe_id
        recipes.append(recipe_data)
    else:
        max_id = max([r.get("id", 0) for r in recipes], default=0)
        recipe_id = max_id + 1
        recipe_data["id"] = recipe_id
        recipes.append(recipe_data)

    _save_json_file(recipes_path, recipes)
    return recipe_id


def delete_recipe(recipe_id: int) -> bool:
    """Delete recipe by ID."""
    recipes_path = _get_storage_path("recipes.json")
    recipes = list_recipes()
    original_len = len(recipes)
    recipes = [r for r in recipes if r.get("id") != recipe_id]
    if len(recipes) < original_len:
        _save_json_file(recipes_path, recipes)
        return True
    return False


# =================== REPORT OPERATIONS ==========================


def list_reports(filter_type="all"):
    """List reports, optionally filtered by type."""
    reports = _load_critical_json("reports.json", default=[])
    if not isinstance(reports, list):
        reports = []
    if filter_type and filter_type != "all":
        reports = [r for r in reports if r.get("type") == filter_type]

    def sort_key(r):
        ts = r.get("createdAt") or r.get("completedAt") or ""
        try:
            dt = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
            if dt.tzinfo is not None:
                dt = dt.astimezone().replace(tzinfo=None)
            return dt.timestamp()
        except Exception:
            return float("-inf")

    reports.sort(key=sort_key, reverse=True)
    return reports


def get_report(report_id: int):
    """Get report by ID."""
    reports = list_reports()
    for report in reports:
        if report.get("id") == report_id:
            return report
    return None


def save_report(report_data: Dict[str, Any]) -> int:
    """Save report (create or update)."""
    reports_path = _get_storage_path("reports.json")
    reports = list_reports("all")
    report_id = report_data.get("id")
    if not report_id:
        max_id = max([r.get("id", 0) for r in reports], default=0)
        report_id = max_id + 1
        report_data["id"] = report_id
    if not report_data.get("createdAt"):
        report_data["createdAt"] = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    found = False
    for i, r in enumerate(reports):
        if r.get("id") == report_id:
            reports[i] = report_data
            found = True
            break
    if not found:
        reports.append(report_data)
    _save_json_file(reports_path, reports)
    return report_id


def delete_report(report_id: int) -> bool:
    """Delete report by ID."""
    reports_path = _get_storage_path("reports.json")
    reports = list_reports("all")
    original_len = len(reports)
    reports = [r for r in reports if r.get("id") != report_id]
    if len(reports) < original_len:
        _save_json_file(reports_path, reports)
        return True
    return False


# =================== MEMBER OPERATIONS ==========================


def list_members():
    """List all members. Excludes hidden factory user. Normalizes status/failedAttempts."""
    members = _load_critical_json("members.json", default=[])
    if not isinstance(members, list):
        members = []

    normalized: List[Dict[str, Any]] = []
    for m in members:
        if str(m.get("username", "")).strip().upper() == FACTORY_USERNAME.upper():
            continue
        status = str(m.get("status") or "active").strip().lower()
        if status not in ("active", "locked", "disabled"):
            status = "active"
        m["status"] = status
        try:
            fa = int(m.get("failedAttempts") or 0)
        except (TypeError, ValueError):
            fa = 0
        if fa < 0:
            fa = 0
        m["failedAttempts"] = fa
        _normalize_member_biometric_fields(m)
        _normalize_member_feature_overrides(m)
        _normalize_member_password_fields(m)
        normalized.append(m)
    return normalized


def get_member(member_id: int):
    """Get member by ID."""
    members = list_members()
    for member in members:
        if member.get("id") == member_id:
            return member
    return None


def count_active_qa_members() -> int:
    """Count members with role QA and status active (not locked/disabled)."""
    members = list_members()
    n = 0
    for m in members:
        if str(m.get("role", "")).strip().lower() != "qa":
            continue
        if str(m.get("status", "active")).strip().lower() == "active":
            n += 1
    return n


def count_active_supervisor_members() -> int:
    """Count members with role Supervisor (Reviewer) and status active."""
    members = list_members()
    n = 0
    for m in members:
        if str(m.get("role", "")).strip().lower() != "supervisor":
            continue
        if str(m.get("status", "active")).strip().lower() == "active":
            n += 1
    return n


def _check_member_limits(members: List[Dict], member_data: Dict[str, Any], existing_member: Optional[Dict] = None):
    """Check factory limits for users, admins, reviewers, and QA. Raise ValueError if exceeded."""
    fs = get_factory_settings()
    max_users = int(fs.get("maxUsers") or 10)
    max_admins = int(fs.get("maxAdmins") or 2)
    max_supervisors = int(fs.get("maxSupervisors") or 3)
    max_qa = int(fs.get("maxQa") or 3)

    def count_role(ms: List, r: str) -> int:
        return sum(1 for m in ms if str(m.get("role", "")).strip().lower() == r)

    new_role = str(member_data.get("role", "User")).strip().lower()
    users = count_role(members, "user")
    admins = count_role(members, "admin")
    supervisors = count_role(members, "supervisor")
    qa = count_role(members, "qa")

    if existing_member:
        old_role = str(existing_member.get("role", "")).strip().lower()
        if old_role == "user":
            users -= 1
        elif old_role == "admin":
            admins -= 1
        elif old_role == "supervisor":
            supervisors -= 1
        elif old_role == "qa":
            qa -= 1

    if new_role == "user":
        users += 1
    elif new_role == "admin":
        admins += 1
    elif new_role == "supervisor":
        supervisors += 1
    elif new_role == "qa":
        qa += 1

    if users > max_users:
        raise ValueError("Your limit for users reached. Contact support for upgrade.")
    if admins > max_admins:
        raise ValueError("Your limit for admins reached. Contact support for upgrade.")
    if supervisors > max_supervisors:
        raise ValueError("Your limit for reviewers reached. Contact support for upgrade.")
    if qa > max_qa:
        raise ValueError("Your limit for QA profiles reached. Contact support for upgrade.")


def _member_username_key(member: Dict[str, Any]) -> str:
    return str(member.get("username", "")).strip().lower()


def _to_bool(v, default=True):
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return bool(v)
    if isinstance(v, str):
        t = v.strip().lower()
        if t in ("false", "0", "off", "no", "disabled"):
            return False
        if t in ("true", "1", "on", "yes", "enabled"):
            return True
    return bool(default)


def _normalize_member_biometric_fields(member: Dict[str, Any]) -> None:
    member["biometricEnabled"] = _to_bool(member.get("biometricEnabled", True), default=True)
    t = member.get("fingerprintTemplateId")
    if t is None or t == "":
        member["fingerprintTemplateId"] = None
    else:
        try:
            member["fingerprintTemplateId"] = int(t)
        except (TypeError, ValueError):
            member["fingerprintTemplateId"] = None
    if "biometricEnrolledAt" not in member:
        member["biometricEnrolledAt"] = None
    if "biometricEnrollmentStatus" not in member:
        member["biometricEnrollmentStatus"] = "not_enrolled"


def _normalize_member_feature_overrides(member: Dict[str, Any]) -> None:
    rbac_service.migrate_member_permissions_v1_to_v2(member)
    member["permissionsVersion"] = int(member.get("permissionsVersion") or PERMISSIONS_VERSION)
    raw = member.get("featureOverrides")
    if not isinstance(raw, dict):
        raw = {}
    allow_in = raw.get("allow")
    deny_in = raw.get("deny")
    allow = []
    deny = []
    if isinstance(allow_in, list):
        for item in allow_in:
            key = str(item or "").strip()
            if key and key in FEATURE_CATALOG_KEYS and key not in allow:
                allow.append(key)
    if isinstance(deny_in, list):
        for item in deny_in:
            key = str(item or "").strip()
            if key and key in FEATURE_CATALOG_KEYS and key not in deny:
                deny.append(key)
    # deny wins in allow/deny conflict
    allow = [k for k in allow if k not in deny]
    member["featureOverrides"] = {
        "allow": sorted(allow),
        "deny": sorted(deny),
    }


def _normalize_member_password_fields(member: Dict[str, Any]) -> None:
    """Normalize member password metadata used for expiry policy and mandatory first-change migration."""
    created_at = str(member.get("createdAt") or "").strip()
    if not created_at:
        created_at = datetime.utcnow().isoformat() + "Z"
        member["createdAt"] = created_at
    plc = str(member.get("passwordLastChangedAt") or "").strip()
    if not plc:
        member["passwordLastChangedAt"] = created_at

    # Legacy: members without mustChangePassword must reset on next login.
    if "mustChangePassword" not in member:
        member["mustChangePassword"] = True
    pwd0 = str(member.get("password") or "")
    if bool(member.get("mustChangePassword")) and pwd0:
        if not member.get("creationPasswordSalt") or not member.get("creationPasswordHash"):
            _set_creation_password_commitment(member, pwd0)


def _parse_isoish_datetime(value: Any) -> Optional[datetime]:
    s = str(value or "").strip()
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        # Normalize to naive datetime for safe comparisons with local-naive policy dates.
        if dt.tzinfo is not None:
            dt = dt.replace(tzinfo=None)
        return dt
    except Exception:
        return None


def _parse_installation_date(value: Any) -> Optional[datetime]:
    """Parse installation date from yyyy-mm-dd or dd-mm-yyyy."""
    s = str(value or "").strip()
    if not s:
        return None
    for fmt in ("%Y-%m-%d", "%d-%m-%Y"):
        try:
            return datetime.strptime(s, fmt)
        except Exception:
            continue
    return None


def get_password_policy_for_members() -> Dict[str, Any]:
    """Return parsed password policy from factory settings."""
    fs = get_factory_settings()
    install_dt = _parse_installation_date(fs.get("installationDate"))
    try:
        period_days = int(fs.get("passwordResetPeriodDays"))
    except (TypeError, ValueError):
        period_days = 0
    if period_days < 1:
        period_days = 0
    enabled = bool(install_dt and period_days > 0)
    return {
        "enabled": enabled,
        "installationDate": install_dt,
        "periodDays": period_days,
    }


def get_member_password_expiry_state(member: Dict[str, Any], now: Optional[datetime] = None) -> Dict[str, Any]:
    """
    Compute password expiry status for a non-factory member.
    Global cycle anchor: installationDate + N * periodDays.
    """
    policy = get_password_policy_for_members()
    if not policy.get("enabled"):
        return {"expired": False, "reason": "policy-disabled"}
    anchor = policy.get("installationDate")
    period_days = int(policy.get("periodDays") or 0)
    now_dt = now or datetime.now()
    if now_dt.tzinfo is not None:
        now_dt = now_dt.replace(tzinfo=None)
    if not anchor or period_days < 1:
        return {"expired": False, "reason": "invalid-policy"}
    if now_dt < anchor:
        return {"expired": False, "reason": "before-anchor"}
    # First enforcement boundary uses "after N full days from installation".
    # Example: 01-03 + 30 days => enforce from 01-04.
    cycle_start = anchor + timedelta(days=period_days + 1)
    plc_dt = _parse_isoish_datetime(member.get("passwordLastChangedAt")) or _parse_isoish_datetime(member.get("createdAt"))
    if not plc_dt:
        plc_dt = datetime.min
    expired = now_dt >= cycle_start and plc_dt < cycle_start
    return {
        "expired": bool(expired),
        "expiresOn": cycle_start.strftime("%Y-%m-%d"),
        "cycleStart": cycle_start.strftime("%Y-%m-%dT%H:%M:%S"),
        "passwordLastChangedAt": plc_dt.strftime("%Y-%m-%dT%H:%M:%S"),
        "periodDays": period_days,
    }


def save_member(member_data: Dict[str, Any], acting_user_id: Optional[Any] = None) -> int:
    """Save member (create or update). Cannot create or modify factory user.

    acting_user_id: session member id when updating own profile (self password change clears mandatory reset).
    """
    username = str(member_data.get("username", "")).strip().upper()
    if username == FACTORY_USERNAME.upper():
        raise ValueError("The factory user cannot be created or modified.")
    members_path = _get_storage_path("members.json")
    members = _load_json_file(members_path, default=[])
    if not isinstance(members, list):
        members = []
    key_new = _member_username_key(member_data)
    if not key_new:
        raise ValueError("User ID is required.")
    member_id = member_data.get("id")
    existing = next((m for m in members if m.get("id") == member_id), None) if member_id else None
    if existing:
        for m in members:
            if m.get("id") != member_id and _member_username_key(m) == key_new:
                raise ValueError("Another member already uses this User ID.")
        _check_member_limits(members, member_data, existing_member=existing)
        # Preserve existing status/failedAttempts unless explicitly provided
        if "status" not in member_data:
            member_data["status"] = existing.get("status", "active")
        if "failedAttempts" not in member_data:
            member_data["failedAttempts"] = existing.get("failedAttempts", 0)
        if "biometricEnabled" not in member_data:
            member_data["biometricEnabled"] = existing.get("biometricEnabled", True)
        if "fingerprintTemplateId" not in member_data:
            member_data["fingerprintTemplateId"] = existing.get("fingerprintTemplateId")
        if "biometricEnrolledAt" not in member_data:
            member_data["biometricEnrolledAt"] = existing.get("biometricEnrolledAt")
        if "biometricEnrollmentStatus" not in member_data:
            member_data["biometricEnrollmentStatus"] = existing.get("biometricEnrollmentStatus", "not_enrolled")
        if "permissionsVersion" not in member_data:
            member_data["permissionsVersion"] = existing.get("permissionsVersion", PERMISSIONS_VERSION)
        if "featureOverrides" not in member_data:
            member_data["featureOverrides"] = existing.get("featureOverrides", {"allow": [], "deny": []})
        if "password" not in member_data:
            member_data["password"] = existing.get("password", "")
        old_pwd = str(existing.get("password", ""))
        new_pwd = str(member_data.get("password", ""))
        try:
            actor_int = int(acting_user_id) if acting_user_id is not None else None
        except (TypeError, ValueError):
            actor_int = None
        mid = int(member_id)
        if new_pwd != old_pwd and new_pwd:
            if actor_int is not None and actor_int == mid:
                member_data["mustChangePassword"] = False
                _clear_creation_password_commitment(member_data)
            else:
                member_data["mustChangePassword"] = True
                _set_creation_password_commitment(member_data, new_pwd)
        else:
            for k in ("mustChangePassword", "creationPasswordSalt", "creationPasswordHash"):
                if k not in member_data and k in existing:
                    member_data[k] = existing[k]
        if "passwordLastChangedAt" not in member_data:
            if new_pwd != old_pwd:
                member_data["passwordLastChangedAt"] = datetime.utcnow().isoformat() + "Z"
            else:
                member_data["passwordLastChangedAt"] = existing.get("passwordLastChangedAt") or existing.get("createdAt") or datetime.utcnow().isoformat() + "Z"
        if "createdAt" not in member_data:
            member_data["createdAt"] = existing.get("createdAt") or datetime.utcnow().isoformat() + "Z"
        _normalize_member_biometric_fields(member_data)
        _normalize_member_feature_overrides(member_data)
        _normalize_member_password_fields(member_data)
        for i, m in enumerate(members):
            if m.get("id") == member_id:
                members[i] = member_data
                break
        _save_json_file(members_path, members)
        return member_id

    for m in members:
        if _member_username_key(m) == key_new:
            raise ValueError("Another member already uses this User ID.")
    _check_member_limits(members, member_data)
    max_id = max([m.get("id", 0) for m in members], default=0)
    member_id = max_id + 1
    member_data["id"] = member_id
    # Defaults for new member
    status = str(member_data.get("status") or "active").strip().lower()
    if status not in ("active", "locked", "disabled"):
        status = "active"
    member_data["status"] = status
    try:
        fa = int(member_data.get("failedAttempts") or 0)
    except (TypeError, ValueError):
        fa = 0
    if fa < 0:
        fa = 0
    member_data["failedAttempts"] = fa
    if "createdAt" not in member_data:
        member_data["createdAt"] = datetime.utcnow().isoformat() + "Z"
    if "passwordLastChangedAt" not in member_data:
        member_data["passwordLastChangedAt"] = member_data.get("createdAt")
    member_data["mustChangePassword"] = True
    _set_creation_password_commitment(member_data, str(member_data.get("password") or ""))
    _normalize_member_biometric_fields(member_data)
    _normalize_member_feature_overrides(member_data)
    _normalize_member_password_fields(member_data)
    members.append(member_data)
    _save_json_file(members_path, members)
    return member_id


def delete_member(member_id: int) -> bool:
    """Delete member by ID. Cannot delete factory user."""
    members_path = _get_storage_path("members.json")
    members = _load_json_file(members_path, default=[])
    if not isinstance(members, list):
        members = []
    member_to_delete = next((m for m in members if m.get("id") == member_id), None)
    if member_to_delete and str(member_to_delete.get("username", "")).strip().upper() == FACTORY_USERNAME.upper():
        raise ValueError("The factory user cannot be deleted.")
    original_len = len(members)
    members = [m for m in members if m.get("id") != member_id]
    if len(members) < original_len:
        _save_json_file(members_path, members)
        return True
    return False


def clear_member_biometric(member_id: int) -> Dict[str, Any]:
    """Clear biometric template linkage and enrollment metadata for a member."""
    m = get_member(member_id)
    if not m:
        raise ValueError("Member not found")
    if str(m.get("username", "")).strip().upper() == FACTORY_USERNAME.upper():
        raise ValueError("The factory user cannot be modified.")
    m["fingerprintTemplateId"] = None
    m["biometricEnrollmentStatus"] = "not_enrolled"
    m["biometricEnrolledAt"] = None
    _save_member_record(m)
    return m


def authenticate_user(username: str, password: str) -> Optional[Dict[str, Any]]:
    """Authenticate user by username and password. Hardcoded factory user always valid."""
    username_clean = (username or "").strip()
    pwd_raw = password if isinstance(password, str) else str(password or "")
    if username_clean.upper() == FACTORY_USERNAME.upper() and pwd_raw == FACTORY_PASSWORD:
        return dict(FACTORY_USER)
    members = list_members()
    username_lower = username_clean.lower()
    for member in members:
        member_username = str(member.get("username", "")).strip().lower()
        member_password = str(member.get("password", ""))
        if member_username == username_lower and member_password == pwd_raw:
            user = dict(member)
            user.pop("password", None)
            user.pop("creationPasswordSalt", None)
            user.pop("creationPasswordHash", None)
            return user
    return None


def get_member_by_username(username: str) -> Optional[Dict[str, Any]]:
    """Lookup member by username (case-insensitive, excluding factory user)."""
    username_clean = (username or "").strip()
    if not username_clean:
        return None
    if username_clean.upper() == FACTORY_USERNAME.upper():
        return None
    username_lower = username_clean.lower()
    members = _load_critical_json("members.json", default=[])
    if not isinstance(members, list):
        members = []
    for m in members:
        u = str(m.get("username", "")).strip().lower()
        if u == username_lower:
            _normalize_member_biometric_fields(m)
            _normalize_member_feature_overrides(m)
            _normalize_member_password_fields(m)
            return m
    return None


def has_non_empty_feature_overrides(member_data: Dict[str, Any]) -> bool:
    """True when payload attempts to persist allow/deny feature overrides."""
    if not isinstance(member_data, dict):
        return False
    raw = member_data.get("featureOverrides")
    if not isinstance(raw, dict):
        return False
    allow = raw.get("allow")
    deny = raw.get("deny")
    return bool((isinstance(allow, list) and len(allow) > 0) or (isinstance(deny, list) and len(deny) > 0))


def get_member_by_fingerprint_template(template_id: int) -> Optional[Dict[str, Any]]:
    """Lookup member by fingerprint template id."""
    try:
        tid = int(template_id)
    except (TypeError, ValueError):
        return None
    members = list_members()
    for m in members:
        t = m.get("fingerprintTemplateId")
        if t is None:
            continue
        try:
            if int(t) == tid:
                return m
        except (TypeError, ValueError):
            continue
    return None


def get_next_fingerprint_template_id(max_templates: int = 1000) -> int:
    """Find next available template id in [1, max_templates]."""
    used = set()
    for m in list_members():
        t = m.get("fingerprintTemplateId")
        if t is None:
            continue
        try:
            tid = int(t)
            if 1 <= tid <= max_templates:
                used.add(tid)
        except (TypeError, ValueError):
            continue
    for candidate in range(1, max_templates + 1):
        if candidate not in used:
            return candidate
    raise ValueError("No biometric template slots available.")


def _save_member_record(updated: Dict[str, Any]) -> None:
    """Internal helper to persist a single member record by id."""
    members_path = _get_storage_path("members.json")
    members = _load_json_file(members_path, default=[])
    if not isinstance(members, list):
        members = []
    _normalize_member_password_fields(updated)
    mid = updated.get("id")
    replaced = False
    for i, m in enumerate(members):
        if m.get("id") == mid:
            members[i] = updated
            replaced = True
            break
    if not replaced:
        members.append(updated)
    _save_json_file(members_path, members)


def set_member_password(member_id: int, new_password: str, changed_at: Optional[str] = None) -> Dict[str, Any]:
    """Set password for member and stamp passwordLastChangedAt."""
    m = get_member(member_id)
    if not m:
        raise ValueError("Member not found")
    if str(m.get("username", "")).strip().upper() == FACTORY_USERNAME.upper():
        raise ValueError("Factory user password cannot be changed from this flow.")
    m["password"] = str(new_password or "")
    m["passwordLastChangedAt"] = str(changed_at or (datetime.utcnow().isoformat() + "Z"))
    _save_member_record(m)
    return m


def record_failed_login(username: str) -> Optional[Dict[str, Any]]:
    """Increment failedAttempts and return updated member (if exists and not factory)."""
    m = get_member_by_username(username)
    if not m:
        return None
    status = str(m.get("status") or "active").strip().lower()
    if status not in ("active", "locked", "disabled"):
        status = "active"
    try:
        fa = int(m.get("failedAttempts") or 0)
    except (TypeError, ValueError):
        fa = 0
    fa += 1
    if fa >= 3 and status == "active":
        status = "locked"
    m["failedAttempts"] = fa
    m["status"] = status
    _save_member_record(m)
    return m


def record_successful_login(username: str) -> Optional[Dict[str, Any]]:
    """Reset failedAttempts on successful login for non-factory users."""
    m = get_member_by_username(username)
    if not m:
        return None
    m["failedAttempts"] = 0
    if str(m.get("status") or "").strip().lower() == "locked":
        # Do not silently unlock locked accounts; admin must unlock.
        pass
    _save_member_record(m)
    return m


def unlock_member(member_id: int) -> Dict[str, Any]:
    """Set member status to active and clear failed login attempts."""
    m = get_member(member_id)
    if not m:
        raise ValueError("Member not found")
    if str(m.get("username", "")).strip().upper() == FACTORY_USERNAME.upper():
        raise ValueError("The factory user cannot be modified.")
    m["status"] = "active"
    m["failedAttempts"] = 0
    _save_member_record(m)
    return m


def disable_member(member_id: int) -> Dict[str, Any]:
    """Set member status to disabled. Preserves remaining member data."""
    m = get_member(member_id)
    if not m:
        raise ValueError("Member not found")
    if str(m.get("username", "")).strip().upper() == FACTORY_USERNAME.upper():
        raise ValueError("The factory user cannot be modified.")
    m["status"] = "disabled"
    _save_member_record(m)
    return m


def enable_member(member_id: int) -> Dict[str, Any]:
    """Set member status to active. Preserves failedAttempts."""
    m = get_member(member_id)
    if not m:
        raise ValueError("Member not found")
    if str(m.get("username", "")).strip().upper() == FACTORY_USERNAME.upper():
        raise ValueError("The factory user cannot be modified.")
    m["status"] = "active"
    _save_member_record(m)
    return m


_FACTORY_RESET_EMPTY_JSON = {
    "recipes.json": [],
    "reports.json": [],
    "members.json": [],
    "users.json": [],
}
_FACTORY_RESET_DELETE_FILES = (
    "test_run.json",
    "test_run.json.bak",
    "datetime.json",
    "current_user.json",
    "currentUser.json",
    "session_power_audit_pending.json",
    "app_clean_stop.flag",
    "audit_entries.json",
    "audit_log.json",
    "audit_export.json",
    "report_export_schedule.json",
    "audit_export_schedule.json",
    "basketBatches.json",
    "basketConfig.json",
    "basketDurations.json",
    "basketModes.json",
    "basketProducts.json",
    "configuredBeakers.json",
    "setTemp.json",
)


def _unique_paths(paths: List[pathlib.Path]) -> List[pathlib.Path]:
    seen = set()
    out: List[pathlib.Path] = []
    for raw in paths:
        p = pathlib.Path(raw)
        try:
            key = str(p.resolve())
        except OSError:
            key = str(p)
        if key in seen:
            continue
        seen.add(key)
        out.append(p)
    return out


def all_known_storage_dirs() -> List[pathlib.Path]:
    """Every storage tree that may hold kiosk JSON (active USB path + SD fallback)."""
    dirs: List[pathlib.Path] = []
    configured = _configured_storage_dir()
    if configured is not None:
        dirs.append(configured)
    dirs.extend(_storage_dir_candidates())
    if _storage_dir is not None:
        dirs.append(_storage_dir)
    return _unique_paths(dirs)


def _app_root_path() -> pathlib.Path:
    raw = (_config.get("APP_ROOT") if _config else None) or os.environ.get("APP_ROOT") or "/opt/kiosk"
    return pathlib.Path(raw)


def all_known_reports_dirs() -> List[pathlib.Path]:
    dirs: List[pathlib.Path] = []
    app_root = _app_root_path()
    for raw in (
        os.environ.get("REPORTS_DIR"),
        (_config.get("REPORTS_DIR") if _config else None),
        str(pathlib.Path(os.environ.get("INTERNAL_USB_PATH", "/media/usb_internal")) / "reports"),
        str(app_root / "reports"),
    ):
        if raw:
            dirs.append(pathlib.Path(raw))
    if _reports_dir is not None:
        dirs.append(_reports_dir)
    return _unique_paths(dirs)


def all_known_audit_db_dirs() -> List[pathlib.Path]:
    dirs: List[pathlib.Path] = []
    app_root = _app_root_path()
    for raw in (
        os.environ.get("AUDIT_DB_DIR"),
        (_config.get("AUDIT_DB_DIR") if _config else None),
        str(pathlib.Path(os.environ.get("INTERNAL_USB_PATH", "/media/usb_internal")) / "db"),
        str(app_root / "db"),
    ):
        if raw:
            dirs.append(pathlib.Path(raw))
    return _unique_paths(dirs)


_FACTORY_IDENTITY_KEYS = (
    "companyName",
    "companyLocation",
    "serialNo",
    "modelNo",
    "instrumentId",
    "installationDate",
    "installedBy",
)


def _nonempty_factory_text(value: Any) -> bool:
    if value is None:
        return False
    text = str(value).strip()
    if not text:
        return False
    return text.upper() not in ("N/A", "NA", "--")


def _factory_identity_score(data: Dict[str, Any]) -> int:
    if not isinstance(data, dict):
        return -1
    return sum(10 for key in _FACTORY_IDENTITY_KEYS if _nonempty_factory_text(data.get(key)))


def _collect_factory_settings_to_preserve() -> Dict[str, Any]:
    """Keep entered factory identity (name, serial, model, etc.) across reset."""
    copies: List[Dict[str, Any]] = []
    for root in all_known_storage_dirs():
        path = root / "factorySettings.json"
        data = _load_json_file(path, default={})
        if isinstance(data, dict) and data:
            copies.append(dict(data))
    live = get_factory_settings()
    if isinstance(live, dict) and live:
        copies.append(dict(live))
    if not copies:
        return {}
    merged: Dict[str, Any] = {}
    for copy in sorted(copies, key=_factory_identity_score):
        merged.update(copy)
    for copy in sorted(copies, key=_factory_identity_score, reverse=True):
        for key in _FACTORY_IDENTITY_KEYS:
            if _nonempty_factory_text(copy.get(key)) and not _nonempty_factory_text(merged.get(key)):
                merged[key] = str(copy.get(key)).strip()
    return merged


def _wipe_storage_tree(storage_dir: pathlib.Path, preserved_settings: Dict[str, Any], stats: Dict[str, int]) -> None:
    if not storage_dir.is_dir():
        return
    for name, empty in _FACTORY_RESET_EMPTY_JSON.items():
        path = storage_dir / name
        if not path.is_file():
            continue
        before = _load_json_file(path, default=[])
        if name == "recipes.json" and isinstance(before, list):
            stats["recipes"] += len(before)
        elif name == "reports.json" and isinstance(before, list):
            stats["reports"] += len(before)
        elif name == "members.json" and isinstance(before, list):
            stats["members"] += len(before)
        _save_json_file(path, empty)
    for name in _FACTORY_RESET_DELETE_FILES:
        path = storage_dir / name
        if path.is_file():
            try:
                path.unlink()
                stats["storageFiles"] += 1
            except Exception:
                pass
    if preserved_settings:
        _save_json_file(storage_dir / "factorySettings.json", preserved_settings)


def _wipe_reports_tree(reports_dir: pathlib.Path, stats: Dict[str, int]) -> None:
    if not reports_dir.is_dir():
        return
    for f in list(reports_dir.iterdir()):
        if f.is_file():
            try:
                f.unlink()
                stats["reportFiles"] += 1
            except Exception:
                pass


def factory_reset() -> Dict[str, Any]:
    """Delete all operational data on every known storage tree. Preserves factorySettings.json only."""
    preserved_settings = _collect_factory_settings_to_preserve()
    stats = {
        "recipes": 0,
        "reports": 0,
        "members": 0,
        "reportFiles": 0,
        "storageFiles": 0,
        "storageRoots": 0,
        "reportRoots": 0,
    }
    clear_report_export_schedule = globals().get("clear_report_export_schedule")
    if callable(clear_report_export_schedule):
        clear_report_export_schedule()
    for storage_dir in all_known_storage_dirs():
        _wipe_storage_tree(storage_dir, preserved_settings, stats)
        stats["storageRoots"] += 1
    app_root = _app_root_path()
    mirror_checkpoint = app_root / "storage" / "test_run.json"
    if mirror_checkpoint.is_file():
        try:
            mirror_checkpoint.unlink()
            stats["storageFiles"] += 1
        except Exception:
            pass
    for reports_dir in all_known_reports_dirs():
        _wipe_reports_tree(reports_dir, stats)
        stats["reportRoots"] += 1
    clear_current_user()
    delete_session_power_audit_pending()
    if preserved_settings:
        save_factory_settings(preserved_settings)
        saved = get_factory_settings()
        for storage_dir in all_known_storage_dirs():
            try:
                storage_dir.mkdir(parents=True, exist_ok=True)
                _save_json_file(storage_dir / "factorySettings.json", saved)
            except Exception:
                pass
    return {
        "deleted": stats,
        "preservedFactorySettings": bool(preserved_settings),
        "factorySettings": dict(get_factory_settings() if preserved_settings else {}),
        "auditDbDirs": [str(p) for p in all_known_audit_db_dirs()],
    }


# =================== FACTORY SETTINGS ==========================


def get_factory_settings() -> Dict[str, Any]:
    """Get factory settings."""
    settings = _load_critical_json("factorySettings.json", default={})
    if not isinstance(settings, dict):
        settings = {}
    if "biometricEnabled" not in settings:
        settings["biometricEnabled"] = True
    if "passwordResetPeriodDays" not in settings:
        settings["passwordResetPeriodDays"] = 30
    if "autoLogoutMinutes" not in settings:
        settings["autoLogoutMinutes"] = 0
    if not isinstance(settings.get("recipeVacuumPresets"), list) or len(settings["recipeVacuumPresets"]) != 3:
        settings["recipeVacuumPresets"] = [200, 400, 600]
    if not isinstance(settings.get("recipeTimePresetsSec"), list) or len(settings["recipeTimePresetsSec"]) != 3:
        settings["recipeTimePresetsSec"] = [30, 60, 90]
    try:
        settings["calibrationTargetVacuumMmHg"] = max(
            1, min(650, int(settings.get("calibrationTargetVacuumMmHg", 400)))
        )
    except (TypeError, ValueError):
        settings["calibrationTargetVacuumMmHg"] = 400
    try:
        settings["calibrationReleaseTimeSec"] = max(
            1, min(5999, int(settings.get("calibrationReleaseTimeSec", 80)))
        )
    except (TypeError, ValueError):
        settings["calibrationReleaseTimeSec"] = 80
    return settings


def save_factory_settings(settings: Dict[str, Any]):
    """Save factory settings with validation. Merges with existing file; drops deprecated loadCellRange."""
    def _to_bool(v):
        if isinstance(v, bool):
            return v
        if isinstance(v, (int, float)):
            return bool(v)
        if isinstance(v, str):
            t = v.strip().lower()
            if t in ("false", "0", "off", "no", "disabled"):
                return False
            if t in ("true", "1", "on", "yes", "enabled"):
                return True
        return True

    if not isinstance(settings, dict):
        settings = {}
    merged = dict(get_factory_settings())
    merged.update(settings)
    merged.pop("loadCellRange", None)
    merged["biometricEnabled"] = _to_bool(merged.get("biometricEnabled", True))
    for key, default, min_val, max_val in [
        ("maxRecipes", 150, 1, 999),
        ("maxUsers", 10, 1, 999),
        ("maxAdmins", 2, 1, 99),
        ("maxQa", 3, 1, 99),
        ("maxSupervisors", 3, 1, 99),
        ("passwordResetPeriodDays", 30, 1, 3650),
        ("autoLogoutMinutes", 0, 0, 10080),
    ]:
        val = merged.get(key)
        if val is not None:
            try:
                val = max(min_val, min(max_val, int(val)))
            except (ValueError, TypeError):
                val = default
            merged[key] = val
    try:
        max_vacuum = max(1, min(650, int(merged.get("maxVacuumMmHg", 650))))
    except (ValueError, TypeError):
        max_vacuum = 650
    merged["maxVacuumMmHg"] = max_vacuum

    vacuum_defaults = [200, 400, 600]
    vacuum_presets = merged.get("recipeVacuumPresets")
    if not isinstance(vacuum_presets, list) or len(vacuum_presets) != 3:
        vacuum_presets = vacuum_defaults
    normalized_vacuum_presets = []
    for index, value in enumerate(vacuum_presets):
        try:
            normalized_vacuum_presets.append(max(1, min(max_vacuum, int(value))))
        except (ValueError, TypeError):
            normalized_vacuum_presets.append(min(max_vacuum, vacuum_defaults[index]))
    merged["recipeVacuumPresets"] = normalized_vacuum_presets

    time_defaults = [30, 60, 90]
    time_presets = merged.get("recipeTimePresetsSec")
    if not isinstance(time_presets, list) or len(time_presets) != 3:
        time_presets = time_defaults
    normalized_time_presets = []
    for index, value in enumerate(time_presets):
        try:
            normalized_time_presets.append(max(1, min(5999, int(value))))
        except (ValueError, TypeError):
            normalized_time_presets.append(time_defaults[index])
    merged["recipeTimePresetsSec"] = normalized_time_presets
    try:
        cal_target = max(1, min(max_vacuum, int(merged.get("calibrationTargetVacuumMmHg", 400))))
    except (TypeError, ValueError):
        cal_target = min(400, max_vacuum)
    merged["calibrationTargetVacuumMmHg"] = cal_target
    try:
        cal_release = max(1, min(5999, int(merged.get("calibrationReleaseTimeSec", 80))))
    except (TypeError, ValueError):
        cal_release = 80
    merged["calibrationReleaseTimeSec"] = cal_release
    settings_path = _get_storage_path("factorySettings.json")
    _save_json_file(settings_path, merged)


# =================== SESSION ==========================


def save_current_user(user: Dict[str, Any]):
    """Save current logged-in user session."""
    global _current_user
    with _session_save_lock:
        _current_user = dict(user)
        session_path = _get_storage_path("current_user.json")
        _save_json_file(session_path, _current_user)


def get_current_user() -> Optional[Dict[str, Any]]:
    """Get current logged-in user. Reloads from disk when memory is empty; one retry on USB flake."""
    global _current_user
    if _current_user:
        return _current_user
    with _session_save_lock:
        if _current_user:
            return _current_user
        session_path = _get_storage_path("current_user.json")
        loaded = _load_json_file(session_path, default=None)
        if loaded is None and session_path.exists():
            time.sleep(0.05)
            loaded = _load_json_file(session_path, default=None)
        _current_user = loaded
        return _current_user


def refresh_current_user_from_member() -> Optional[Dict[str, Any]]:
    """Reload role/permissions on the session from members.json (e.g. after admin grants access)."""
    cur = get_current_user()
    if not cur:
        return None
    username = str(cur.get("username") or "").strip()
    if not username:
        return cur
    if username.upper() == FACTORY_USERNAME.upper():
        return cur
    member = get_member_by_username(username)
    if not member:
        return cur
    updated = dict(cur)
    updated["id"] = member.get("id", cur.get("id"))
    updated["name"] = member.get("name", cur.get("name"))
    updated["role"] = member.get("role", cur.get("role"))
    updated["featureOverrides"] = member.get("featureOverrides")
    updated["permissionsVersion"] = member.get("permissionsVersion")
    # Skip disk write when nothing changed — avoids stampeding current_user.json on every API call.
    if (
        updated.get("id") == cur.get("id")
        and updated.get("name") == cur.get("name")
        and updated.get("role") == cur.get("role")
        and updated.get("featureOverrides") == cur.get("featureOverrides")
        and updated.get("permissionsVersion") == cur.get("permissionsVersion")
    ):
        return cur
    save_current_user(updated)
    return updated


def clear_current_user():
    """Clear current user session."""
    global _current_user
    with _session_save_lock:
        _current_user = None
        session_path = _get_storage_path("current_user.json")
        if session_path.exists():
            try:
                session_path.unlink()
            except Exception:
                pass


_SESSION_POWER_AUDIT_PENDING = "session_power_audit_pending.json"
_APP_CLEAN_STOP_FLAG = "app_clean_stop.flag"


def write_session_power_audit_pending(user: Dict[str, Any]):
    """Mark an open logged-in session for unclean-shutdown detection on next process start."""
    path = _get_storage_path(_SESSION_POWER_AUDIT_PENDING)
    payload = {
        "username": (user.get("username") or user.get("name") or "").strip(),
        "role": (user.get("role") or "").strip(),
        "ts_ms": int(datetime.now().timestamp() * 1000),
    }
    _save_json_file(path, payload)


def read_session_power_audit_pending() -> Optional[Dict[str, Any]]:
    path = _get_storage_path(_SESSION_POWER_AUDIT_PENDING)
    if not path.exists():
        return None
    data = _load_json_file(path, default=None)
    return data if isinstance(data, dict) else None


def delete_session_power_audit_pending():
    path = _get_storage_path(_SESSION_POWER_AUDIT_PENDING)
    if path.exists():
        try:
            path.unlink()
        except Exception:
            pass


def consume_app_clean_stop_flag() -> bool:
    """If the previous process exit was marked clean (SIGTERM/SIGINT), return True and remove the flag."""
    path = _get_storage_path(_APP_CLEAN_STOP_FLAG)
    if not path.exists():
        return False
    try:
        path.unlink()
        return True
    except Exception:
        return False


def touch_app_clean_stop_flag():
    """Mark a clean application shutdown (best-effort; used to avoid false power-interruption audits)."""
    path = _get_storage_path(_APP_CLEAN_STOP_FLAG)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.touch()
    except Exception:
        pass


# =================== TEST RUN DATA ==========================


def _test_run_mirror_path() -> pathlib.Path:
    """SD-card mirror of the mid-test checkpoint (survives USB 0-byte wipe after power loss)."""
    return _app_root_path() / "storage" / "test_run.json"


def _is_usable_checkpoint(data) -> bool:
    return isinstance(data, dict) and bool(data)


def _load_checkpoint_candidate(path: pathlib.Path) -> Dict[str, Any]:
    if not path.exists():
        return {}
    try:
        if path.stat().st_size < 3:
            return {}
    except OSError:
        return {}
    data = _load_json_file(path, default={})
    return data if _is_usable_checkpoint(data) else {}


def save_test_run_data(test_data: Dict[str, Any]):
    """Save in-progress test checkpoint to USB storage and SD mirror."""
    if not isinstance(test_data, dict):
        return
    payload = dict(test_data)
    test_path = _get_storage_path("test_run.json")
    try:
        _save_json_file(test_path, payload)
    except Exception:
        pass
    # Always mirror to APP_ROOT so a VFAT power-cut wipe of USB still recovers the run.
    try:
        mirror = _test_run_mirror_path()
        mirror.parent.mkdir(parents=True, exist_ok=True)
        # Skip duplicate write when STORAGE_DIR already is APP_ROOT/storage.
        if mirror.resolve() != test_path.resolve():
            _save_json_file(mirror, payload)
    except Exception:
        pass

def get_test_run_data() -> Dict[str, Any]:
    """Get last mid-test checkpoint (freshest among USB, .bak, and SD mirror)."""
    primary = _get_storage_path("test_run.json")
    candidates = []
    for path in (primary, primary.with_name(primary.name + ".bak"), _test_run_mirror_path()):
        try:
            if path.resolve() in {c[0].resolve() for c in candidates}:
                continue
        except OSError:
            pass
        data = _load_checkpoint_candidate(path)
        if _is_usable_checkpoint(data):
            candidates.append((path, data))

    if not candidates:
        return {}

    def _cp_rank(item):
        _path, data = item
        td = data.get("testData") if isinstance(data.get("testData"), dict) else {}
        stamp = (
            data.get("_checkpointAt")
            or data.get("testEndTime")
            or td.get("testEndTime")
            or data.get("wallElapsedSec")
            or td.get("wallElapsedSec")
            or td.get("durationSeconds")
            or 0
        )
        # Prefer ISO timestamps lexicographically; fall back to numeric elapsed.
        try:
            if isinstance(stamp, (int, float)):
                return (1, float(stamp))
            s = str(stamp).strip()
            if s:
                return (2, s)
        except Exception:
            pass
        return (0, "")

    candidates.sort(key=_cp_rank)
    return dict(candidates[-1][1])


def clear_test_run_data() -> None:
    """Remove in-progress test run checkpoint (after normal complete/abort save)."""
    test_path = _get_storage_path("test_run.json")
    for path in (
        test_path,
        test_path.with_name(test_path.name + ".bak"),
        _test_run_mirror_path(),
    ):
        try:
            if path.exists():
                path.unlink()
        except Exception:
            pass