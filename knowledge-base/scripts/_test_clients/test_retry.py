"""Behavioral tests for mmrag._retry_generate_content.

Run from knowledge-base/scripts:

    python -m _test_clients.test_retry

Exits 0 on all-pass, 1 on any failure. Four scenarios:

  1. transient_then_success: 503 → 200 → returns response, no raise
  2. all_exhausted: 503 → 503 → 503 → raises last APIError
  3. fail_fast_nontransient: 403 (with '503' in body) → raises immediately;
     proves the predicate is structural (.code / .status), not textual.
  4. timeout_then_success: simulated hang → 200 → returns response, no raise;
     proves call_timeout_secs aborts a stalled API call and retries.

backoffs is passed as (0, 0, 0) so tests run in milliseconds.
"""

import os
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
PARENT = os.path.dirname(HERE)
if PARENT not in sys.path:
    sys.path.insert(0, PARENT)

import mmrag
from _test_clients import fault_injection


class _HangThenSuccessModels:
    """First call blocks for `hang_secs`, subsequent calls return immediately."""
    def __init__(self, hang_secs=10, success_text="hung then recovered"):
        self._hang_secs = hang_secs
        self._call_count = 0
        self._success_text = success_text

    def generate_content(self, model=None, contents=None, **kwargs):
        self._call_count += 1
        if self._call_count == 1:
            time.sleep(self._hang_secs)
        return fault_injection._StubResponse(self._success_text)


class _HangingClient:
    def __init__(self, hang_secs=10, success_text="hung then recovered"):
        self.models = _HangThenSuccessModels(hang_secs=hang_secs, success_text=success_text)


FAILURES = []


def _check(label, cond, detail=""):
    if cond:
        print(f"  PASS  {label}")
    else:
        print(f"  FAIL  {label}: {detail}")
        FAILURES.append(label)


def test_transient_then_success():
    print("\n[test 1/3] transient_then_success: 503 -> 200")
    client = fault_injection.FaultInjectionClient(
        fault_injection._parse_script("503:gemini busy,200:hello world")
    )
    response = mmrag._retry_generate_content(
        client, model="x", contents=["x"], backoffs=(0, 0, 0)
    )
    _check("returns response after one transient", response is not None)
    _check(
        "response.text matches scripted message",
        getattr(response, "text", None) == "hello world",
        detail=f"got {getattr(response, 'text', None)!r}",
    )
    _check(
        "consumed exactly 2 attempts",
        client.models._index == 2,
        detail=f"got {client.models._index}",
    )


def test_all_exhausted():
    print("\n[test 2/3] all_exhausted: 503 -> 503 -> 503 -> re-raise")
    client = fault_injection.FaultInjectionClient(
        fault_injection._parse_script("503,503,503")
    )
    raised = None
    try:
        mmrag._retry_generate_content(
            client, model="x", contents=["x"], backoffs=(0, 0, 0)
        )
    except Exception as e:
        raised = e
    _check("raises after all attempts exhausted", raised is not None)
    if raised is not None:
        _check("raised.code is 503", getattr(raised, "code", None) == 503)
        _check(
            "raised.status is UNAVAILABLE",
            getattr(raised, "status", None) == "UNAVAILABLE",
        )
    _check(
        "consumed exactly 3 attempts",
        client.models._index == 3,
        detail=f"got {client.models._index}",
    )


def test_fail_fast_nontransient():
    print("\n[test 3/3] fail_fast_nontransient: 403 (with '503' in body) -> raises immediately")
    client = fault_injection.FaultInjectionClient(
        fault_injection._parse_script(
            "403:Permission denied for resource ID 503-pseudo,200:should not reach"
        )
    )
    raised = None
    try:
        mmrag._retry_generate_content(
            client, model="x", contents=["x"], backoffs=(0, 0, 0)
        )
    except Exception as e:
        raised = e
    _check("raises immediately on non-transient", raised is not None)
    if raised is not None:
        _check("raised.code is 403", getattr(raised, "code", None) == 403)
        _check(
            "raised.status is PERMISSION_DENIED",
            getattr(raised, "status", None) == "PERMISSION_DENIED",
        )
    _check(
        "did NOT consume the second scripted attempt (predicate is structural, not textual)",
        client.models._index == 1,
        detail=f"got {client.models._index}",
    )


def test_timeout_then_success():
    print("\n[test 4/4] timeout_then_success: hang (>timeout) -> 200")
    # First generate_content call sleeps 10s; we set call_timeout_secs=0.1
    # so it times out and retries; second call returns immediately.
    client = _HangingClient(hang_secs=10, success_text="recovered after timeout")
    response = mmrag._retry_generate_content(
        client, model="x", contents=["x"], backoffs=(0, 0, 0), call_timeout_secs=0.1
    )
    _check("returns response after one timeout", response is not None)
    _check(
        "response.text matches success text",
        getattr(response, "text", None) == "recovered after timeout",
        detail=f"got {getattr(response, 'text', None)!r}",
    )
    _check(
        "consumed exactly 2 call attempts",
        client.models._call_count == 2,
        detail=f"got {client.models._call_count}",
    )


if __name__ == "__main__":
    test_transient_then_success()
    test_all_exhausted()
    test_fail_fast_nontransient()
    test_timeout_then_success()
    print()
    if FAILURES:
        print(f"FAILED: {len(FAILURES)} assertion(s)")
        for f in FAILURES:
            print(f"  - {f}")
        sys.exit(1)
    print(f"ALL PASS (4 scenarios)")
    sys.exit(0)
