#!/usr/bin/env python3
"""
supreme-mentions-triage-ingest.py

Ingest the Slackbot skill output "Mentions Triage -- What Needs a Reply"
into `supreme_outstanding_items`.

This is the corrected lightweight path for /supreme-outstanding:
Slackbot skill output -> this parser -> Supabase -> existing AgentOps UI.
It intentionally does not read PivotPulse or any other bot DM.

Input format is text/markdown with numbered or bulleted lines, for example:

  1. [action item in #channel, 2d ago] message preview...
  - [@-mention in #mpdm-name, 1d ago] message preview...

Slack links are optional; if present as markdown links, they are preserved.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

REPO_ROOT = Path(__file__).resolve().parent.parent
OUTPUT_DIR = REPO_ROOT / "output"
DEFAULT_INPUT = OUTPUT_DIR / "supreme-mentions-triage-latest.txt"
FALLBACK_INPUT = OUTPUT_DIR / "supreme-outstanding-digest.txt"
LATEST_JSON = OUTPUT_DIR / "supreme-mentions-triage-ingest-latest.json"
LAST_SYNC_JSON = OUTPUT_DIR / "supreme-mentions-triage-last-sync.json"
SCANNER_PATH = REPO_ROOT / "scripts" / "supreme-slack-scanner.py"

WORKSPACE_TEAM_ID = "T08G932PM"
DEFAULT_SLACK_URL = "https://hub.revopsglobal.com/app/supreme-outstanding"
PIPE_SOURCE = "mentions_triage_skill"
MAX_INPUT_AGE_SECONDS = 30 * 60


def load_scanner_module():
    spec = importlib.util.spec_from_file_location("supreme_slack_scanner", SCANNER_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load scanner helper at {SCANNER_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def clean_text(text: str) -> str:
    text = re.sub(r"<@([UW][A-Z0-9]+)(?:\|[^>]+)?>", r"@\1", text or "")
    text = re.sub(r"<([^|>]+)\|([^>]+)>", r"\2", text)
    text = re.sub(r"&amp;", "&", text)
    text = re.sub(r"&lt;", "<", text)
    text = re.sub(r"&gt;", ">", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def parse_age_seconds(age_text: str) -> int:
    match = re.search(r"(\d+)\s*(min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\b", age_text, re.I)
    if not match:
        return 0
    value = int(match.group(1))
    unit = match.group(2).lower()
    if unit.startswith("min"):
        return value * 60
    if unit in {"h", "hr", "hrs"} or unit.startswith("hour"):
        return value * 3600
    return value * 86400


def stable_id(header: str, preview: str, link: str) -> str:
    digest = hashlib.sha256(f"{header}\n{preview}\n{link}".encode()).hexdigest()[:20]
    return f"supreme-mentions-triage-{digest}"


def extract_link(text: str) -> tuple[str, str]:
    markdown = re.search(r"\[([^\]]+)\]\((https?://[^)]+)\)", text)
    if markdown:
        return text.replace(markdown.group(0), markdown.group(1)), markdown.group(2)
    bare = re.search(r"(https?://\S+)", text)
    if bare:
        return text.replace(bare.group(1), "").strip(), bare.group(1).rstrip(".,)")
    return text, DEFAULT_SLACK_URL


def iter_item_lines(text: str) -> Iterable[str]:
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if re.match(r"^(?:\d+[.)]|[-*•])\s+", line):
            yield re.sub(r"^(?:\d+[.)]|[-*•])\s+", "", line).strip()


def normalized_source(value: str) -> tuple[str, str]:
    value = (value or "").strip().lower()
    if "action" in value or "todo" in value or "to do" in value:
        return "action_item", "action_item"
    if "dm" in value or "direct" in value:
        return "dm", "unanswered"
    if "thread" in value:
        return "thread_mention", "mentioned"
    return "channel_mention", "unanswered"


def normalize_json_item(item: Dict[str, Any], scanned_at: str) -> Optional[Dict[str, Any]]:
    preview = clean_text(
        str(
            item.get("message_preview")
            or item.get("preview")
            or item.get("text")
            or item.get("message")
            or item.get("summary")
            or ""
        )
    )
    if len(preview) < 8:
        return None

    header = clean_text(str(item.get("header") or item.get("type") or item.get("source") or "Mentions Triage"))
    link = str(item.get("slack_url") or item.get("url") or item.get("link") or DEFAULT_SLACK_URL)
    source, status = normalized_source(str(item.get("source") or item.get("type") or header))
    channel_name = clean_text(str(item.get("channel_name") or item.get("channel") or item.get("channel_id") or "Mentions Triage"))
    channel_id = clean_text(str(item.get("channel_id") or channel_name))
    message_ts = str(item.get("message_ts") or item.get("ts") or item.get("timestamp") or "")
    # Prefer the scanner's channel_id+message_ts key so both pipes collide on the
    # same row and the upsert deduplicates cross-pipe (one Slack msg = one open row).
    _scanner_id = (
        f"supreme-{channel_id}-{message_ts}"
        if (re.match(r"^[A-Z0-9]{9,}$", channel_id or "")
            and re.match(r"^\d+\.\d+$", message_ts or ""))
        else None
    )
    item_id = str(item.get("id") or "").strip() or _scanner_id or stable_id(header, preview, link or message_ts)
    age_seconds = item.get("age_seconds")
    if not isinstance(age_seconds, int):
        age_seconds = parse_age_seconds(str(item.get("age") or header))

    question_markers = re.compile(
        r"\?|\b(are you|can you|could you|would you|will you|who|when|what|where|why|how)\b",
        re.I,
    )
    action_markers = re.compile(
        r"\b(can you|could you|would you|please|let'?s|action(?: item)?:?|todo|owner:?)\b",
        re.I,
    )
    is_question_val = bool(item.get("is_question")) or bool(question_markers.search(preview))
    if not is_question_val and not action_markers.search(preview):
        return None  # pure acknowledgement / closer — not reply-needed

    return {
        "id": item_id,
        "scanned_at": scanned_at,
        "workspace_team_id": str(item.get("workspace_team_id") or WORKSPACE_TEAM_ID),
        "source": source,
        "status": str(item.get("status") or status),
        "channel_id": channel_id,
        "channel_name": channel_name,
        "sender_id": str(item.get("sender_id") or item.get("user_id") or ""),
        "sender_name": str(item.get("sender_name") or item.get("user_name") or "Mentions Triage"),
        "message_preview": preview[:280],
        "message_ts": message_ts,
        "age_seconds": age_seconds,
        "slack_url": link,
        "is_question": is_question_val,
        "is_replied_by_greg": bool(item.get("is_replied_by_greg", False)),
        "raw_json": {
            "pipe": "supreme_mentions_triage_ingest",
            "pipe_source": PIPE_SOURCE,
            "skill": "Mentions Triage -- What Needs a Reply",
            "captured_format": "json",
            "source_item": item,
        },
    }


def parse_json_items(text: str, scanned_at: str) -> Optional[List[Dict[str, Any]]]:
    try:
        payload = json.loads(text)
    except Exception:
        return None

    if isinstance(payload, list):
        raw_items = payload
    elif isinstance(payload, dict):
        raw_items = None
        for key in ("items", "results", "messages", "outstanding", "needs_reply"):
            value = payload.get(key)
            if isinstance(value, list):
                raw_items = value
                break
        if raw_items is None:
            raw_items = [payload]
    else:
        return []

    rows: List[Dict[str, Any]] = []
    seen: set[str] = set()
    for raw in raw_items:
        if not isinstance(raw, dict):
            continue
        row = normalize_json_item(raw, scanned_at)
        if not row or row["id"] in seen:
            continue
        rows.append(row)
        seen.add(row["id"])
    return rows


def parse_line(line: str, scanned_at: str) -> Optional[Dict[str, Any]]:
    line, link = extract_link(line)
    header = "Mentions Triage"
    preview = line
    channel_name = "Mentions Triage"
    age_seconds = 0
    item_type = "mention"

    bracket = re.match(r"^\[([^\]]+)\]\s*(.+)$", line)
    if bracket:
        header = clean_text(bracket.group(1))
        preview = clean_text(bracket.group(2))
        item_type = header.split(" in ", 1)[0].strip().lower() or "mention"
        channel_match = re.search(r"\bin\s+(#[^,\]]+)", header)
        if channel_match:
            channel_name = channel_match.group(1).strip()
        age_seconds = parse_age_seconds(header)
    else:
        preview = clean_text(preview)

    if len(preview) < 8:
        return None

    table_source, status = normalized_source(item_type)
    question_markers = re.compile(
        r"\?|\b(are you|can you|could you|would you|will you|who|when|what|where|why|how)\b",
        re.I,
    )

    return {
        "id": stable_id(header, preview, link),
        "scanned_at": scanned_at,
        "workspace_team_id": WORKSPACE_TEAM_ID,
        "source": table_source,
        "status": status,
        "channel_id": channel_name,
        "channel_name": channel_name,
        "sender_id": "",
        "sender_name": "Mentions Triage",
        "message_preview": preview[:280],
        "message_ts": "",
        "age_seconds": age_seconds,
        "slack_url": link,
        "is_question": bool(question_markers.search(preview)),
        "is_replied_by_greg": False,
        "raw_json": {
            "pipe": "supreme_mentions_triage_ingest",
            "pipe_source": PIPE_SOURCE,
            "skill": "Mentions Triage -- What Needs a Reply",
            "header": header,
            "item_type": item_type,
            "source_line": line[:1200],
        },
    }


def iter_table_rows(text: str) -> Iterable[tuple[str, str, str, str, str]]:
    """Parse the Slackbot's sectioned table output.

    The live Slackbot currently returns sections such as "Urgent — Reply Now"
    followed by a tab-separated table: From / Where / What They Need /
    Suggested Action. These are not markdown bullet lines, so the older parser
    would mark a fresh capture as 0 rows.
    """
    current_section = ""
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if "—" in line and any(label in line.lower() for label in ("urgent", "high", "normal", "low")):
            current_section = clean_text(line)
            continue
        if not current_section:
            continue
        if line.lower().startswith("from\twhere\twhat they need\t"):
            continue
        parts = [clean_text(part) for part in re.split(r"\t+", line) if part.strip()]
        if len(parts) < 4:
            continue
        if "no action required" in current_section.lower():
            continue
        yield current_section, parts[0], parts[1], parts[2], parts[3]


def parse_table_items(text: str, scanned_at: str, raw_proof_path: str) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    seen: set[str] = set()
    for section, sender, where, need, suggested_action in iter_table_rows(text):
        preview = clean_text(f"{need} Suggested action: {suggested_action}")
        if len(preview) < 8:
            continue
        source, status = normalized_source(where)
        if "urgent" in section.lower() or "high" in section.lower():
            status = "unanswered"
        elif "normal" in section.lower():
            status = "mentioned"
        row = {
            "id": stable_id(section, f"{sender}\n{where}\n{preview}", DEFAULT_SLACK_URL),
            "scanned_at": scanned_at,
            "workspace_team_id": WORKSPACE_TEAM_ID,
            "source": source,
            "status": status,
            "channel_id": where,
            "channel_name": where,
            "sender_id": "",
            "sender_name": sender,
            "message_preview": preview[:280],
            "message_ts": "",
            "age_seconds": 0,
            "slack_url": DEFAULT_SLACK_URL,
            "is_question": True,
            "is_replied_by_greg": False,
            "raw_json": {
                "pipe": "supreme_mentions_triage_ingest",
                "pipe_source": PIPE_SOURCE,
                "skill": "Mentions Triage -- What Needs a Reply",
                "captured_format": "slackbot_table",
                "urgency_section": section,
                "sender": sender,
                "where": where,
                "what_they_need": need,
                "suggested_action": suggested_action,
                "cu_capture_at": scanned_at,
                "raw_proof_path": raw_proof_path,
            },
        }
        if row["id"] in seen:
            continue
        rows.append(row)
        seen.add(row["id"])
    return rows


def drop_synthetic_triage_rows(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    # Rows without a real Slack channel_id+message_ts fall back to stable_id(), minting a
    # "supreme-mentions-triage-<hash>" id whose hash drifts every pass (the header carries a
    # relative age like "13h ago"), so each cron run inserts a brand-new twin. The read side
    # (supreme-triage-run edge fn + supreme_outstanding_open_24h view) already excludes this
    # prefix, so these rows are never consumed — they only accumulate. Drop at ingest.
    return [r for r in rows if not str(r.get("id", "")).startswith("supreme-mentions-triage-")]


def parse_items(text: str, scanned_at: str, raw_proof_path: str) -> List[Dict[str, Any]]:
    json_rows = parse_json_items(text, scanned_at)
    if json_rows is not None:
        for row in json_rows:
            row.setdefault("raw_json", {})["cu_capture_at"] = scanned_at
            row.setdefault("raw_json", {})["raw_proof_path"] = raw_proof_path
        return drop_synthetic_triage_rows(json_rows)

    table_rows = parse_table_items(text, scanned_at, raw_proof_path)
    if table_rows:
        return drop_synthetic_triage_rows(table_rows)

    rows: List[Dict[str, Any]] = []
    seen: set[str] = set()
    for line in iter_item_lines(text):
        row = parse_line(line, scanned_at)
        if not row or row["id"] in seen:
            continue
        row.setdefault("raw_json", {})["cu_capture_at"] = scanned_at
        row.setdefault("raw_json", {})["raw_proof_path"] = raw_proof_path
        rows.append(row)
        seen.add(row["id"])
    return drop_synthetic_triage_rows(rows)


def preview_key(value: str) -> str:
    value = re.sub(r"\s+", " ", value or "").strip().lower()
    return re.sub(r"[^a-z0-9@#? ]+", "", value)[:160]


def dismiss_legacy_duplicates(scanner: Any, env: Dict[str, str], rows: List[Dict[str, Any]]) -> int:
    if not rows:
        return 0

    row_keys = {preview_key(row.get("message_preview", "")) for row in rows}
    legacy = scanner.sb_request(
        env,
        "GET",
        "/supreme_outstanding_items"
        "?select=id,status,message_preview,raw_json"
        f"&workspace_team_id=eq.{WORKSPACE_TEAM_ID}"
        "&limit=200",
    )
    duplicate_ids = []
    for item in legacy:
        raw = item.get("raw_json") or {}
        if raw.get("pipe_source") == PIPE_SOURCE:
            continue
        if item.get("status") not in {"unanswered", "mentioned", "action_item"}:
            continue
        item_key = preview_key(item.get("message_preview", ""))
        if any(item_key == row_key or item_key.startswith(row_key) or row_key.startswith(item_key) for row_key in row_keys):
            duplicate_ids.append(item["id"])

    for item_id in duplicate_ids:
        scanner.sb_request(
            env,
            "PATCH",
            f"/supreme_outstanding_items?id=eq.{item_id}",
            {"status": "resolved"},
        )
    return len(duplicate_ids)


def resolve_stale_pipe_rows(scanner: Any, env: Dict[str, str], rows: List[Dict[str, Any]]) -> int:
    """Close older Mentions Triage rows absent from the latest skill output."""
    current_ids = {row["id"] for row in rows}
    existing = scanner.sb_request(
        env,
        "GET",
        "/supreme_outstanding_items"
        "?select=id,status,raw_json"
        f"&workspace_team_id=eq.{WORKSPACE_TEAM_ID}"
        "&limit=500",
    )
    stale_ids = []
    for item in existing:
        raw = item.get("raw_json") or {}
        if raw.get("pipe_source") != PIPE_SOURCE:
            continue
        if item.get("id") in current_ids:
            continue
        if item.get("status") not in {"unanswered", "mentioned", "action_item"}:
            continue
        stale_ids.append(item["id"])

    for item_id in stale_ids:
        scanner.sb_request(
            env,
            "PATCH",
            f"/supreme_outstanding_items?id=eq.{item_id}",
            {
                "status": "resolved",
                "raw_json": {
                    "pipe": "supreme_mentions_triage_ingest",
                    "pipe_source": PIPE_SOURCE,
                    "stale_resolved_by": "latest_mentions_triage_skill_capture",
                },
            },
        )
    return len(stale_ids)


def write_latest(summary: Dict[str, Any]) -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    tmp = LATEST_JSON.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(summary, indent=2))
    tmp.replace(LATEST_JSON)
    if summary.get("dry_run") or not summary.get("ok"):
        return
    sync = {
        "ok": summary.get("ok", False),
        "last_sync_at": summary.get("generated_at"),
        "source": summary.get("source", PIPE_SOURCE),
        "rows_ready": summary.get("rows_ready", 0),
        "upserted": summary.get("upserted", 0),
        "legacy_duplicates_dismissed": summary.get("legacy_duplicates_dismissed", 0),
        "stale_pipe_rows_resolved": summary.get("stale_pipe_rows_resolved", 0),
        "input_path": summary.get("input_path"),
        "cu_capture_at": summary.get("cu_capture_at"),
        "raw_proof_path": summary.get("raw_proof_path"),
    }
    sync_tmp = LAST_SYNC_JSON.with_suffix(".json.tmp")
    sync_tmp.write_text(json.dumps(sync, indent=2))
    sync_tmp.replace(LAST_SYNC_JSON)


def choose_input(path_arg: Optional[str], allow_fallback: bool) -> Path:
    if path_arg:
        return Path(path_arg).expanduser().resolve()
    if DEFAULT_INPUT.exists():
        return DEFAULT_INPUT
    if not allow_fallback:
        return DEFAULT_INPUT
    return FALLBACK_INPUT


def file_age_seconds(path: Path) -> Optional[float]:
    try:
        return time.time() - path.stat().st_mtime
    except FileNotFoundError:
        return None


def file_mtime_iso(path: Path) -> str:
    return datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat()


def normalize_iso_datetime(value: str) -> str:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", help="Mentions Triage skill output text/markdown")
    parser.add_argument(
        "--allow-fallback",
        action="store_true",
        help="Allow legacy digest fallback. Default is fail-closed so cron runs cannot pretend fallback scanner output is CU Slackbot output.",
    )
    parser.add_argument(
        "--max-input-age-seconds",
        type=int,
        default=MAX_INPUT_AGE_SECONDS,
        help="Reject default captured-output file if older than this many seconds.",
    )
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--quiet", action="store_true")
    parser.add_argument(
        "--capture-timestamp",
        help="UTC timestamp when the CU Slackbot capture was produced. Defaults to the input file mtime.",
    )
    parser.add_argument(
        "--raw-proof-path",
        help="Path to the raw CU proof artifact. Defaults to the input path.",
    )
    args = parser.parse_args()

    input_path = choose_input(args.input, args.allow_fallback)
    if not input_path.exists():
        summary = {
            "ok": False,
            "error": "input_missing",
            "expected_input": str(DEFAULT_INPUT),
            "fallback_available": FALLBACK_INPUT.exists(),
            "fallback_allowed": args.allow_fallback,
            "input_path": str(input_path),
            "rows_ready": 0,
            "upserted": 0,
            "dry_run": args.dry_run,
        }
        write_latest(summary)
        print(json.dumps(summary, indent=2))
        return 2

    input_age = file_age_seconds(input_path)
    using_default_capture = input_path == DEFAULT_INPUT.resolve() or input_path == DEFAULT_INPUT
    if using_default_capture and input_age is not None and input_age > args.max_input_age_seconds:
        summary = {
            "ok": False,
            "error": "input_stale",
            "input_path": str(input_path),
            "input_age_seconds": int(input_age),
            "max_input_age_seconds": args.max_input_age_seconds,
            "rows_ready": 0,
            "upserted": 0,
            "dry_run": args.dry_run,
        }
        write_latest(summary)
        print(json.dumps(summary, indent=2))
        return 3

    try:
        cu_capture_at = normalize_iso_datetime(args.capture_timestamp) if args.capture_timestamp else file_mtime_iso(input_path)
    except Exception as exc:
        summary = {
            "ok": False,
            "error": "invalid_capture_timestamp",
            "input_path": str(input_path),
            "capture_timestamp": args.capture_timestamp,
            "details": str(exc),
            "rows_ready": 0,
            "upserted": 0,
            "dry_run": args.dry_run,
        }
        write_latest(summary)
        print(json.dumps(summary, indent=2))
        return 4

    raw_proof_path = str(Path(args.raw_proof_path).expanduser().resolve()) if args.raw_proof_path else str(input_path)
    rows = parse_items(input_path.read_text(), cu_capture_at, raw_proof_path)
    legacy_duplicates_dismissed = 0
    stale_pipe_rows_resolved = 0
    if rows and not args.dry_run:
        scanner = load_scanner_module()
        env = scanner.load_env()
        scanner.sb_request(env, "POST", "/supreme_outstanding_items", rows)
        legacy_duplicates_dismissed = dismiss_legacy_duplicates(scanner, env, rows)
        stale_pipe_rows_resolved = resolve_stale_pipe_rows(scanner, env, rows)

    summary = {
        "ok": True,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "input_path": str(input_path),
        "cu_capture_at": cu_capture_at,
        "raw_proof_path": raw_proof_path,
        "source": PIPE_SOURCE,
        "rows_ready": len(rows),
        "upserted": 0 if args.dry_run else len(rows),
        "legacy_duplicates_dismissed": legacy_duplicates_dismissed,
        "stale_pipe_rows_resolved": stale_pipe_rows_resolved,
        "dry_run": args.dry_run,
        "latest_path": str(LATEST_JSON),
        "row_ids": [row["id"] for row in rows],
    }
    write_latest(summary)
    if args.quiet:
        print(json.dumps({k: summary[k] for k in ("ok", "source", "rows_ready", "upserted", "dry_run")}, indent=2))
    else:
        print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
