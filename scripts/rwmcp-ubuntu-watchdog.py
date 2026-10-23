#!/usr/bin/env python3
"""Owner-local, bounded RWMCP Direct Node health watchdog. No secret access."""
from __future__ import annotations

import argparse
import errno
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

SERVICE = "remote-workstation-mcp-openai.service"
FAILURE_THRESHOLD = 3
COOLDOWN_SECONDS = 1800
MAX_RESTARTS_PER_DAY = 3
HEALTH_TIMEOUT = 3
HOME = Path.home()
DATA = Path(os.environ.get("RWMCP_HOME", HOME / ".local/share/remote-workstation-mcp"))
CONFIG = Path(os.environ.get("RWMCP_CONFIG_HOME", HOME / ".config/remote-workstation-mcp"))
STATE = HOME / ".local/state/remote-workstation-mcp/ubuntu-watchdog.json"


def emit(**fields: object) -> None:
    print(json.dumps({"source": "rwmcp-ubuntu-watchdog", **fields}, separators=(",", ":"), sort_keys=True), flush=True)


def user_bus_env() -> dict[str, str]:
    env = dict(os.environ)
    runtime = Path(f"/run/user/{os.getuid()}")
    if runtime.is_dir() and (runtime / "bus").exists():
        env.setdefault("XDG_RUNTIME_DIR", str(runtime))
        env.setdefault("DBUS_SESSION_BUS_ADDRESS", f"unix:path={runtime}/bus")
    return env


def systemctl(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["systemctl", "--user", *args], capture_output=True, text=True,
                          timeout=8, check=False, env=user_bus_env())


def http_json(path: str) -> dict:
    with urllib.request.urlopen(f"http://127.0.0.1:8683{path}", timeout=HEALTH_TIMEOUT) as response:
        if response.status != 200:
            raise ValueError("bad HTTP status")
        obj = json.load(response)
        if not isinstance(obj, dict):
            raise ValueError("not JSON object")
        return obj


def tunnel_health_base() -> str:
    file = DATA / "runtime/openai-tunnel/health-url"
    url = file.read_text(encoding="utf-8").strip()
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or parsed.path not in ("", "/") or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("invalid loopback tunnel health URL")
    if not parsed.port or not 1024 <= parsed.port <= 65535:
        raise ValueError("invalid tunnel health port")
    return f"http://127.0.0.1:{parsed.port}"


def tunnel_ready() -> bool:
    with urllib.request.urlopen(tunnel_health_base() + "/readyz", timeout=HEALTH_TIMEOUT) as response:
        if response.status != 200:
            return False
        return response.read(64).strip() == b"ready"


def current_version() -> str:
    package = json.loads((DATA / "current/package.json").read_text(encoding="utf-8"))
    value = package.get("version")
    if not isinstance(value, str) or not value or len(value) > 48:
        raise ValueError("invalid installed version")
    return value


def probe() -> tuple[bool, str]:
    try:
        if systemctl("is-active", SERVICE).stdout.strip() != "active":
            return False, "systemd_inactive"
    except (OSError, subprocess.TimeoutExpired):
        return False, "systemd_unavailable"
    try:
        status = http_json("/healthz")
        if status.get("ok") is not True or status.get("version") != current_version():
            return False, "mcp_health_or_version"
    except (OSError, ValueError, KeyError, TimeoutError, urllib.error.URLError, json.JSONDecodeError):
        return False, "mcp_health_unreachable"
    try:
        if not tunnel_ready():
            return False, "tunnel_not_ready"
    except (OSError, ValueError, TimeoutError, urllib.error.URLError):
        return False, "tunnel_unreachable"
    return True, "healthy"


