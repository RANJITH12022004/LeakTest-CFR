#!/usr/bin/env python3
"""
hardware_service.py - Serial communication to MCU for Leak Test apparatus.
Supports simulation mode (LEAK_TEST_SIMULATE=1) for development without hardware.
"""

import errno
import json
import os
import queue
import random
import threading
import time
from typing import Any, Dict, List, Optional

from flask import Response

try:
    import serial
except ImportError:
    serial = None

_logger = None
_config = {}
_esp_port = None
ser_lock = threading.Lock()
esp_ser = None
line_q = queue.Queue(maxsize=2000)
sse_clients = []
esp_read_buffer = ""
COMMAND_TIMEOUT = 2.0
TEST_COMMAND_TIMEOUT = 30.0
MAX_RETRIES = 3
_uart_log_lock = threading.Lock()
_uart_log_path = ""

# Simulation state
_sim_lock = threading.Lock()
_sim_active = False
_sim_thread = None
_sim_params: Dict[str, Any] = {}
_sim_cycle_index = 0
_sim_elapsed_in_cycle = 0.0
_sim_pressure_mbar = 0.0


def _simulate_enabled() -> bool:
    # Production default is hardware. Set LEAK_TEST_SIMULATE=1 only for development.
    return str(os.environ.get("LEAK_TEST_SIMULATE", "0")).strip().lower() in ("1", "true", "yes")


def normalize_line(line: str) -> str:
    s = str(line or "").strip()
    if s.endswith("*"):
        s = s[:-1].strip()
    return s


def classify_line(line: str) -> str:
    s = normalize_line(line).lower()
    if not s:
        return "empty"
    if s == "ok":
        return "ok"
    if s in ("completed", "complete."):
        return "completed"
    if s == "stopped":
        return "stopped"
    if s == "adapt,error":
        return "adapter_error"
    if s == "error" or s.startswith("error:"):
        return "error"
    if s.startswith("pressure:") or s.startswith("cycle:") or s.startswith("leak:"):
        return "progress"
    if s.startswith("vacuum:") or s.startswith("elapsed:"):
        return "progress"
    if s.isdigit():
        return "progress"
    return "info"


def init(app, config):
    global _logger, _config, _esp_port, line_q, sse_clients, _uart_log_path
    _logger = app.logger
    _config = dict(config)
    _esp_port = _config.get("ESP_PORT", "/dev/serial0")
    _uart_log_path = _config.get("UART_LOG_PATH", "/opt/kiosk/uart_communications.log")
    reset_uart_log(reason="service_start")
    line_q = queue.Queue(maxsize=2000)
    sse_clients = []
    if _simulate_enabled():
        if _logger:
            _logger.info("[HARDWARE] Leak test simulation mode enabled")
        return
    try:
        _open_esp_serial()
        if _logger:
            _logger.info("[HARDWARE] MCU serial initialized")
    except Exception as e:
        if _logger:
            _logger.warning("[HARDWARE] Serial unavailable, falling back to simulation: %s", e)
    threading.Thread(target=_reader_loop, daemon=True).start()


def _open_esp_serial():
    global esp_ser, _esp_port
    port = _config.get("ESP_PORT", "/dev/serial0")
    baud = int(_config.get("ESP_BAUD", 9600))
    if not serial:
        raise FileNotFoundError(errno.ENOENT, "pyserial not installed", port)
    with ser_lock:
        if esp_ser and getattr(esp_ser, "is_open", False):
            return esp_ser
        is_windows_com_port = (
            os.name == "nt"
            and isinstance(port, str)
            and port.strip() != ""
            and port.strip().upper().startswith("COM")
        )
        if (not port) or (not is_windows_com_port and not os.path.exists(port)):
            for c in ["/dev/serial0", "/dev/ttyUSB0", "/dev/ttyUSB1", "/dev/ttyAMA0"]:
                if os.path.exists(c):
                    port = c
                    _esp_port = c
                    break
            else:
                raise FileNotFoundError(errno.ENOENT, "Serial device not found", port)
        if esp_ser:
            try:
                esp_ser.close()
            except Exception:
                pass
        esp_ser = serial.Serial(
            port=port,
            baudrate=baud,
            timeout=2.0,
            write_timeout=2.0,
            bytesize=serial.EIGHTBITS,
            parity=serial.PARITY_NONE,
            stopbits=serial.STOPBITS_ONE,
        )
        esp_ser.reset_input_buffer()
        esp_ser.reset_output_buffer()
        _esp_port = port
        return esp_ser


