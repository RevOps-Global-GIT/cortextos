#!/usr/bin/env python3
"""
supreme-scanner-correctness-probe.py — recurring Slack-triage watchdog

Correctness probe for the Supreme Slack scanner (supreme-slack-scanner.py).
Runs every 4h (offset from scanner cron) as a durable daemon cron.

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

ALERT CONDITIONS
----------------
1. Masking bug (primary):
       items_scanned == 0  AND  slack_messages > 0
   Scanner surfaced nothing but Slack has unanswered Greg-directed activity.
   Alert includes evidence: sender, channel, age, text snippet per candidate.

2. Stale snapshot (secondary):
       snapshot_age_hours > SNAPSHOT_STALE_ALERT_HOURS (4h)
   The scanner has not written a fresh snapshot — possible cron failure.

On Slack/API failure or a missing/stale snapshot the probe DEFERS (no alert)
rather than false-alarm on infra noise.

Pure decision/counting helpers (should_alert_masking, count_unanswered_candidates)
carry no I/O so the replay test can exercise the Mari masking scenario with fixtures.

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
# Snapshot older than this can't be meaningfully compared to a fresh Slack window.
SNAPSHOT_MAX_AGE_HOURS = 12
# Secondary alert: scanner hasn't refreshed in this many hours (cron failure signal).
SNAPSHOT_STALE_ALERT_HOURS = 4
# Evidence cap per category to keep alert messages concise.
EVIDENCE_CAP = 4


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


def should_alert_masking(items_scanned: int, slack_messages: int) -> bool:
    """Masking-bug signature: scanner found nothing but Slack has unanswered activity."""
    return items_scanned == 0 and slack_messages > 0


def should_alert_stale(snapshot_age_hours: float) -> bool:
    """Stale-snapshot signature: scanner cron may have failed."""
    return snapshot_age_hours > SNAPSHOT_STALE_ALERT_HOURS


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


def _format_age(ts: float, now_ts: float) -> str:
    age_h = (now_ts - ts) / 3600
    return f"{int(age_h * 60)}m" if age_h < 1 else f"{age_h:.1f}h"


def collect_slack_candidates(
    scanner, token: str, since_seconds: int
) -> Optional[Dict[str, Any]]:
    """Count and collect Greg-directed unanswered Slack activity.
    Returns None on Slack failure (caller defers — never alerts on infra noise).
    Includes evidence list: up to EVIDENCE_CAP items per category for alert body.
    """
    greg = scanner.GREG_USER_ID
    now_ts = datetime.now(timezone.utc).timestamp()
    user_name = getattr(scanner, "user_name", lambda u: u)

    # DM path
    dm_msgs = scanner.slack_search_dms(token, since_seconds)
    dm_by_channel: Dict[str, List[Dict[str, Any]]] = {}
    for m in dm_msgs:
        ch_obj = m.get("channel") or {}
        ch_id = ch_obj.get("id", "") if isinstance(ch_obj, dict) else str(ch_obj)
        if ch_id:
            dm_by_channel.setdefault(ch_id, []).append(m)

    dm_candidates = 0
    dm_evidence: List[str] = []
    for ch_msgs in dm_by_channel.values():
        greg_last_ts = max(
            (float(m.get("ts") or 0) for m in ch_msgs if m.get("user") == greg),
            default=0.0,
        )
        candidates = [
            m for m in ch_msgs
            if m.get("user") and m.get("user") != greg
            and not m.get("subtype")
            and float(m.get("ts") or 0) > greg_last_ts
        ]
        dm_candidates += len(candidates)
        if candidates and len(dm_evidence) < EVIDENCE_CAP:
            oldest = min(candidates, key=lambda m: float(m.get("ts") or 0))
            sender = user_name(oldest.get("user") or "?")
            age = _format_age(float(oldest.get("ts") or 0), now_ts)
            text = (oldest.get("text") or "")[:80].replace("\n", " ")
            dm_evidence.append(f"DM/{sender} [{age}]: {text}")

    # Mention path — inherently Greg-directed; thread-reply state NOT fetched
    # to keep the oracle cheap and independent of the scanner's reply-walking logic.
    mention_msgs = scanner.slack_search_mentions(token, since_seconds)
    mention_candidates = 0
    mention_evidence: List[str] = []
    seen_keys: set = set()
    for m in mention_msgs:
        if m.get("user") and m.get("user") != greg and not m.get("subtype"):
            ch_obj = m.get("channel") or {}
            ch_name = ch_obj.get("name", "?") if isinstance(ch_obj, dict) else str(ch_obj)
            sender = user_name(m.get("user") or "?")
            key = (ch_name, sender, (m.get("text") or "")[:30])
            if key not in seen_keys:
                seen_keys.add(key)
                mention_candidates += 1
                if len(mention_evidence) < EVIDENCE_CAP:
                    age = _format_age(float(m.get("ts") or 0), now_ts)
                    text = (m.get("text") or "")[:80].replace("\n", " ")
                    mention_evidence.append(f"#{ch_name}/{sender} [{age}]: {text}")

    return {
        "dm_candidates": dm_candidates,
        "mention_candidates": mention_candidates,
        "slack_messages": dm_candidates + mention_candidates,
        "evidence": dm_evidence + mention_evidence,
    }


def alert_orchestrator(
    alert_type: str,
    items_scanned: int,
    counts: Dict[str, Any],
    snapshot_age_hours: float,
    window_hours: int,
    dry_run: bool,
) -> None:
    if alert_type == "masking":
        evidence_lines = "\n".join(f"  * {e}" for e in counts.get("evidence", []))
        msg = (
            f"Supreme-scanner correctness probe ALERT (masking). "
            f"Scanner items_scanned={items_scanned} but Slack has "
            f"{counts['slack_messages']} unanswered Greg-directed msgs "
            f"(DM={counts['dm_candidates']}, mentions={counts['mention_candidates']}) "
            f"in {window_hours}h window. PR #805 bug class.\n"
            f"Evidence:\n{evidence_lines if evidence_lines else '  (none captured)'}\n"
            f"Fix target: supreme-slack-scanner.py oldest_unanswered_actionable()."
        )
    else:  # stale
        msg = (
            f"Supreme-scanner correctness probe ALERT (stale snapshot). "
            f"Snapshot is {snapshot_age_hours:.1f}h old (threshold {SNAPSHOT_STALE_ALERT_HOURS}h). "
            f"Scanner cron may have failed. "
            f"Check daemon cron supreme-scanner-triage + "
            f"analyst/output/supreme-outstanding-latest.json."
        )

    if not dry_run:
        subprocess.run(
            ["cortextos", "bus", "send-message", "orchestrator", "high", msg],
            check=False,
        )
    subprocess.run(
        [
            "cortextos", "bus", "log-event", "action", "scanner_correctness_alert", "warning",
            "--meta",
            json.dumps({
                "alert_type": alert_type,
                "items_scanned": items_scanned,
                "slack_messages": counts.get("slack_messages", 0),
                "dm_candidates": counts.get("dm_candidates", 0),
                "mention_candidates": counts.get("mention_candidates", 0),
                "snapshot_age_hours": round(snapshot_age_hours, 2),
                "window_hours": window_hours,
            }),
        ],
        check=False,
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--since-hours", type=int, default=DEFAULT_SINCE_HOURS)
    ap.add_argument("--dry-run", action="store_true",
                    help="Compute and print result but do not alert orchestrator")
    ap.add_argument("--json", action="store_true", help="Emit machine-readable JSON only")
    args = ap.parse_args()

    checked_at = datetime.now(timezone.utc).isoformat()

    def emit(result: Dict[str, Any]) -> None:
        result["checked_at"] = checked_at
        result["window_hours"] = args.since_hours
        result.pop("evidence", None)  # evidence is for alert body only, not stdout
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

    # Secondary alert: stale snapshot (scanner cron failure).
    if should_alert_stale(age_hours):
        alert_orchestrator("stale", items_scanned, {}, age_hours, args.since_hours, args.dry_run)
        emit({
            "status": "alert",
            "alert_type": "stale",
            "snapshot_age_hours": round(age_hours, 2),
            "items_scanned": items_scanned,
            "alerted": not args.dry_run,
        })
        return 0

    if age_hours > SNAPSHOT_MAX_AGE_HOURS:
        emit({
            "status": "deferred",
            "reason": f"scanner snapshot stale ({age_hours:.1f}h > {SNAPSHOT_MAX_AGE_HOURS}h)",
            "items_scanned": items_scanned,
        })
        return 0

    try:
        token = scanner.get_token(env)
    except Exception as e:  # noqa: BLE001
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

    masking_alert = should_alert_masking(items_scanned, counts["slack_messages"])
    if masking_alert:
        alert_orchestrator(
            "masking", items_scanned, counts, age_hours, args.since_hours, args.dry_run
        )

    # TODO(codex/dd30c9a4): Third divergence check — triage-run freshness.
    # Alert when newest item scanned_at > triage-run generated_at by >2.5h,
    # meaning the Triage page headline (supreme-triage-run edge fn artifact) is
    # showing stale data relative to what the scanner has already found.
    # Storage path for triage-run artifact is not yet exposed — wire once
    # supreme-triage-run edge fn writes its generated_at to a known local path
    # or Supabase table row. Baseline: run 117 (2026-06-12T03:44:10Z, items_scanned=6).

    emit({
        "status": "alert" if masking_alert else "ok",
        "alert_type": "masking" if masking_alert else None,
        "items_scanned": items_scanned,
        "slack_messages": counts["slack_messages"],
        "dm_candidates": counts["dm_candidates"],
        "mention_candidates": counts["mention_candidates"],
        "snapshot_age_hours": round(age_hours, 2),
        "alerted": bool(masking_alert and not args.dry_run),
    })
    return 0


if __name__ == "__main__":
    sys.exit(main())
