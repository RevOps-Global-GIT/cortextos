#!/usr/bin/env python3
"""
signal-ratio-orch-events.py

Compute the orchestrator signal_ratio_1h metric from the orch_events table —
an immutable, append-only surface — instead of parsing the orchestrator's
outbound Telegram log + HEARTBEAT.md (the old autonomy-watch.sh path).

The orchestrator-signal-ratio autoresearch cycle (orchestrator/experiments/
config.json, a local-only runtime config managed via `cortextos bus
manage-cycle`) points its measurement at this script.

WHY THIS EXISTS
---------------
The original signal_ratio_1h (autonomy-watch.sh) classified the orchestrator's
outbound Telegram messages with a keyword regex and also parsed heartbeat text.
That surface was mutable, worktree-resident, and volatile — it swung 100% -> 50%
within hours with no surface change because it tracked dispatch *volume*, not
anything an experiment could move. The cycle stalled ~12 days at a 0% keep-rate
(every experiment deferred/discarded; see the orchestrator autoresearch SKILL.md
notes, 2026-05-29).

orch_events is append-only and immutable (rows are never edited), lives in
Postgres (not a polluted working tree), and is unaffected by agent-isolation
contamination. Counting events by signal_type (event_type) per hour gives a
stable, reproducible reading the cycle can actually measure against.

DEFINITION
----------
    signal_ratio = signal_events / total_events   (over the last <window> minutes)

Classification is by event_type ONLY (no fragile text parsing):
  - NOISE  = heartbeat            (pure liveness narration)
  - SIGNAL = everything else      (action, task, error, capability, message,
                                   agent_message, telegram_inbound/outbound, ...)

NOISE_EVENT_TYPES is the single tunable knob; keep it event_type-based so the
metric never regresses into keyword-regex contamination.

Usage:
    python3 scripts/signal-ratio-orch-events.py                 # last 60 min
    python3 scripts/signal-ratio-orch-events.py --window-minutes 60 --json
    python3 scripts/signal-ratio-orch-events.py --no-write      # stdout only
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, Optional, Tuple

SECRETS_ENV = Path("/home/cortextos/cortextos/orgs/revops-global/secrets.env")
SCRIPT_DIR = Path(__file__).resolve().parent
OUTPUT_DIR = SCRIPT_DIR.parent / "output" / "signal-ratio"

# Single tunable knob. Everything NOT in here counts as signal. Keep this set
# event_type-based — never reintroduce per-message keyword matching.
NOISE_EVENT_TYPES = {"heartbeat"}

DEFAULT_WINDOW_MINUTES = 60


def load_env() -> Dict[str, str]:
    out: Dict[str, str] = {}
    if SECRETS_ENV.exists():
        for line in SECRETS_ENV.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            out[k.strip()] = v.strip()
    return out


def fetch_event_type_counts(env: Dict[str, str], window_minutes: int) -> Dict[str, int]:
    base = env.get("SUPABASE_RGOS_URL") or env.get("SUPABASE_URL")
    key = env.get("SUPABASE_RGOS_SERVICE_KEY")
    if not base or not key:
        raise RuntimeError("missing SUPABASE_RGOS_URL/SUPABASE_URL or SUPABASE_RGOS_SERVICE_KEY")
    since = (datetime.now(timezone.utc) - timedelta(minutes=window_minutes)).strftime(
        "%Y-%m-%dT%H:%M:%S"
    )
    # PostgREST caps a page at 1000 rows; page through created_at to get a true count.
    counts: Dict[str, int] = {}
    offset = 0
    page_size = 1000
    while True:
        qs = urllib.parse.urlencode({
            "select": "event_type",
            "created_at": f"gte.{since}",
            "order": "created_at.asc",
            "limit": str(page_size),
            "offset": str(offset),
        })
        url = f"{base}/rest/v1/orch_events?{qs}"
        req = urllib.request.Request(url, headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
        })
        with urllib.request.urlopen(req, timeout=30) as r:
            rows = json.loads(r.read().decode())
        for row in rows:
            et = row.get("event_type") or "unknown"
            counts[et] = counts.get(et, 0) + 1
        if len(rows) < page_size:
            break
        offset += page_size
    return counts


def compute_signal_ratio(counts: Dict[str, int]) -> Tuple[Optional[float], int, int]:
    """Return (ratio, signal_events, total_events). ratio is None when total==0."""
    total = sum(counts.values())
    if total == 0:
        return None, 0, 0
    noise = sum(v for k, v in counts.items() if k in NOISE_EVENT_TYPES)
    signal = total - noise
    return signal / total, signal, total


def write_report(ratio: Optional[float], signal: int, total: int,
                 counts: Dict[str, int], window_minutes: int) -> Path:
    now = datetime.now(timezone.utc)
    day_dir = OUTPUT_DIR / now.strftime("%Y-%m-%d")
    day_dir.mkdir(parents=True, exist_ok=True)
    report = day_dir / f"{now.strftime('%H-%M')}.md"
    pct = "N/A (0 events)" if ratio is None else f"{ratio * 100:.0f}%"
    breakdown = "\n".join(
        f"- {et}: {n}{'  (noise)' if et in NOISE_EVENT_TYPES else ''}"
        for et, n in sorted(counts.items(), key=lambda kv: -kv[1])
    ) or "- (no events in window)"
    report.write_text(
        f"# Signal Ratio (orch_events) - {now.strftime('%Y-%m-%dT%H:%M:%SZ')}\n\n"
        f"## Window: last {window_minutes} min\n"
        f"- Signal ratio: {pct}\n"
        f"- Signal events: {signal}\n"
        f"- Total events: {total}\n\n"
        f"## By signal_type (event_type)\n{breakdown}\n\n"
        f"## Targets\n- Signal ratio target: >50%\n\n"
        f"_Source: orch_events (append-only, immutable). "
        f"Noise types: {sorted(NOISE_EVENT_TYPES)}._\n"
    )
    return report


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--window-minutes", type=int, default=DEFAULT_WINDOW_MINUTES)
    ap.add_argument("--json", action="store_true", help="Emit machine-readable JSON only")
    ap.add_argument("--no-write", action="store_true", help="Do not write the dated report file")
    args = ap.parse_args()

    env = load_env()
    try:
        counts = fetch_event_type_counts(env, args.window_minutes)
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"status": "error", "reason": str(e)}))
        return 1

    ratio, signal, total = compute_signal_ratio(counts)
    report_path = None
    if not args.no_write:
        report_path = str(write_report(ratio, signal, total, counts, args.window_minutes))

    result = {
        "status": "ok",
        "metric": "signal_ratio_1h",
        "signal_ratio": None if ratio is None else round(ratio, 4),
        "signal_ratio_pct": None if ratio is None else round(ratio * 100, 1),
        "signal_events": signal,
        "total_events": total,
        "window_minutes": args.window_minutes,
        "by_signal_type": dict(sorted(counts.items(), key=lambda kv: -kv[1])),
        "noise_event_types": sorted(NOISE_EVENT_TYPES),
        "report_path": report_path,
        "computed_at": datetime.now(timezone.utc).isoformat(),
    }
    print(json.dumps(result) if args.json else json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
