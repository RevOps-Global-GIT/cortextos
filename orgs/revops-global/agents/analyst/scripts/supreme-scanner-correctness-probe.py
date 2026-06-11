#!/usr/bin/env python3
"""
supreme-scanner-correctness-probe.py

Correctness probe for the Supreme Slack scanner (supreme-slack-scanner.py).

WHY THIS EXISTS
---------------
The hub-QA dogfood CHECK 4 for /app/supreme-outstanding validates *freshness only*
(the scanner ran recently) — not whether the scanner is actually FINDING the items
it should. On 2026-06-11 Greg found a masking bug (dev PR #805): a non-actionable
follow-up (bare URL, "thanks") posted after a real question caused the scanner to
report 0 outstanding while a genuine unanswered question existed. It lived undetected
for days because freshness was green the whole time.

This probe is an INDEPENDENT oracle. It does NOT reuse the scanner's actionable
heuristic (is_question / action-verb) — that filter is exactly where the bug lived,
so reusing it would re-import the blind spot. Instead it counts *structural
candidates*: non-Greg, non-subtype messages sent after Greg's last reply in each
DM/conversation, plus @-mentions of Greg, within the same window the scanner used.

ALERT CONDITION (per experiment 16b41f78):
    items_scanned == 0  AND  slack_messages > 0
i.e. the scanner surfaced nothing, yet there is Greg-directed Slack activity that
nobody has replied to. That is the masking-bug signature.

  - items_scanned  = the scanner's reported outstanding total (total_count from its
                     latest snapshot — the surface under test)
  - slack_messages = independent structural-candidate count computed here

On Slack/API failure or a missing/stale scanner snapshot the probe DEFERS (no
alert) rather than risk a false alarm on infra noise — mirrors the dogfood harness's
defensive style.

Pure decision/counting helpers (should_alert, count_unanswered_candidates) carry no
I/O so the replay test (test_supreme_scanner_correctness_probe.py) can exercise the
exact Mari masking scenario deterministically with fixtures.

Usage:
    python3 scripts/supreme-scanner-correctness-probe.py            # live, alerts orchestrator
    python3 scripts/supreme-scanner-correctness-probe.py --dry-run  # compute + print, no alert
    python3 scripts/supreme-scanner-correctness-probe.py --since-hours 48 --json
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

SCRIPT_DIR = Path(__file__).resolve().parent
SCANNER_PATH = SCRIPT_DIR / "supreme-slack-scanner.py"
LATEST_JSON = SCRIPT_DIR.parent / "output" / "supreme-outstanding-latest.json"

# The scanner cron uses DEFAULT_SINCE_HOURS=48; match it so the windows align.
DEFAULT_SINCE_HOURS = 48
# Snapshot older than this many hours can't be meaningfully compared to a fresh
# Slack window — defer instead of comparing across mismatched windows.
SNAPSHOT_MAX_AGE_HOURS = 12


def _load_scanner():
    """Load the hyphenated scanner module so we can reuse its Slack auth + search."""
    spec = importlib.util.spec_from_file_location("supreme_slack_scanner", SCANNER_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load scanner module from {SCANNER_PATH}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# -- pure helpers (no I/O — unit-testable) ------------------------------------

def count_unanswered_candidates(messages: List[Dict[str, Any]], greg_user_id: str) -> int:
    """Count non-Greg, non-subtype messages in one conversation that were sent after
    Greg's last message — WITHOUT the actionable/question gate.

    This is the independent oracle. The scanner's bug was that its actionable filter
    (run only on the newest message) dropped a real question when a non-actionable
    follow-up arrived after it. By counting every post-reply candidate regardless of
    phrasing, this oracle still sees the activity the scanner's filter discarded.
    """
    greg_last_ts = max(
        (float(m.get("ts") or 0) for m in messages if m.get("user") == greg_user_id),
        default=0.0,
    )
    return sum(
        1
        for m in messages
        if m.get("user")
        and m.get("user") != greg_user_id
        and not m.get("subtype")
        and float(m.get("ts") or 0) > greg_last_ts
    )


def should_alert(items_scanned: int, slack_messages: int) -> bool:
    """The masking-bug signature: scanner found nothing but Slack has unanswered
    Greg-directed activity in the same window."""
    return items_scanned == 0 and slack_messages > 0


# -- I/O -----------------------------------------------------------------------

def read_scanner_output() -> Optional[Tuple[int, datetime]]:
    """Return (items_scanned, generated_at) from the scanner's latest snapshot, or None."""
    if not LATEST_JSON.exists():
        return None
    try:
        d = json.loads(LATEST_JSON.read_text())
    except (json.JSONDecodeError, OSError):
        return None
    total = d.get("total_count")
    gen = d.get("generated_at")
    if total is None or not gen:
        return None
    try:
        generated_at = datetime.fromisoformat(str(gen).replace("Z", "+00:00"))
    except ValueError:
        return None
    return int(total), generated_at