def _broadcast_line(line: str):
    _append_uart_log("RX_STREAM", line)
    try:
        line_q.put_nowait(line)
    except queue.Full:
        pass
    for q in list(sse_clients):
        try:
            q.put_nowait(line)
        except Exception:
            if q in sse_clients:
                sse_clients.remove(q)


def _sim_chamber_factor(chamber: str) -> float:
    c = str(chamber or "MEDIUM").upper()
    if c in ("SMALL", "S"):
        return 0.8
    if c in ("LARGE", "L"):
        return 1.3
    return 1.0


def _sim_evac_rate(evacuation_rate: str) -> float:
    r = str(evacuation_rate or "STANDARD").upper()
    return 25.0 if r == "FAST" else 15.0


def _simulation_loop():
    global _sim_active, _sim_cycle_index, _sim_elapsed_in_cycle, _sim_pressure_mbar
    params = dict(_sim_params)
    target = float(params.get("targetVacuumMbar", -50))
    cycles: List[Dict] = params.get("cycles") or [{"holdSeconds": 30}]
    evac_rate = _sim_evac_rate(params.get("evacuationRate", "STANDARD"))
    chamber_factor = _sim_chamber_factor(params.get("chamberSize", "MEDIUM"))
    max_leak = float(params.get("maxLeakRate", 0.5))
    tick = 0.5

    _sim_cycle_index = 0
    _sim_elapsed_in_cycle = 0.0
    _sim_pressure_mbar = 0.0
    phase = "evacuate"

    while _sim_active:
        if phase == "evacuate":
            _sim_pressure_mbar -= evac_rate * tick
            if _sim_pressure_mbar <= target:
                _sim_pressure_mbar = target
                phase = "hold"
                _sim_elapsed_in_cycle = 0.0
                _broadcast_line(f"cycle:{_sim_cycle_index + 1},phase:hold*")
        elif phase == "hold":
            hold = float(cycles[_sim_cycle_index].get("holdSeconds", 30))
            decay = random.uniform(0.02, 0.08) * chamber_factor
            _sim_pressure_mbar += decay * tick
            _sim_elapsed_in_cycle += tick
            leak_rate = abs(_sim_pressure_mbar - target) / max(hold, 1) * chamber_factor
            _broadcast_line(
                f"pressure:{_sim_pressure_mbar:.2f},cycle:{_sim_cycle_index + 1},"
                f"elapsed:{_sim_elapsed_in_cycle:.1f},leak:{leak_rate:.3f}*"
            )
            if _sim_elapsed_in_cycle >= hold:
                result = "PASS" if leak_rate <= max_leak else "FAIL"
                _broadcast_line(f"cycle:{_sim_cycle_index + 1},complete:{result}*")
                _sim_cycle_index += 1
                if _sim_cycle_index >= len(cycles):
                    _broadcast_line("completed*")
                    _sim_active = False
                    break
                phase = "evacuate"
                _sim_elapsed_in_cycle = 0.0
        else:
            _broadcast_line(f"pressure:{_sim_pressure_mbar:.2f}*")
        time.sleep(tick)


