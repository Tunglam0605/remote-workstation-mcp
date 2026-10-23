"""Portable regression coverage for the Ubuntu watchdog; no services restarted."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SRC = Path(__file__).resolve().parents[1] / "scripts/rwmcp-ubuntu-watchdog.py"
SPEC = importlib.util.spec_from_file_location("rwmcp_watchdog", SRC)
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)


class WatchdogTests(unittest.TestCase):
    def test_probe_requires_active_service_health_version_and_ready_tunnel(self):
        with patch.object(mod, "systemctl") as svc, patch.object(mod, "http_json") as http, \
             patch.object(mod, "current_version", return_value="0.67.2-ubuntu.1"), \
             patch.object(mod, "tunnel_ready", return_value=True):
            svc.return_value.stdout = "active\n"
            http.return_value = {"ok": True, "version": "0.67.2-ubuntu.1"}
            self.assertEqual(mod.probe(), (True, "healthy"))
            http.return_value = {"ok": True, "version": "other"}
            self.assertEqual(mod.probe(), (False, "mcp_health_or_version"))
            svc.return_value.stdout = "inactive\n"
            self.assertEqual(mod.probe(), (False, "systemd_inactive"))

    def test_failures_must_be_consecutive(self):
        s = {"consecutiveFailures": 2, "lastRestart": 0, "restartTimes": []}
        with patch.object(mod, "active_interlocks", return_value=(False, "ok")):
            self.assertEqual(mod.should_restart(s, 100000), (False, "failure_threshold"))
            s["consecutiveFailures"] = 3
            self.assertEqual(mod.should_restart(s, 100000), (True, "restart_allowed"))

    def test_cooldown_and_daily_budget(self):
        s = {"consecutiveFailures": 3, "lastRestart": 95000, "restartTimes": []}
        with patch.object(mod, "active_interlocks", return_value=(False, "ok")):
            self.assertEqual(mod.should_restart(s, 95500), (False, "cooldown"))
            s["restartTimes"] = [1000, 1001, 1002]
            self.assertEqual(mod.should_restart(s, 100000), (False, "daily_restart_budget"))

    def test_work_session_interlock_blocks_restart(self):
        s = {"consecutiveFailures": 3, "lastRestart": 0, "restartTimes": []}
        with patch.object(mod, "active_interlocks", return_value=(True, "active_work_session")):
            self.assertEqual(mod.should_restart(s, 100000), (False, "active_work_session"))

    def test_atomic_private_state_and_rolling_budget(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "nested" / "watchdog.json"
            with patch.object(mod, "STATE", file):
                before = mod.safe_state(100000)
                self.assertEqual(before["consecutiveFailures"], 0)
                before["consecutiveFailures"] = 3
                before["restartTimes"] = [500, 95000, 99000]
                mod.save_state(before)
                self.assertEqual(file.stat().st_mode & 0o777, 0o600)
                after = mod.safe_state(100000)
                self.assertEqual(after["restartTimes"], [95000, 99000])
                self.assertEqual(after["consecutiveFailures"], 3)

    def test_corrupt_state_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "state.json"
            file.write_text("{broken")
            with patch.object(mod, "STATE", file):
                with self.assertRaises(RuntimeError):
                    mod.safe_state(100000)

    def test_tunnel_url_requires_real_loopback(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "runtime/openai-tunnel/health-url"
            path.parent.mkdir(parents=True)
            with patch.object(mod, "DATA", root):
                path.write_text("http://127.0.0.1:45678")
                self.assertEqual(mod.tunnel_health_base(), "http://127.0.0.1:45678")
                for invalid in ("http://evil.example:45678", "https://127.0.0.1:45678",
                                "http://127.0.0.1:45678@evil.example", "http://127.0.0.1:45678/redirect"):
                    path.write_text(invalid)
                    with self.assertRaises(ValueError):
                        mod.tunnel_health_base()


    def test_owner_hold_blocks_self_healing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "ubuntu-watchdog.hold").write_text("paused")
            with patch.object(mod, "CONFIG", root):
                self.assertEqual(mod.active_interlocks(), (True, "owner_hold"))

    def test_three_bad_ticks_request_exactly_one_restart_without_touching_machine(self):
        with tempfile.TemporaryDirectory() as directory:
            state_file = Path(directory) / "watchdog.json"
            with patch.object(mod, "STATE", state_file), \
                 patch.object(mod, "probe", return_value=(False, "mcp_health_unreachable")), \
                 patch.object(mod, "active_interlocks", return_value=(False, "ok")), \
                 patch.object(mod, "systemctl") as service:
                service.return_value.returncode = 0
                self.assertEqual(mod.run(True), 0)
                self.assertEqual(mod.run(True), 0)
                self.assertEqual(service.call_count, 0)
                self.assertEqual(mod.run(True), 0)
                self.assertEqual(service.call_count, 1)
                self.assertEqual(service.call_args.args, ("restart", mod.SERVICE))
                self.assertEqual(mod.run(True), 0)  # cooldown/threshold prevents another restart
                self.assertEqual(service.call_count, 1)



if __name__ == "__main__":
    unittest.main()
