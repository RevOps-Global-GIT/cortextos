#!/usr/bin/env python3
"""Unit tests for signal-ratio-orch-events.py compute_signal_ratio.

Run: python3 orgs/revops-global/agents/analyst/scripts/test_signal_ratio_orch_events.py
Exits 0 on success, 1 on first failure.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

MOD_PATH = Path(__file__).resolve().parent / "signal-ratio-orch-events.py"
spec = importlib.util.spec_from_file_location("signal_ratio_orch_events", MOD_PATH)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

_failures = 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global _failures
    status = "PASS" if cond else "FAIL"
    line = f"[{status}] {name}"
    if detail and not cond:
        line += f" — {detail}"
    print(line)
    if not cond:
        _failures += 1


def test_empty_window_is_none() -> None:
    ratio, signal, total = m.compute_signal_ratio({})
    check("empty window -> ratio None, total 0", ratio is None and total == 0,
          f"got ratio={ratio} total={total}")


def test_heartbeat_is_noise() -> None:
    # 377 heartbeat + 623 signal across mixed types == real 24h shape
    counts = {"heartbeat": 377, "action": 345, "message": 80, "capability": 80,
              "error": 72, "agent_message": 27, "task": 14, "telegram_outbound": 3,
              "telegram_inbound": 2}
    ratio, signal, total = m.compute_signal_ratio(counts)
    check("total counted correctly", total == 1000, f"got {total}")
    check("signal excludes only heartbeat", signal == 623, f"got {signal}")
    check("ratio is 0.623", abs(ratio - 0.623) < 1e-9, f"got {ratio}")


def test_all_heartbeat_is_zero() -> None:
    ratio, signal, total = m.compute_signal_ratio({"heartbeat": 50})
    check("all-heartbeat window -> ratio 0.0", ratio == 0.0 and signal == 0,
          f"got ratio={ratio} signal={signal}")


def test_no_heartbeat_is_one() -> None:
    ratio, signal, total = m.compute_signal_ratio({"action": 10, "task": 5})
    check("no-heartbeat window -> ratio 1.0", ratio == 1.0 and signal == 15,
          f"got ratio={ratio} signal={signal}")


def test_unknown_types_count_as_signal() -> None:
    ratio, signal, total = m.compute_signal_ratio({"heartbeat": 1, "something_new": 1})
    check("unknown event_type counts as signal", signal == 1 and ratio == 0.5,
          f"got signal={signal} ratio={ratio}")


def main() -> int:
    test_empty_window_is_none()
    test_heartbeat_is_noise()
    test_all_heartbeat_is_zero()
    test_no_heartbeat_is_one()
    test_unknown_types_count_as_signal()
    print()
    if _failures:
        print(f"{_failures} test(s) FAILED")
        return 1
    print("All tests passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