def send_command(cmd: str, timeout=COMMAND_TIMEOUT, max_retries=MAX_RETRIES, ignore_numeric_response=False):
    if not cmd:
        return {"ok": False, "error": "Empty command"}
    cmd = cmd.strip()
    if not cmd.endswith("*"):
        cmd = cmd + "*"
    _append_uart_log("TX", cmd)
    if _simulate_enabled() or not serial:
        return {"ok": True, "response": "ok", "normalized": "ok", "kind": "ok", "cmd": cmd}
    for attempt in range(max_retries):
        if not esp_ser or not getattr(esp_ser, "is_open", False):
            try:
                _open_esp_serial()
            except Exception as e:
                if attempt == max_retries - 1:
                    return {"ok": False, "error": str(e), "cmd": cmd}
                time.sleep(0.2)
                continue
        try:
            drain_queue(max_lines=200)
            with ser_lock:
                if esp_ser and esp_ser.is_open:
                    esp_ser.reset_input_buffer()
                    esp_ser.write((cmd + "\n").encode("ascii", errors="replace"))
                    esp_ser.flush()
            deadline = time.time() + (timeout or COMMAND_TIMEOUT)
            while time.time() < deadline:
                try:
                    line = line_q.get(timeout=0.1)
                    if line and line.strip():
                        raw = line.strip()
                        if ignore_numeric_response and normalize_line(raw).isdigit():
                            continue
                        _append_uart_log("RX", raw)
                        norm = normalize_line(raw)
                        return {"ok": True, "response": raw, "normalized": norm, "kind": classify_line(raw), "cmd": cmd}
                except queue.Empty:
                    pass
                with ser_lock:
                    if esp_ser and esp_ser.is_open and esp_ser.in_waiting > 0:
                        raw = esp_ser.readline()
                        if raw:
                            line = raw.decode("ascii", errors="ignore").strip()
                            if line:
                                if ignore_numeric_response and normalize_line(line).isdigit():
                                    continue
                                _append_uart_log("RX", line)
                                norm = normalize_line(line)
                                return {"ok": True, "response": line, "normalized": norm, "kind": classify_line(line), "cmd": cmd}
                time.sleep(0.05)
            if timeout is not None:
                return {"ok": False, "error": "Timeout", "cmd": cmd}
        except Exception as e:
            if attempt == max_retries - 1:
                return {"ok": False, "error": str(e), "cmd": cmd}
            try:
                with ser_lock:
                    if esp_ser:
                        esp_ser.close()
                        esp_ser = None
                _open_esp_serial()
            except Exception:
                pass
            time.sleep(0.2)
    return {"ok": False, "error": "Max retries exceeded", "cmd": cmd}


def _reader_loop():
    global esp_read_buffer, esp_ser
    while True:
        try:
            if not esp_ser or not getattr(esp_ser, "is_open", False):
                try:
                    _open_esp_serial()
                except Exception:
                    time.sleep(2.0)
                    continue
            with ser_lock:
                if esp_ser and esp_ser.in_waiting > 0:
                    chunk = esp_ser.read(min(esp_ser.in_waiting, 1024))
                else:
                    time.sleep(0.05)
                    continue
            if chunk:
                try:
                    esp_read_buffer += chunk.decode("ascii", errors="ignore")
                except Exception:
                    continue
                while "\n" in esp_read_buffer:
                    line, esp_read_buffer = esp_read_buffer.split("\n", 1)
                    line = line.strip()
                    if line:
                        _broadcast_line(line)
                if len(esp_read_buffer) > 4096:
                    esp_read_buffer = esp_read_buffer[-2048:]
        except Exception as e:
            if _logger:
                _logger.debug("[HARDWARE] reader: %s", e)
            time.sleep(1.0)


