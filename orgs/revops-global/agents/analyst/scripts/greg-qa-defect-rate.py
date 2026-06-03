#!/usr/bin/env python3
"""
greg-qa-defect-rate.py — count Greg-as-QA incidents in a time window.

Scans analyst inbound messages (Telegram + agent bus inbox) for QA complaint
patterns within a rolling time window. Uses message timestamps to enforce the
window (not unbounded grep).

Output to stdout:
  {"window_hours": 4, "matches": [...], "count": N, "false_positives_filtered": M}

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
LOG_DIR = Path(f"/home/cortextos/.cortextos/{INSTANCE_ID}/logs/analyst")
INBOUND_LOG = LOG_DIR / "inbound-messages.jsonl"
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
    r"\bfix this\b",
    r"\bwhy is\b",
    r"\bwhat happened\b",
]

QA_PATTERN_RE = re.compile("|".join(QA_PATTERNS), re.IGNORECASE)

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
]


def is_self_referential(text: str) -> bool:
    lower = text.lower()
    return any(m.lower() in lower for m in SELF_REF_MARKERS)


def load_inbound_messages(since: datetime) -> list[str]:
    texts: list[str] = []
    if not INBOUND_LOG.exists():
        return texts
    with INBOUND_LOG.open() as f:
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

    print(json.dumps({
        "window_hours": args.window_hours,
        "matches": matches,
        "count": len(matches),
        "false_positives_filtered": false_positives_filtered,
    }))


if __name__ == "__main__":
    main()
