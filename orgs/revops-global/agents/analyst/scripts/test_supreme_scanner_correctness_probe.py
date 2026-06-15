#!/usr/bin/env python3
"""Unit/replay tests for supreme-scanner-correctness-probe.py.

The headline test (test_replay_mari_masking_bug) replays the exact 2026-06-11
masking scenario from dev PR #805 and asserts the probe WOULD have alerted while
the buggy scanner reported 0 outstanding — i.e. it catches that class of bug.

Run: python3 orgs/revops-global/agents/analyst/scripts/test_supreme_scanner_correctness_probe.py
Exits 0 on success, 1 on first failure.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

PROBE_PATH = Path(__file__).resolve().parent / "supreme-scanner-correctness-probe.py"
spec = importlib.util.spec_from_file_location("supreme_scanner_correctness_probe", PROBE_PATH)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)

SCANNER_PATH = Path(__file__).resolve().parent / "supreme-slack-scanner.py"
sspec = importlib.util.spec_from_file_location("supreme_slack_scanner", SCANNER_PATH)
scanner = importlib.util.module_from_spec(sspec)
sspec.loader.exec_module(scanner)

GREG = scanner.GREG_USER_ID
MARI = "U0MARIMCM"


def msg(user: str, ts: str, text: str, subtype: str | None = None) -> dict:
    out = {"user": user, "ts": ts, "text": text}
    if subtype:
        out["subtype"] = subtype
    return out


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


# --- candidate-counting oracle ------------------------------------------------

def test_counts_post_reply_candidates() -> None:
    # Greg replied at ts=100, then two non-Greg messages arrived after.
    conv = [
        msg(GREG, "100.0", "thanks, looking now"),
        msg(MARI, "200.0", "is there anything else that was missed?"),
        msg(MARI, "300.0", "https://example.com/doc"),  # bare-URL follow-up
    ]
    n = probe.count_unanswered_candidates(conv, GREG)
    check("post-reply candidates counts BOTH the question and the bare-URL follow-up",
          n == 2, f"got {n}")


def test_answered_dm_has_no_candidates() -> None:
    # Greg's reply is the newest message → nothing awaits him.
    conv = [
        msg(MARI, "100.0", "can you review this?"),
        msg(GREG, "200.0", "done"),
    ]
    n = probe.count_unanswered_candidates(conv, GREG)
    check("answered DM (Greg replied last) yields 0 candidates", n == 0, f"got {n}")


def test_greg_own_and_subtype_excluded() -> None:
    conv = [
        msg(GREG, "100.0", "hi"),
        msg(MARI, "200.0", "ping", subtype="channel_join"),  # subtype excluded
        msg(GREG, "300.0", "also me"),                        # Greg excluded
    ]
    n = probe.count_unanswered_candidates(conv, GREG)
    check("subtype messages and Greg's own messages are excluded", n == 0, f"got {n}")


# --- alert decision -----------------------------------------------------------

def test_should_alert_masking_signature() -> None:
    check("alert when scanner=0 and slack activity>0",
          probe.should_alert_masking(0, 2) is True)


def test_no_alert_when_scanner_found_items() -> None:
    check("no alert when scanner surfaced >=1 item (fixed scanner)",
          probe.should_alert_masking(1, 2) is False)


def test_no_alert_when_no_activity() -> None:
    check("no alert when there is no Slack activity",
          probe.should_alert_masking(0, 0) is False)


# --- end-to-end replay of the historical masking bug --------------------------

def test_replay_mari_masking_bug() -> None:
    """Replay the exact 2026-06-11 scenario (PR #805 RCA).

    Mari asks a question at 23:30Z, then posts a bare-URL follow-up at 23:55Z.
    Greg never replied. The OLD scanner kept only the NEWEST message per DM and
    required IT to be actionable → the bare URL masked the question → outstanding=0.

    The probe's independent oracle counts post-reply candidates (2), so with the
    buggy scanner output (items_scanned=0) it ALERTS — catching the bug. With the
    FIXED scanner (items_scanned=1) it stays quiet.
    """
    conv = [
        msg(MARI, "1781134219.852669", "is there anything else that was missed? Is this accurate now?"),
        msg(MARI, "1781135719.000000", "https://example.com/updated-doc"),  # bare-URL follow-up, newest
    ]
    slack_messages = probe.count_unanswered_candidates(conv, GREG)

    # Reproduce the OLD buggy scanner decision: newest-only + actionable gate.
    newest = max(conv, key=lambda m: float(m["ts"]))
    old_outstanding = 1 if scanner.is_actionable_text(newest.get("text") or "") else 0

    # Reproduce the FIXED scanner decision via the shipped helper.
    fixed_flag = scanner.oldest_unanswered_actionable(conv)
    fixed_outstanding = 1 if fixed_flag is not None else 0

    check("replay: independent oracle sees the activity (candidates=2)",
          slack_messages == 2, f"got {slack_messages}")
    check("replay: OLD buggy scanner reported 0 outstanding (the masking bug)",
          old_outstanding == 0, f"got {old_outstanding}")
    check("replay: probe ALERTS on the buggy scanner output (bug caught)",
          probe.should_alert_masking(old_outstanding, slack_messages) is True)
    check("replay: FIXED scanner reports 1 outstanding",
          fixed_outstanding == 1, f"got {fixed_outstanding}")
    check("replay: probe stays quiet once scanner is fixed (no false alarm)",
          probe.should_alert_masking(fixed_outstanding, slack_messages) is False)


# --- timing-gap regression: messages newer than the snapshot must not alert ---

def test_max_ts_gates_post_snapshot_messages() -> None:
    """A Greg-directed message that arrives AFTER the scanner snapshot must not be
    counted — the scan could not have seen it, so counting it is a timing
    false-positive (the next scan will catch it). Regression for the 2026-06-15
    #bmp-medical false alarm: snapshot was 2.7h old, the mention 1.4h old.
    """
    # Snapshot at ts=200; a Greg-directed msg arrives at ts=300 (after the scan).
    conv = [
        msg(GREG, "100.0", "ok"),
        msg(MARI, "300.0", "did you see the BMP results?"),
    ]
    ungated = probe.count_unanswered_candidates(conv, GREG)
    check("without max_ts the post-snapshot message counts (would false-alarm)",
          ungated == 1, f"got {ungated}")
    gated = probe.count_unanswered_candidates(conv, GREG, max_ts=200.0)
    check("max_ts gates out messages newer than the snapshot (no timing false-positive)",
          gated == 0, f"got {gated}")
    # A message at/before the snapshot still counts — genuine masking still caught.
    conv2 = [msg(GREG, "100.0", "ok"), msg(MARI, "150.0", "still waiting on you?")]
    still = probe.count_unanswered_candidates(conv2, GREG, max_ts=200.0)
    check("max_ts still counts messages the scan should have seen (real masking caught)",
          still == 1, f"got {still}")


def main() -> int:
    test_counts_post_reply_candidates()
    test_answered_dm_has_no_candidates()
    test_greg_own_and_subtype_excluded()
    test_should_alert_masking_signature()
    test_no_alert_when_scanner_found_items()
    test_no_alert_when_no_activity()
    test_replay_mari_masking_bug()
    test_max_ts_gates_post_snapshot_messages()
    print()
    if _failures:
        print(f"{_failures} test(s) FAILED")
        return 1
    print("All tests passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