def start_sse_stream():
    def gen():
        q = queue.Queue(maxsize=100)
        sse_clients.append(q)
        try:
            while True:
                try:
                    line = q.get(timeout=30.0)
                    yield f"data: {json.dumps({'line': line, 'normalized': normalize_line(line), 'kind': classify_line(line)})}\n\n"
                except queue.Empty:
                    yield "data: {\"ping\": true}\n\n"
        finally:
            if q in sse_clients:
                sse_clients.remove(q)
    return Response(
        gen(),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


def drain_queue(max_lines=10):
    out = []
    for _ in range(max_lines):
        try:
            out.append(line_q.get_nowait())
        except queue.Empty:
            break
    return out


def cmd_check_adapter():
    return send_command("leak,chk*", ignore_numeric_response=True)


def cmd_start_test(params: Dict[str, Any]):
    global _sim_active, _sim_thread, _sim_params
    target = float(params.get("targetVacuumMbar", -50))
    evacuation_rate = str(params.get("evacuationRate", "STANDARD")).upper()
    cycles = params.get("cycles") or [{"holdSeconds": 30}]
    if not cycles:
        return {"ok": False, "error": "At least one test cycle is required"}
    if _simulate_enabled():
        with _sim_lock:
            _sim_active = False
            if _sim_thread and _sim_thread.is_alive():
                time.sleep(0.2)
            _sim_params = dict(params)
            _sim_active = True
            _sim_thread = threading.Thread(target=_simulation_loop, daemon=True)
            _sim_thread.start()
        return {"ok": True, "simulated": True, "targetVacuumMbar": target, "cycles": len(cycles)}
    cycle_str = ",".join(str(int(c.get("holdSeconds", 30))) for c in cycles)
    return send_command(
        f"leak,start,{target},{evacuation_rate},{cycle_str}*",
        timeout=TEST_COMMAND_TIMEOUT,
    )


def cmd_stop():
    global _sim_active
    if _simulate_enabled():
        with _sim_lock:
            _sim_active = False
        _broadcast_line("stopped*")
        return {"ok": True, "simulated": True}
    return send_command("stop*")


def cmd_status():
    if _simulate_enabled():
        with _sim_lock:
            return {
                "ok": True,
                "simulated": True,
                "active": _sim_active,
                "pressureMbar": round(_sim_pressure_mbar, 2),
                "cycleIndex": _sim_cycle_index,
            }
    return send_command("status*")


def _vacuum_validation_loop(vacuum_mmhg: float, duration_sec: float):
    """Evacuate to target, then hold for duration_sec (elapsed counts only during hold)."""
    global _sim_active
    target = max(1.0, float(vacuum_mmhg))
    duration = max(1.0, float(duration_sec))
    current = 0.0
    hold_elapsed = 0.0
    tick = 0.5
    evac_rate = target / max(3.0, duration * 0.3)
    phase = "evacuate"

    while _sim_active:
        if phase == "evacuate":
            current = min(target, current + evac_rate * tick)
            _broadcast_line(f"vacuum:{current:.1f},elapsed:0.0*")
            if current >= target:
                phase = "hold"
                hold_elapsed = 0.0
        else:
            current += random.uniform(-0.5, 0.8)
            current = max(target * 0.95, min(target * 1.02, current))
            hold_elapsed += tick
            _broadcast_line(f"vacuum:{current:.1f},elapsed:{hold_elapsed:.1f}*")
            if hold_elapsed >= duration:
                break
        time.sleep(tick)

    if _sim_active:
        _broadcast_line("completed*")
    _sim_active = False


def cmd_start_vacuum_validation(vacuum_mmhg: float, duration_sec: float):
    global _sim_active, _sim_thread
    try:
        vac = float(vacuum_mmhg)
        dur = float(duration_sec)
    except (TypeError, ValueError):
        return {"ok": False, "error": "Invalid vacuum or duration"}
    if vac < 1 or dur < 1:
        return {"ok": False, "error": "Vacuum and duration must be at least 1"}
    if _simulate_enabled():
        with _sim_lock:
            _sim_active = False
            if _sim_thread and _sim_thread.is_alive():
                time.sleep(0.2)
            _sim_active = True
            _sim_thread = threading.Thread(
                target=_vacuum_validation_loop,
                args=(vac, dur),
                daemon=True,
            )
            _sim_thread.start()
        return {"ok": True, "simulated": True, "vacuumMmHg": vac, "durationSec": dur}
    return send_command(
        f"leak,val,start,{vac},{int(dur)}*",
        timeout=TEST_COMMAND_TIMEOUT,
    )


def cmd_start_validation(mode: str):
    m = str(mode or "").strip().lower()
    if m not in ("usp1", "usp2"):
        return {"ok": False, "error": "mode must be usp1 or usp2"}
    if _simulate_enabled():
        return {"ok": True, "simulated": True, "mode": m}
    return send_command(f"{m},start*")


def _append_uart_log(direction: str, payload: str):
    path = _uart_log_path or "/opt/kiosk/uart_communications.log"
    ts = time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime())
    line = f"{ts} [{direction}] {str(payload or '').strip()}\n"
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with _uart_log_lock:
            with open(path, "a", encoding="utf-8") as f:
                f.write(line)
    except Exception:
        pass


def reset_uart_log(reason: str = "manual"):
    path = _uart_log_path or "/opt/kiosk/uart_communications.log"
    ts = time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime())
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with _uart_log_lock:
            with open(path, "w", encoding="utf-8") as f:
                f.write(f"{ts} [SYSTEM] UART log reset ({reason})\n")
        return {"ok": True, "path": path}
    except Exception as e:
        return {"ok": False, "error": str(e), "path": path}