def safe_state(now: float) -> dict:
    try:
        d = json.loads(STATE.read_text(encoding="utf-8"))
        if not isinstance(d, dict) or d.get("version") != 1:
            raise ValueError("invalid state version")
        count = d.get("consecutiveFailures", 0)
        last = d.get("lastRestart", 0)
        rolling = d.get("restartTimes", [])
        if not isinstance(count, int) or not 0 <= count <= 1000 or not isinstance(last, (int, float)) or not isinstance(rolling, list):
            raise ValueError("invalid state fields")
        if any(not isinstance(x, (int, float)) for x in rolling):
            raise ValueError("invalid restart timestamps")
        d["restartTimes"] = [t for t in rolling if now - 86400 < t <= now]
        return d
    except FileNotFoundError:
        return {"version": 1, "consecutiveFailures": 0, "lastRestart": 0, "restartTimes": []}
    except (ValueError, TypeError, OSError, json.JSONDecodeError) as exc:
        # Corrupt or inaccessible state must not authorize a restart.
        raise RuntimeError("watchdog state unavailable") from exc


def save_state(value: dict) -> None:
    STATE.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if STATE.parent.is_symlink():
        raise RuntimeError("state directory is symlink")
    fd, tmp = tempfile.mkstemp(prefix=".ubuntu-watchdog-", dir=STATE.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, STATE)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def active_interlocks() -> tuple[bool, str]:
    if (CONFIG / "ubuntu-watchdog.hold").exists():
        return True, "owner_hold"
    file = CONFIG / "runtime/work-session-interlocks.json"
    try:
        d = json.loads(file.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return False, "no_interlock_file"
    except (OSError, ValueError, json.JSONDecodeError):
        return True, "interlock_unreadable"
    if not isinstance(d, dict) or d.get("version") != 1 or not isinstance(d.get("records"), list):
        return True, "interlock_invalid"
    for record in d["records"]:
        if not isinstance(record, dict):
            return True, "interlock_invalid_record"
        pid = record.get("pid")
        if not isinstance(pid, int):
            return True, "interlock_invalid_pid"
        if pid_alive(pid):
            return True, "active_work_session"
    return False, "no_active_interlocks"


def should_restart(state: dict, now: float) -> tuple[bool, str]:
    if state["consecutiveFailures"] < FAILURE_THRESHOLD:
        return False, "failure_threshold"
    if now - state["lastRestart"] < COOLDOWN_SECONDS:
        return False, "cooldown"
    if len(state["restartTimes"]) >= MAX_RESTARTS_PER_DAY:
        return False, "daily_restart_budget"
    busy, reason = active_interlocks()
    if busy:
        return False, reason
    return True, "restart_allowed"


def run(recover: bool) -> int:
    now = time.time()
    try:
        state = safe_state(now)
        ok, reason = probe()
        state["lastCheck"] = now
        state["lastReason"] = reason
        state["consecutiveFailures"] = 0 if ok else min(1000, state["consecutiveFailures"] + 1)
        if ok:
            state["lastHealthy"] = now
            save_state(state)
            emit(status="healthy", version=current_version(), failedChecks=0)
            return 0
        if not recover:
            save_state(state)
            emit(status="unhealthy", reason=reason, failedChecks=state["consecutiveFailures"], action="observe_only")
            return 1
        allowed, why = should_restart(state, now)
        if not allowed:
            save_state(state)
            emit(status="unhealthy", reason=reason, failedChecks=state["consecutiveFailures"], action="deferred", gate=why)
            # Timer is running as designed; the unhealthy observation remains in journal.
            return 0
        # Record restart budget BEFORE issuing any action, even on failure.
        state["lastRestart"] = now
        state["restartTimes"].append(now)
        state["consecutiveFailures"] = 0
        save_state(state)
        result = systemctl("restart", SERVICE)
        if result.returncode:
            emit(status="unhealthy", reason=reason, action="restart_failed", code=result.returncode)
            return 2
        emit(status="recovering", reason=reason, action="mcp_service_restart", restarts24h=len(state["restartTimes"]))
        return 0
    except Exception as exc:
        emit(status="watchdog_error", reason=type(exc).__name__)
        return 2


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true", help="Check without restarting.")
    mode.add_argument("--self-heal", action="store_true", help="Bounded restart on repeated failures.")
    args = parser.parse_args()
    sys.exit(run(recover=args.self_heal))