def collect_slack_candidates(scanner, token: str, since_seconds: int) -> Optional[Dict[str, int]]:
    """Independently count Greg-directed unanswered activity in the window via Slack
    search. Returns None on Slack failure (caller defers — never alerts on infra noise).
    """
    greg = scanner.GREG_USER_ID

    # DM path: group search.messages(is:dm) results by channel, count post-reply candidates.
    dm_msgs = scanner.slack_search_dms(token, since_seconds)
    dm_by_channel: Dict[str, List[Dict[str, Any]]] = {}
    for m in dm_msgs:
        ch_obj = m.get("channel") or {}
        ch_id = ch_obj.get("id", "") if isinstance(ch_obj, dict) else str(ch_obj)
        if ch_id:
            dm_by_channel.setdefault(ch_id, []).append(m)
    dm_candidates = sum(
        count_unanswered_candidates(msgs, greg) for msgs in dm_by_channel.values()
    )

    # Mention path: @-mentions of Greg by someone other than Greg in the window.
    # Each is inherently Greg-directed activity; thread-reply state is intentionally
    # NOT fetched here to keep the oracle cheap and independent of the scanner's
    # reply-walking logic.
    mention_msgs = scanner.slack_search_mentions(token, since_seconds)
    mention_candidates = sum(
        1
        for m in mention_msgs
        if m.get("user")
        and m.get("user") != greg
        and not m.get("subtype")
    )

    return {
        "dm_candidates": dm_candidates,
        "mention_candidates": mention_candidates,
        "slack_messages": dm_candidates + mention_candidates,
    }


def alert_orchestrator(items_scanned: int, counts: Dict[str, int], window_hours: int) -> None:
    msg = (
        f"Supreme-scanner correctness probe ALERT — possible masking bug. "
        f"Scanner reported items_scanned={items_scanned} for the last "
        f"{window_hours}h window, but Slack shows {counts['slack_messages']} "
        f"unanswered Greg-directed message(s) "
        f"(DM={counts['dm_candidates']}, mentions={counts['mention_candidates']}). "
        f"This is the PR #805 bug class — a real item may be masked by a "
        f"non-actionable follow-up. Investigate supreme-slack-scanner.py output."
    )
    subprocess.run(
        ["cortextos", "bus", "send-message", "orchestrator", "high", msg],
        check=False,
    )
    subprocess.run(
        [
            "cortextos", "bus", "log-event", "action", "scanner_correctness_alert", "warning",
            "--meta",
            json.dumps({
                "items_scanned": items_scanned,
                "slack_messages": counts["slack_messages"],
                "dm_candidates": counts["dm_candidates"],
                "mention_candidates": counts["mention_candidates"],
                "window_hours": window_hours,
            }),
        ],
        check=False,
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--since-hours", type=int, default=DEFAULT_SINCE_HOURS)
    ap.add_argument("--dry-run", action="store_true",
                    help="Compute and print the result but do not alert the orchestrator")
    ap.add_argument("--json", action="store_true", help="Emit machine-readable JSON only")
    args = ap.parse_args()

    checked_at = datetime.now(timezone.utc).isoformat()

    def emit(result: Dict[str, Any]) -> None:
        result["checked_at"] = checked_at
        result["window_hours"] = args.since_hours
        if args.json:
            print(json.dumps(result))
        else:
            print(json.dumps(result, indent=2))

    scanner = _load_scanner()
    env = scanner.load_env()
    missing = [k for k in scanner.REQUIRED_ENV_KEYS if not env.get(k)]
    if missing:
        emit({"status": "deferred", "reason": f"missing env: {','.join(missing)}"})
        return 0

    scan_out = read_scanner_output()
    if scan_out is None:
        emit({"status": "deferred", "reason": "scanner snapshot missing or unreadable"})
        return 0
    items_scanned, generated_at = scan_out

    age_hours = (datetime.now(timezone.utc) - generated_at).total_seconds() / 3600
    if age_hours > SNAPSHOT_MAX_AGE_HOURS:
        emit({
            "status": "deferred",
            "reason": f"scanner snapshot stale ({age_hours:.1f}h > {SNAPSHOT_MAX_AGE_HOURS}h)",
            "items_scanned": items_scanned,
        })
        return 0

    try:
        token = scanner.get_token(env)
    except Exception as e:  # noqa: BLE001 — token/refresh failure must defer, not alert
        emit({"status": "deferred", "reason": f"slack token unavailable: {e}"})
        return 0

    try:
        counts = collect_slack_candidates(scanner, token, args.since_hours * 3600)
    except scanner.ScanRateLimited as e:
        emit({"status": "deferred", "reason": f"slack rate limited: {e}"})
        return 0
    if counts is None:
        emit({"status": "deferred", "reason": "slack search failed"})
        return 0

    alert = should_alert(items_scanned, counts["slack_messages"])
    if alert and not args.dry_run:
        alert_orchestrator(items_scanned, counts, args.since_hours)

    emit({
        "status": "alert" if alert else "ok",
        "items_scanned": items_scanned,
        "slack_messages": counts["slack_messages"],
        "dm_candidates": counts["dm_candidates"],
        "mention_candidates": counts["mention_candidates"],
        "snapshot_age_hours": round(age_hours, 2),
        "alerted": bool(alert and not args.dry_run),
    })
    return 0


if __name__ == "__main__":
    sys.exit(main())
