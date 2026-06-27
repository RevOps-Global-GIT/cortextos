#!/usr/bin/env python3
"""
greg-qa-defect-rate.py — count Greg-as-QA incidents in a time window.

Scans inbound messages across all active agent logs for QA complaint patterns
within a rolling time window. Greg's messages land in orchestrator's inbox (via
external-comms funnel), so we scan orchestrator + dev + dev-2 + mac-codex +
analyst logs to capture the full trust-class signal.

Also parses the Greg↔orch thread for "fleet claimed fixed → user said still
broken" patterns — the highest-signal trust defect class.

Output to stdout:
  {"window_hours": 4, "matches": [...], "count": N,
   "false_positives_filtered": M,
   "overclaim_bouncebacks": [...], "overclaim_bounceback_count": N}

Usage:
  python3 greg-qa-defect-rate.py [--window-hours 4]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

INSTANCE_ID = os.environ.get("CTX_INSTANCE_ID", "cortextos1")
LOG_BASE = Path(f"/home/cortextos/.cortextos/{INSTANCE_ID}/logs")

# Greg's Telegram chat ID — distinguishes his messages from fleet messages
# in the orchestrator inbound log.
GREG_TELEGRAM_ID = "8567114601"

# Greg's messages funnel through orchestrator; also scan dev/dev-2/mac-codex
# for trust-class signals that land there via specialist routing.
SCAN_AGENTS = ["orchestrator", "dev", "dev-2", "mac-codex", "analyst"]

INBOUND_LOGS = [LOG_BASE / agent / "inbound-messages.jsonl" for agent in SCAN_AGENTS]
INBOX_DIR = Path(f"/home/cortextos/.cortextos/{INSTANCE_ID}/inbox/analyst")

QA_PATTERNS = [
    r"\bbug\b",
    r"\bbroken\b",
    r"\bwrong\b",
    r"\bincorrect\b",
    r"doesn['']t work",
    r"\bnot working\b",
    r"\bregression\b",
    r"\bfailed\b",
    r"\bfailing\b",
    r"\bfix this\b",
    r"\bwhy is\b",
    r"\bwhere is\b",
    r"\bwhat happened\b",
    r"\bisn['']t\b",
    r"\bweren['']t\b",
    r"\bdid not\b",
    r"\bdoesn['']t\b",
    r"\bmissing\b",
    r"\bnone of these\b",
    r"\ball wrong\b",
    # Non-keyword complaint language — catches "not right", "not accurate", etc.
    r"\bnot right\b",
    r"\bnot accurate\b",
    r"\bnot correct\b",
    r"\bnot what\b",
    r"\bnot showing\b",
    r"\bnot saving\b",
    r"\bnot loading\b",
    r"\bnot appearing\b",
    r"\bfabricated\b",
    r"\bmade up\b",
    r"\bwhere.*from\b",
    r"\bstill broken\b",
    r"\bstill not\b",
    r"\bstill wrong\b",
    r"\bstill failing\b",
    r"\bdidn['']t fix\b",
    r"\bsame issue\b",
    r"\bsame problem\b",
]

QA_PATTERN_RE = re.compile("|".join(QA_PATTERNS), re.IGNORECASE)

# Fleet "we fixed it" claim patterns — used for overclaim bounceback detection.
FLEET_CLAIM_RE = re.compile(
    r"\b(fixed|verified|confirmed|merged|deployed|live|resolved|done|completed?|shipped|working now)\b",
    re.IGNORECASE,
)

# Still-broken signals from Greg — paired with a prior fleet claim.
STILL_BROKEN_RE = re.compile(
    r"\b(still|again|yet)\b"
    r"|\bnot (working|right|accurate|fixed|correct|showing|loading|saving|appearing)\b"
    r"|\bstill (broken|wrong|failing|not)\b"
    r"|\bdidn['']t fix\b"
    r"|\bsame (issue|problem|bug)\b"
    r"|\bnope\b",
    re.IGNORECASE,
)

# Filter out lines that are the cron prompt itself echoed into the log
SELF_REF_MARKERS = [
    "greg-qa-defect-rate",
    "QA_PATTERNS",
    "SELF_REF_MARKERS",
    "defect-rate",
    "Greg-as-QA",
    "window_hours",
    "false_positives_filtered",
    "cron prompt",
    "overclaim_bounceback",
]


def is_self_referential(text: str) -> bool:
    lower = text.lower()
    return any(m.lower() in lower for m in SELF_REF_MARKERS)


def load_inbound_messages(since: datetime) -> list[str]:
    texts: list[str] = []
    for log_path in INBOUND_LOGS:
        if not log_path.exists():
            continue
        with log_path.open() as f:
            for raw in f:
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    obj = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                ts_str = obj.get("timestamp") or obj.get("archived_at") or ""
                if not ts_str:
                    continue
                try:
                    ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
                except ValueError:
                    continue
                if ts >= since:
                    text = obj.get("text") or obj.get("body") or obj.get("message") or ""
                    if text:
                        texts.append(text)
    return texts


def load_orch_thread(since: datetime) -> list[dict]:
    """Load orchestrator inbound messages in chronological order with sender metadata."""
    orch_log = LOG_BASE / "orchestrator" / "inbound-messages.jsonl"
    messages: list[dict] = []
    if not orch_log.exists():
        return messages
    with orch_log.open() as f:
        for raw in f:
            raw = raw.strip()
            if not raw:
                continue
            try:
                obj = json.loads(raw)
            except json.JSONDecodeError:
                continue
            ts_str = obj.get("timestamp") or obj.get("archived_at") or ""
            if not ts_str:
                continue
            try:
                ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
            except ValueError:
                continue
            if ts >= since:
                text = obj.get("text") or obj.get("body") or obj.get("message") or ""
                from_id = str(obj.get("from", ""))
                is_greg = from_id == GREG_TELEGRAM_ID
                messages.append({"ts": ts, "text": text, "is_greg": is_greg})
    messages.sort(key=lambda m: m["ts"])
    return messages


def find_overclaim_bouncebacks(since: datetime) -> list[dict]:
    """Find 'fleet claimed fixed → Greg replied still broken' sequences.

    Scans the Greg↔orch thread for the highest-signal trust defect class:
    the fleet over-claimed a fix was live, and Greg reported it was still broken.
    Looks back up to 5 messages before each Greg still-broken message for a
    fleet claim of resolution.
    """
    messages = load_orch_thread(since)
    bouncebacks: list[dict] = []
    for i, msg in enumerate(messages):
        if not msg["is_greg"]:
            continue
        text = msg["text"]
        if not STILL_BROKEN_RE.search(text):
            continue
        if is_self_referential(text):
            continue
        lookback = messages[max(0, i - 5):i]
        fleet_claim = None
        for prior in reversed(lookback):
            if not prior["is_greg"] and FLEET_CLAIM_RE.search(prior["text"]):
                fleet_claim = prior
                break
        if fleet_claim:
            bouncebacks.append({
                "type": "overclaim_bounceback",
                "fleet_claimed": fleet_claim["text"][:160].replace("\n", " "),
                "fleet_claim_at": fleet_claim["ts"].isoformat(),
                "greg_replied": text[:160].replace("\n", " "),
                "greg_reply_at": msg["ts"].isoformat(),
            })
    return bouncebacks


def load_inbox_messages(since: datetime) -> list[str]:
    texts: list[str] = []
    if not INBOX_DIR.exists():
        return texts
    for f in INBOX_DIR.glob("*.json"):
        try:
            obj = json.load(f.open())
        except Exception:
            continue
        ts_str = obj.get("timestamp") or obj.get("created_at") or ""
        if not ts_str:
            continue
        try:
            ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
        except ValueError:
            continue
        if ts >= since:
            text = obj.get("text") or obj.get("body") or obj.get("message") or ""
            if text:
                texts.append(text)
    return texts


def main() -> None:
    p = argparse.ArgumentParser(description="Greg QA defect rate probe")
    p.add_argument("--window-hours", type=float, default=4)
    args = p.parse_args()

    now = datetime.now(timezone.utc)
    since = now - timedelta(hours=args.window_hours)

    all_texts = load_inbound_messages(since) + load_inbox_messages(since)

    matches: list[str] = []
    false_positives_filtered = 0

    for text in all_texts:
        m = QA_PATTERN_RE.search(text)
        if not m:
            continue
        if is_self_referential(text):
            false_positives_filtered += 1
            continue
        matches.append(text[:160].replace("\n", " "))

    bouncebacks = find_overclaim_bouncebacks(since)

    result = {
        "run_at": now.isoformat(),
        "window_hours": args.window_hours,
        "matches": matches,
        "count": len(matches),
        "false_positives_filtered": false_positives_filtered,
        "overclaim_bouncebacks": bouncebacks,
        "overclaim_bounceback_count": len(bouncebacks),
    }
    print(json.dumps(result))

    output_path = Path(__file__).parent.parent / "output" / "greg-qa-defect-rate.jsonl"
    try:
        with output_path.open("a") as fh:
            fh.write(json.dumps(result) + "\n")
    except Exception as e:
        print(f"[warn] failed to append to {output_path}: {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
