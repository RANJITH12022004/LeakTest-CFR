#!/usr/bin/env python3
"""
calculation_service.py - Leak Test recipe validation and calculations.
"""

from datetime import datetime
from typing import Any, Dict, List, Optional

CHAMBER_VOLUMES_ML = {"SMALL": 50, "MEDIUM": 100, "LARGE": 250}
VALID_METHODS = {"VACUUM_DECAY", "PRESSURE_DECAY", "CUSTOM"}
VALID_EVACUATION_RATES = {"FAST", "STANDARD"}


def init():
    pass


def _normalize_chamber(val: Any) -> Optional[str]:
    if val is None:
        return None
    s = str(val).strip().upper()
    if s in ("SMALL", "S", "50"):
        return "SMALL"
    if s in ("MEDIUM", "M", "100"):
        return "MEDIUM"
    if s in ("LARGE", "L", "250"):
        return "LARGE"
    return s if s in CHAMBER_VOLUMES_ML else None


def validate_recipe(recipe_data: Dict[str, Any]) -> Dict[str, Any]:
    errors: List[str] = []
    name = (recipe_data.get("productName") or recipe_data.get("name") or "").strip()
    if not name:
        errors.append("Product name is required")
    product_type = str(recipe_data.get("productType") or "").strip()
    if not product_type:
        errors.append("Product type is required")
    try:
        raw_samples = recipe_data.get("noOfSamples")
        if raw_samples in (None, ""):
            pass  # optional
        else:
            samples = int(raw_samples)
            if samples < 1:
                errors.append("No. of samples must be 1 or more when provided")
    except (TypeError, ValueError):
        errors.append("No. of samples must be a whole number when provided")
    try:
        batch_size = int(recipe_data.get("batchSize"))
        if batch_size < 1 or batch_size > 999:
            errors.append("Batch size must be between 1 and 999")
    except (TypeError, ValueError):
        errors.append("Batch size is required")

    method = str(recipe_data.get("method") or recipe_data.get("testMethod") or "").strip().upper()
    if method and method not in VALID_METHODS:
        errors.append("Method must be VACUUM_DECAY, PRESSURE_DECAY, or CUSTOM")

    try:
        tv = recipe_data.get("targetVacuumMbar")
        if tv is not None:
            v = float(tv)
            if v > 0 or v < -1000:
                errors.append("Target vacuum must be between -1000 and 0 mbar")
    except (TypeError, ValueError):
        errors.append("Invalid target vacuum")

    evac = str(recipe_data.get("evacuationRate") or "").strip().upper()
    if evac and evac not in VALID_EVACUATION_RATES:
        errors.append("Evacuation rate must be FAST or STANDARD")

    chamber = _normalize_chamber(recipe_data.get("chamberSize") or recipe_data.get("chamber"))
    if recipe_data.get("chamberSize") is not None and not chamber:
        errors.append("Chamber size must be SMALL, MEDIUM, or LARGE")

    cycles = recipe_data.get("cycles")
    if cycles is not None and not isinstance(cycles, list):
        errors.append("Cycles must be an array")
    elif isinstance(cycles, list):
        if not cycles:
            errors.append("At least one test cycle is required")
        for i, c in enumerate(cycles):
            if not isinstance(c, dict):
                errors.append(f"Cycle {i + 1}: invalid format")
                continue
            try:
                hs = int(c.get("holdSeconds", 0))
                if hs < 1 or hs > 3600:
                    errors.append(f"Cycle {i + 1}: hold time must be 1-3600 seconds")
            except (TypeError, ValueError):
                errors.append(f"Cycle {i + 1}: invalid hold time")

    try:
        mlr = recipe_data.get("maxLeakRate")
        if mlr is not None:
            r = float(mlr)
            if r < 0 or r > 100:
                errors.append("Max leak rate must be 0-100")
    except (TypeError, ValueError):
        errors.append("Invalid max leak rate")

    if errors:
        return {"valid": False, "error": "; ".join(errors)}
    return {"valid": True}


def process_recipe_form_data(form_data: Dict[str, Any]) -> Dict[str, Any]:
    recipe = dict(form_data)
    raw_samples = recipe.get("noOfSamples")
    if raw_samples in (None, ""):
        recipe["noOfSamples"] = None
    else:
        try:
            recipe["noOfSamples"] = int(raw_samples)
        except (TypeError, ValueError):
            recipe["noOfSamples"] = None
    try:
        recipe["batchSize"] = int(recipe.get("batchSize"))
    except (TypeError, ValueError):
        pass
    if "createdAt" not in recipe:
        recipe["createdAt"] = datetime.utcnow().isoformat() + "Z"
    if "lastUsed" not in recipe:
        recipe["lastUsed"] = recipe.get("createdAt", "")
    chamber = _normalize_chamber(recipe.get("chamberSize") or recipe.get("chamber"))
    if chamber:
        recipe["chamberSize"] = chamber
        recipe["chamberVolumeMl"] = CHAMBER_VOLUMES_ML.get(chamber)
    method = str(recipe.get("method") or recipe.get("testMethod") or "CUSTOM").strip().upper()
    recipe["method"] = method
    if method == "VACUUM_DECAY":
        recipe.setdefault("targetVacuumMbar", -50)
        recipe.setdefault("evacuationRate", "FAST")
    elif method == "PRESSURE_DECAY":
        recipe.setdefault("targetVacuumMbar", -100)
        recipe.setdefault("evacuationRate", "STANDARD")
    return recipe


def compute_leak_rate(
    pressure_start_mbar: float,
    pressure_end_mbar: float,
    hold_seconds: float,
    chamber_volume_ml: float = 100.0,
) -> float:
    if hold_seconds <= 0:
        return 0.0
    delta = abs(pressure_end_mbar - pressure_start_mbar)
    factor = max(chamber_volume_ml, 1.0) / 100.0
    return round((delta / hold_seconds) * factor, 4)


def evaluate_pass_fail(leak_rate: float, max_leak_rate: float) -> str:
    try:
        return "PASS" if float(leak_rate) <= float(max_leak_rate) else "FAIL"
    except (TypeError, ValueError):
        return "FAIL"
