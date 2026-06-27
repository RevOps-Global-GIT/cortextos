#!/usr/bin/env python3
"""
greg-qa-defect-rate.py — count Greg-as-QA incidents in a time window.

Scans inbound messages across all active agent logs for QA complaint patterns
within a rolling time window. Greg's messages land in orchestrator's inbox (via
external-comms funnel), so we scan orchestrator + dev + dev-2 + mac-codex +
analyst logs to capture the full trust-class signal.

Two severity tiers:
  NORMAL  — user complaint matching a QA pattern (product feedback / bug report)
  ELEVATED — fleet previously claimed "fixed/verified/live" for the same session,
             then user contradicted it (trust event, weighted heaviest)

Domain mismatch flag (domain_mismatch_risk):
  True when the preceding fleet "fixed" claim mentioned a staging/preview domain
  (vercel.app, ob1-parents, localhost, staging., preview.) but the user complaint
  implies the live production domain — the fleet over-claimed on the wrong env.

Output to stdout:
  {"window_hours": 4, "matches": [...], "count": N, "elevated_count": N,
   "domain_mismatch_count": N, "false_positives_filtered": M}

Usage:
  python3 greg-qa-defect-rate.py [--window-hours 4] [--date YYYY-MM-DD]

  --date scans the full calendar day (UTC) instead of a rolling window.
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

# Greg's messages funnel through orchestrator; also scan dev/dev-2/mac-codex
# for trust-class signals that land there via specialist routing.
SCAN_AGENTS = ["orchestrator", "dev", "dev-2", "mac-codex", "analyst"]

INBOUND_LOGS = [LOG_BASE / agent / "inbound-messages.jsonl" for agent in SCAN_AGENTS]
# Orchestrator outbound = fleet's claims to Greg (fixed/verified/live assertions)
OUTBOUND_LOG = LOG_BASE / "orchestrator" / "outbound-messages.jsonl"
INBOX_DIR = Path(f"/home/cortextos/.cortextos/{INSTANCE_ID}/inbox/analyst")

# --- Keyword patterns (existing) ---
QA_PATTERNS_KEYWORD = [
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
]

# --- Content-accuracy / non-keyword patterns ---
# These match trust-class defects Greg reports without standard bug keywords:
# "not right", "not accurate", "where is this from", "fabricated",
# "does not work", "still broken", plus specific surface failure patterns
# and wrong-domain over-claim contradiction patterns.
QA_PATTERNS_CONTENT = [
    r"\bnot right\b",               # "This is not right either"
    r"\bnot accurate\b",            # "THIS IS NOT ACCURATE EITHER"
    r"where.{0,10}is from",         # "where is this from" AND "where this is from"
    r"\bfabricated\b",              # explicit content-accuracy accusation
    r"\bdoes not work\b",           # variant of doesn't work
    r"\bstill broken\b",            # explicit contradiction of fleet fix claim
    r"\bnot populated\b",           # "Beer name not populated from image"
    r"\bnot capturing\b",           # "photo not capturing X"
    r"\bnot saving\b",              # "beer not saving"
    r"\bnot mobile\b",              # "not mobile optimized"
    r"\bnot optimized\b",           # "not optimized"
    r"\bnot available\b",           # "not available" (surface missing)
    r"\bI would not say\b",         # Greg disputing fleet-generated content
    r"\bthis is not\b",             # "this is not right/accurate/etc."
    r"\bthat is not\b",             # "that is not right/what I asked"
    # Wrong-domain over-claim contradictions (fleet tested on staging, Greg on prod)
    r"\bwrong domain\b",            # explicit domain mismatch report
    r"\bwrong url\b",               # URL mismatch
    r"\bwrong (site|environment)\b", # site/env mismatch
    r"\bdifferent (domain|url|site)\b", # different domain callout
    r"\bnot (on|our) (live|prod|production)\b", # "not on live/not our prod"
    r"\bnot the (live|prod|production|right) (site|url|link|domain)\b", # "not the live site"
    r"\bthat['']?s not (live|production|our)\b", # "that's not our production site"
]

ALL_QA_PATTERNS = QA_PATTERNS_KEYWORD + QA_PATTERNS_CONTENT
QA_PATTERN_RE = re.compile("|".join(ALL_QA_PATTERNS), re.IGNORECASE)

# --- Fleet "fixed/verified/live" claim patterns (for look-back elevation) ---
# When we detect these in orchestrator OUTBOUND messages, a subsequent user
# complaint within the look-back window becomes ELEVATED (trust event).
FLEET_FIXED_PATTERNS = [
    r"\bfixed and (verified|live)\b",
    r"\bverified (live|on|and)\b",
    r"\b(fixed|resolved|shipped|deployed) (and |)live\b",
    r"\bverified end.to.end\b",
    r"\bconfirmed (live|working|fixed)\b",
    r"\bis (fixed|live|working) now\b",
    r"\bnow (fixed|live|working)\b",
    r"\bshould (look|work) right\b",
    r"\bfixed and live\b",
    r"\bboth.*fixed.*verified\b",
]
FLEET_FIXED_RE = re.compile("|".join(FLEET_FIXED_PATTERNS), re.IGNORECASE)

# --- Domain over-claim patterns (for outbound fleet messages) ---
# When fleet says something is fixed/live but mentions a staging/preview env,
# that's a domain over-claim — fleet verified on the wrong surface.
DOMAIN_OVERCLAIM_PATTERNS = [
    r"ob1-parents",       # sibling staging app, not Greg's live instance ob1.revopsglobal.com
    r"vercel\.app",       # preview/staging domain, not production
    r"localhost",         # local dev, not live
    r"staging\.",         # staging subdomain
    r"preview\.",         # preview subdomain
    r"\.vercel\.app",     # any vercel preview URL
]
DOMAIN_OVERCLAIM_RE = re.compile("|".join(DOMAIN_OVERCLAIM_PATTERNS), re.IGNORECASE)

# How far back to look for a fleet "fixed" claim when an inbound complaint arrives
ELEVATION_LOOKBACK_HOURS = 24

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
    "FLEET_FIXED_PATTERNS",
    "ELEVATION_LOOKBACK",
]


def is_self_referential(text: str) -> bool:
    lower = text.lower()
    return any(m.lower() in lower for m in SELF_REF_MARKERS)


def load_outbound_fleet_claims(since: datetime, until: datetime) -> list[tuple[datetime, str, bool]]:
    """Return (timestamp, text, domain_mismatch_risk) for orchestrator outbound messages
    that contain a fleet 'fixed/verified/live' claim within the extended look-back window.

    domain_mismatch_risk is True when the claim also mentions a staging/preview domain
    (vercel.app, ob1-parents, localhost, staging., preview.) — indicating the fleet
    verified on the wrong surface before claiming it's live.
    """
    claims: list[tuple[datetime, str, bool]] = []
    if not OUTBOUND_LOG.exists():
        return claims
    lookback_start = since - timedelta(hours=ELEVATION_LOOKBACK_HOURS)
    with OUTBOUND_LOG.open() as f:
        for raw in f:
            raw = raw.strip()
            if not raw:
                continue
            try:
                obj = json.loads(raw)
            except json.JSONDecodeError:
                continue
            ts_str = obj.get("timestamp") or ""
            if not ts_str:
                continue
            try:
                ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
            except ValueError:
                continue
            if ts < lookback_start or ts > until:
                continue
            text = obj.get("text") or obj.get("body") or obj.get("message") or ""
            if text and FLEET_FIXED_RE.search(text):
                domain_mismatch_risk = bool(DOMAIN_OVERCLAIM_RE.search(text))
                claims.append((ts, text, domain_mismatch_risk))
    return claims


def load_inbound_messages(since: datetime, until: datetime) -> list[tuple[datetime, str]]:
    """Return (timestamp, text) for inbound Greg messages in window."""
    items: list[tuple[datetime, str]] = []
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
                if ts < since or ts > until:
                    continue
                # Only count Greg's messages (from field 8567114601 or from_name Greg)
                from_id = str(obj.get("from", ""))
                from_name = obj.get("from_name", "")
                # Include if it looks like Greg's Telegram or if from orchestrator inbound (all are Greg)
                # Orchestrator inbound messages are always from Greg; specialist inboxes filter by from_id
                text = obj.get("text") or obj.get("body") or obj.get("message") or ""
                if text:
                    items.append((ts, text))
    return items


def load_inbox_messages(since: datetime, until: datetime) -> list[tuple[datetime, str]]:
    items: list[tuple[datetime, str]] = []
    if not INBOX_DIR.exists():
        return items
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
        if ts < since or ts > until:
            continue
        text = obj.get("text") or obj.get("body") or obj.get("message") or ""
        if text:
            items.append((ts, text))
    return items


def main() -> None:
    p = argparse.ArgumentParser(description="Greg QA defect rate probe")
    p.add_argument("--window-hours", type=float, default=4)
    p.add_argument(
        "--date",
        type=str,
        default=None,
        help="Scan a full calendar day UTC (YYYY-MM-DD). Overrides --window-hours.",
    )
    args = p.parse_args()

    now = datetime.now(timezone.utc)

    if args.date:
        # Full day mode: midnight-to-midnight UTC for the given date
        day = datetime.strptime(args.date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        since = day
        until = day + timedelta(days=1)
        window_label = f"day:{args.date}"
    else:
        since = now - timedelta(hours=args.window_hours)
        until = now
        window_label = f"{args.window_hours}h"

    # Load fleet "fixed/verified/live" claims from orchestrator outbound
    fleet_claims = load_outbound_fleet_claims(since, until)

    all_items = load_inbound_messages(since, until) + load_inbox_messages(since, until)
    # Deduplicate by (ts, text)
    seen_texts: set[str] = set()
    unique_items: list[tuple[datetime, str]] = []
    for ts, text in all_items:
        key = text[:200]
        if key not in seen_texts:
            seen_texts.add(key)
            unique_items.append((ts, text))

    matches: list[dict] = []
    false_positives_filtered = 0

    for ts, text in unique_items:
        m = QA_PATTERN_RE.search(text)
        if not m:
            continue
        if is_self_referential(text):
            false_positives_filtered += 1
            continue

        # Determine severity: ELEVATED if any fleet "fixed" claim preceded this complaint
        severity = "NORMAL"
        fleet_claim_ref = None
        domain_mismatch_risk = False
        for claim_ts, claim_text, claim_domain_mismatch in fleet_claims:
            if claim_ts <= ts:  # fleet claim came before this complaint
                severity = "ELEVATED"
                fleet_claim_ref = claim_text[:120].replace("\n", " ")
                if claim_domain_mismatch:
                    domain_mismatch_risk = True
                break

        # Also flag as domain_mismatch_risk if the Greg message itself mentions wrong-domain
        if not domain_mismatch_risk and DOMAIN_OVERCLAIM_RE.search(text):
            domain_mismatch_risk = True

        matches.append({
            "ts": ts.isoformat(),
            "text": text[:200].replace("\n", " "),
            "matched_pattern": m.group(0),
            "severity": severity,
            "fleet_claim_preceding": fleet_claim_ref,
            "domain_mismatch_risk": domain_mismatch_risk,
        })

    elevated_count = sum(1 for m in matches if m["severity"] == "ELEVATED")
    domain_mismatch_count = sum(1 for m in matches if m.get("domain_mismatch_risk"))

    result = {
        "run_at": now.isoformat(),
        "window": window_label,
        "window_hours": args.window_hours if not args.date else None,
        "matches": matches,
        "count": len(matches),
        "elevated_count": elevated_count,
        "domain_mismatch_count": domain_mismatch_count,
        "fleet_fixed_claims_in_window": len(fleet_claims),
        "false_positives_filtered": false_positives_filtered,
    }
    print(json.dumps(result, indent=2))

    # Append compact record to persistent JSONL for trend tracking
    compact = {
        "run_at": now.isoformat(),
        "window": window_label,
        "count": len(matches),
        "elevated_count": elevated_count,
        "domain_mismatch_count": domain_mismatch_count,
        "matches": [m["text"][:160] for m in matches],
        "false_positives_filtered": false_positives_filtered,
    }
    output_path = Path(__file__).parent.parent / "output" / "greg-qa-defect-rate.jsonl"
    try:
        with output_path.open("a") as fh:
            fh.write(json.dumps(compact) + "\n")
    except Exception as e:
        print(f"[warn] failed to append to {output_path}: {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
