#!/usr/bin/env python3
"""
supreme-slack-scanner.py

Daily scan of the Supreme Slack workspace for Greg's outstanding items.

Walks every conversation Greg is a member of (DMs, MPIMs, public + private
channels), pulls recent messages, and applies four heuristics to extract
items that need Greg's attention:
  - DM unanswered: DM where last non-Greg message has no Greg reply
  - Channel mention: @-mention of Greg in channel
  - Thread mention: @-mention of Greg in a thread reply
  - Action item: @-mention + verb phrasing ("can you", "please", "let's", ...)

Writes results to:
  1. Supabase table `supreme_outstanding_items` (idempotent upsert via id)
  2. agents/analyst/output/supreme-outstanding-latest.json (atomic snapshot)
  3. agents/analyst/output/supreme-outstanding-digest.txt (Telegram digest text)

Auth: reads slack_tokens row for workspace='supreme-opti', refreshes via
oauth.v2.access when token is within 30 min of expiry.

Usage:
    python3 scripts/supreme-slack-scanner.py
    python3 scripts/supreme-slack-scanner.py --since-hours 48 --dry-run
    python3 scripts/supreme-slack-scanner.py --on-demand   # tagged for UI

Requires env (from orgs/revops-global/secrets.env):
    SUPABASE_RGOS_URL, SUPABASE_RGOS_SERVICE_KEY,
    SLACK_CLIENT_ID, SLACK_CLIENT_SECRET
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

WORKSPACE = "supreme-opti"
GREG_USER_ID = "U07JRUWSPN2"
SLACK_TEAM_ID = "T08G932PM"  # Supreme Optimization team_id verified via auth.test on 2026-05-20
SLACK_DOMAIN = "supremeopti"   # for building https://{domain}.slack.com/archives/...

REPO_ROOT = Path(__file__).resolve().parent.parent
OUTPUT_DIR = REPO_ROOT / "output"
LATEST_JSON = OUTPUT_DIR / "supreme-outstanding-latest.json"
DIGEST_TXT = OUTPUT_DIR / "supreme-outstanding-digest.txt"
HISTORY_DIR = OUTPUT_DIR / "supreme-outstanding-history"
SUPPRESSION_JSON = OUTPUT_DIR / "supreme-triage-suppressed.json"

TOKEN_REFRESH_BUFFER_SECS = 30 * 60
DEFAULT_SINCE_HOURS = 48
MAX_CONVERSATIONS = 200
MAX_MESSAGES_PER_CONV = 100
API_DELAY_MS = 1200
SLACK_MAX_RETRIES = 3
# Wall-clock budget for the scan() function. Cap total elapsed time so a sustained
# Slack 429 storm fails fast (recorded as scanner_timeout in scanner_triggers) instead
# of looping ~55 min as observed 2026-05-29. Override via SUPREME_SCANNER_BUDGET_SECS.
SCAN_WALL_CLOCK_BUDGET_SECS = int(os.environ.get("SUPREME_SCANNER_BUDGET_SECS", "300"))


class ScanBudgetExceeded(Exception):
    """Raised when scan() exceeds SCAN_WALL_CLOCK_BUDGET_SECS — caller should record a
    scanner_timeout failure instead of returning partial results that look successful."""


RATE_LIMIT_SLEEP_BUDGET_SECS: int = int(
    os.environ.get("SUPREME_SCANNER_RATE_LIMIT_BUDGET_SECS", "120")
)


class ScanRateLimited(Exception):
    """Raised when cumulative 429 sleep exceeds RATE_LIMIT_SLEEP_BUDGET_SECS, or when a
    single Retry-After header exceeds 60 s. Peer to ScanBudgetExceeded; caller exits 3."""


class ScanFetchFailed(Exception):
    """Raised when a required search.messages fetch returns not-ok (expired/revoked token,
    ratelimited body, transient Slack error). Previously these were swallowed into an empty
    result, so a failed scan looked identical to "inbox zero": items=[] → exit 0 → the cron
    wrapper marked the scanner_triggers row 'completed' → supreme_outstanding_open_24h's
    latest-completed-scan watermark advanced past the last good batch and orphaned every
    still-open row (dashboard + triage flipped to 0). Surfacing the failure lets main() exit
    non-zero so the wrapper records a FAILED trigger; the view then keeps the last completed
    scan's items instead of wiping them. Caller exits 4."""


_rl_state: Dict[str, int] = {"sleep_spent": 0}

REQUIRED_ENV_KEYS = (
    "SUPABASE_RGOS_URL",
    "SUPABASE_RGOS_SERVICE_KEY",
    "SLACK_CLIENT_ID",
    "SLACK_CLIENT_SECRET",
)

ACTION_VERB_RE = re.compile(
    r"\b(can you|could you|would you|please|let'?s|action(?: item)?:?|todo|TODO|owner:?)\b",
    re.IGNORECASE,
)
QUESTION_RE = re.compile(r"\?\s*$")
DIRECT_QUESTION_RE = re.compile(
    r"\b(are you|can you|could you|would you|will you|do you|did you|have you|"
    r"are we|can we|should we|would we|will we|who is responsible|who owns|"
    r"who can|who will|when can we|when can you|when should we|when will|"
    r"what does this mean|what do we|what should we|what is the plan|"
    r"where do we|which team|any update|next steps?)\b",
    re.IGNORECASE,
)
USER_MENTION_RE = re.compile(r"<@([UW][A-Z0-9]+)(?:\|[^>]+)?>")
_last_source_activity_count = 0


# -- env loading --------------------------------------------------------------

def load_env() -> Dict[str, str]:
    env_path = Path("/home/cortextos/cortextos/orgs/revops-global/secrets.env")
    out: Dict[str, str] = {}
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            out[k.strip()] = v.strip()
    for k in REQUIRED_ENV_KEYS:
        if not out.get(k):
            out[k] = os.environ.get(k, "")
    return out


# -- supabase helpers ---------------------------------------------------------

def sb_request(env: Dict[str, str], method: str, path: str, body: Any = None) -> Any:
    url = f"{env['SUPABASE_RGOS_URL']}/rest/v1{path}"
    headers = {
        "apikey": env["SUPABASE_RGOS_SERVICE_KEY"],
        "Authorization": f"Bearer {env['SUPABASE_RGOS_SERVICE_KEY']}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=30) as r:
        text = r.read().decode()
        return json.loads(text) if text else None


# -- slack token management ---------------------------------------------------

def get_token(env: Dict[str, str]) -> str:
    rows = sb_request(env, "GET", f"/slack_tokens?workspace=eq.{WORKSPACE}&select=*")
    if not rows:
        raise RuntimeError(f"no slack_tokens row for workspace={WORKSPACE}")
    rec = rows[0]
    if rec.get("expires_at"):
        expires = datetime.fromisoformat(rec["expires_at"].replace("Z", "+00:00"))
        now = datetime.now(timezone.utc)
        if (expires - now).total_seconds() < TOKEN_REFRESH_BUFFER_SECS:
            return refresh_token(env, rec["refresh_token"])
    return rec["access_token"]


def refresh_token(env: Dict[str, str], refresh: str) -> str:
    params = urllib.parse.urlencode({
        "client_id": env["SLACK_CLIENT_ID"],
        "client_secret": env["SLACK_CLIENT_SECRET"],
        "grant_type": "refresh_token",
        "refresh_token": refresh,
    }).encode()
    req = urllib.request.Request(
        "https://slack.com/api/oauth.v2.access",
        data=params,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        d = json.loads(r.read().decode())
    if not d.get("ok"):
        raise RuntimeError(f"token refresh failed: {d.get('error')}")

    # Slack token rotation can return user tokens either top-level or under
    # authed_user depending on the install surface/API version.
    token_payload = d.get("authed_user") if isinstance(d.get("authed_user"), dict) else d
    access_token = token_payload.get("access_token")
    refresh_token_value = token_payload.get("refresh_token")
    expires_in = token_payload.get("expires_in") or d.get("expires_in")
    if not access_token or not refresh_token_value or not expires_in:
        raise RuntimeError("token refresh failed: missing rotated token fields")

    expires_at = datetime.fromtimestamp(
        time.time() + int(expires_in), tz=timezone.utc
    ).isoformat()
    sb_request(env, "POST", "/slack_tokens", {
        "workspace": WORKSPACE,
        "access_token": access_token,
        "refresh_token": refresh_token_value,
        "expires_at": expires_at,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    })
    return access_token


# -- slack api helpers --------------------------------------------------------

def slack_get(token: str, method: str, params: Dict[str, str]) -> Dict[str, Any]:
    qs = urllib.parse.urlencode(params)
    url = f"https://slack.com/api/{method}?{qs}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    for attempt in range(SLACK_MAX_RETRIES + 1):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < SLACK_MAX_RETRIES:
                retry_after = int(e.headers.get("Retry-After") or "30")
                if retry_after > 60:
                    raise ScanRateLimited(
                        f"Retry-After {retry_after}s exceeds single-request bail threshold"
                    )
                projected = _rl_state["sleep_spent"] + retry_after
                if projected > RATE_LIMIT_SLEEP_BUDGET_SECS:
                    raise ScanRateLimited(
                        f"cumulative rate-limit sleep {projected}s would exceed "
                        f"budget {RATE_LIMIT_SLEEP_BUDGET_SECS}s"
                    )
                print(
                    f"[scanner] Slack rate limited {method}; sleeping {retry_after}s "
                    f"(cumulative {projected}s / {RATE_LIMIT_SLEEP_BUDGET_SECS}s budget)",
                    file=sys.stderr,
                )
                time.sleep(retry_after)
                _rl_state["sleep_spent"] += retry_after
                continue
            return {"ok": False, "error": f"http_{e.code}"}
    return {"ok": False, "error": "retry_exhausted"}


def slack_paginate(token: str, method: str, params: Dict[str, str], item_key: str,
                   max_pages: int = 20) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    cursor = ""
    for _ in range(max_pages):
        p = dict(params)
        if cursor:
            p["cursor"] = cursor
        d = slack_get(token, method, p)
        if not d.get("ok"):
            break
        out.extend(d.get(item_key) or [])
        cursor = (d.get("response_metadata") or {}).get("next_cursor") or ""
        if not cursor:
            break
        time.sleep(API_DELAY_MS / 1000)
    return out


# -- heuristics ---------------------------------------------------------------

def display_name(user: Dict[str, Any]) -> str:
    profile = user.get("profile") or {}
    return (
        profile.get("display_name_normalized")
        or profile.get("display_name")
        or profile.get("real_name_normalized")
        or profile.get("real_name")
        or user.get("real_name")
        or user.get("name")
        or ""
    )


def build_user_map(token: str) -> Dict[str, str]:
    users = slack_paginate(token, "users.list", {"limit": "200"}, "members", max_pages=20)
    out: Dict[str, str] = {}
    for user in users:
        uid = user.get("id")
        if uid:
            out[uid] = display_name(user) or uid
    return out

def mentions_greg(text: str) -> bool:
    if not text:
        return False
    return GREG_USER_ID in USER_MENTION_RE.findall(text)


def is_question(text: str) -> bool:
    return bool(text) and bool(QUESTION_RE.search(text.strip()))


def is_direct_question(text: str) -> bool:
    if not text or not mentions_greg(text):
        return False
    return is_question(text) or bool(DIRECT_QUESTION_RE.search(text))


def is_action_item(text: str) -> bool:
    if not text or not mentions_greg(text):
        return False
    return bool(ACTION_VERB_RE.search(text))


def unanswered_direct_question(is_dm: bool, is_mpim: bool, text: str,
                               last_thread_user: Optional[str]) -> bool:
    return (
        (is_dm or is_mpim)
        and is_direct_question(text)
        and last_thread_user != GREG_USER_ID
    )


def is_actionable_text(text: str) -> bool:
    return bool(text) and (is_question(text) or bool(ACTION_VERB_RE.search(text)))


def unanswered_candidates_after_greg(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Non-Greg, non-subtype messages sent after Greg's last message."""
    greg_last_ts = max(
        (float(m.get("ts") or 0) for m in messages if m.get("user") == GREG_USER_ID),
        default=0.0,
    )
    return [
        m for m in messages
        if m.get("user")
        and m.get("user") != GREG_USER_ID
        and not m.get("subtype")
        and float(m.get("ts") or 0) > greg_last_ts
    ]


def oldest_unanswered_actionable(messages: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Oldest actionable non-Greg message sent after Greg's last message, or None."""
    candidates = [
        m for m in unanswered_candidates_after_greg(messages)
        if is_actionable_text(m.get("text") or "")
    ]
    if not candidates:
        return None
    return min(candidates, key=lambda m: float(m.get("ts") or 0))


def message_preview(text: str, user_lookup: Optional[Dict[str, str]] = None, cap: int = 280) -> str:
    if not text:
        return ""

    def replace_user(match: re.Match[str]) -> str:
        uid = match.group(1)
        name = (user_lookup or {}).get(uid) or uid
        return f"@{name}"

    t = USER_MENTION_RE.sub(replace_user, text)
    t = re.sub(r"\s+", " ", t).strip()
    return t[:cap]


def slack_url(channel_id: str, ts: str) -> str:
    ts_part = "p" + ts.replace(".", "")
    return f"https://{SLACK_DOMAIN}.slack.com/archives/{channel_id}/{ts_part}"


def stable_id(channel_id: str, ts: str) -> str:
    return f"supreme-{channel_id}-{ts}"


def unique_messages(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    seen = set()
    out: List[Dict[str, Any]] = []
    for msg in messages:
        ts = msg.get("ts")
        if not ts or ts in seen:
            continue
        seen.add(ts)
        out.append(msg)
    return out


def pinned_messages(token: str, channel_id: str) -> List[Dict[str, Any]]:
    pins = slack_get(token, "pins.list", {"channel": channel_id})
    if not pins.get("ok"):
        return []
    messages: List[Dict[str, Any]] = []
    for item in pins.get("items") or []:
        msg = item.get("message") if isinstance(item, dict) else None
        if isinstance(msg, dict) and msg.get("ts"):
            messages.append(msg)
    return messages


def greg_is_latest_sender_in_dm(token: str, ch_id: str) -> bool:
    """1x conversations.history probe to verify Greg is NOT the most recent sender.

    Called only for DM channels that already have flagged candidates from
    unanswered_candidates_after_greg(). Prevents false-positives when Greg's
    last reply predates the search.messages day-boundary window, causing
    greg_last_ts to default to 0.0 and every non-Greg message to be flagged.

    Returns True if Greg sent the most recent real message (caller should suppress).
    Fails open: returns False on API error so the item is still surfaced.
    """
    result = slack_get(token, "conversations.history", {
        "channel": ch_id,
        "limit": "3",
        "inclusive": "true",
    })
    if not result.get("ok"):
        return False
    messages = [
        m for m in (result.get("messages") or [])
        if not m.get("subtype") and m.get("user")
    ]
    if not messages:
        return False
    return messages[0].get("user") == GREG_USER_ID


# -- scan ---------------------------------------------------------------------

def slack_search_dms(token: str, since_seconds: int) -> List[Dict[str, Any]]:
    """Find recent DM messages using search.messages with is:dm filter.

    Replaces the per-DM conversations.history loop (was 66 calls → sustained 429s).
    users.conversations does not return 'latest' for IM channels so the pre-filter
    was always a no-op. search.messages is:dm is 1-3 calls regardless of DM count.

    Returns all DM messages in the window. Caller groups by channel to find the
    latest message per DM and determine unanswered state.
    """
    since_ts = time.time() - since_seconds
    since_date = datetime.fromtimestamp(since_ts, tz=timezone.utc).strftime("%Y-%m-%d")
    query = f"is:dm after:{since_date}"
    matches: List[Dict[str, Any]] = []
    page = 1
    while True:
        result = slack_get(token, "search.messages", {
            "query": query,
            "count": "100",
            "page": str(page),
            "sort": "timestamp",
            "sort_dir": "desc",
        })
        if not result.get("ok"):
            # Do NOT swallow into an empty result: an empty DM scan is
            # indistinguishable from "inbox zero" and would let the watermark wipe
            # every still-open row. Fail loud so main() exits non-zero and the
            # trigger is recorded FAILED (watermark holds at the last good scan).
            raise ScanFetchFailed(f"search.messages(is:dm): {result.get('error')}")
        msg_block = result.get("messages") or {}
        page_matches = msg_block.get("matches") or []
        for m in page_matches:
            ts = float(m.get("ts") or 0)
            if ts >= since_ts:
                matches.append(m)
        paging = msg_block.get("paging") or {}
        if page >= paging.get("pages", 1):
            break
        page += 1
        time.sleep(API_DELAY_MS / 1000)
    print(f"[scanner] DM search: {len(matches)} msgs", file=sys.stderr)
    return matches


def slack_search_mentions(token: str, since_seconds: int) -> List[Dict[str, Any]]:
    """Find @-mentions of Greg using search.messages (Tier 2, 1-3 API calls vs 200+).

    Replaces the per-channel conversations.history loop for channel/MPIM detection.
    """
    since_ts = time.time() - since_seconds
    since_date = datetime.fromtimestamp(since_ts, tz=timezone.utc).strftime("%Y-%m-%d")
    query = f"<@{GREG_USER_ID}> after:{since_date}"
    matches: List[Dict[str, Any]] = []
    page = 1
    while True:
        result = slack_get(token, "search.messages", {
            "query": query,
            "count": "100",
            "page": str(page),
            "sort": "timestamp",
            "sort_dir": "desc",
        })
        if not result.get("ok"):
            # See slack_search_dms: a not-ok mention search (including a mid-pagination
            # failure) means the scan is incomplete. Discarding partial pages and failing
            # loud is safer than under-reporting, which would wipe still-open items.
            raise ScanFetchFailed(f"search.messages(mentions): {result.get('error')}")
        msg_block = result.get("messages") or {}
        page_matches = msg_block.get("matches") or []
        for m in page_matches:
            ts = float(m.get("ts") or 0)
            if ts >= since_ts:
                matches.append(m)
        paging = msg_block.get("paging") or {}
        if page >= paging.get("pages", 1):
            break
        page += 1
        time.sleep(API_DELAY_MS / 1000)
    print(f"[scanner] search found {len(matches)} @-mentions of Greg", file=sys.stderr)
    return matches


def scan(token: str, since_seconds: int) -> List[Dict[str, Any]]:
    global _last_source_activity_count
    _last_source_activity_count = 0
    since_ts = time.time() - since_seconds
    scan_start = time.time()
    items: List[Dict[str, Any]] = []

    def check_budget() -> None:
        elapsed = time.time() - scan_start
        if elapsed > SCAN_WALL_CLOCK_BUDGET_SECS:
            raise ScanBudgetExceeded(
                f"scan exceeded wall-clock budget: {elapsed:.0f}s > {SCAN_WALL_CLOCK_BUDGET_SECS}s "
                f"(likely sustained Slack 429 rate-limit storm; partial results discarded)"
            )

    # Resolve user display names for both sender labels and @mention previews.
    user_cache: Dict[str, str] = build_user_map(token)

    def user_name(uid: Optional[str]) -> str:
        if not uid:
            return "unknown"
        if uid in user_cache:
            return user_cache[uid]
        d = slack_get(token, "users.info", {"user": uid})
        name = display_name(d.get("user") or {}) or uid
        user_cache[uid] = name
        return name

    def hydrate_mentions(text: str) -> None:
        for uid in set(USER_MENTION_RE.findall(text or "")):
            user_name(uid)

    # --- DM scan: unanswered detection via search.messages is:dm ---
    # Replaces the previous 66x conversations.history loop that caused sustained 429s.
    # users.conversations(types=im) never returns 'latest' for IM channels, making
    # the pre-filter a no-op. search.messages is:dm uses 1-3 calls regardless of DM count.
    #
    # Strategy: search returns DM messages newest-first. Group by channel, then
    # evaluate EVERY non-Greg message sent after Greg's last reply in that DM.
    # Checking only the newest message masks unanswered questions whenever a
    # non-actionable follow-up (bare URL, "thanks") arrives after the question.
    dm_msgs = slack_search_dms(token, since_seconds)
    dm_by_channel: Dict[str, List[Dict[str, Any]]] = {}
    for m in dm_msgs:
        ch_obj = m.get("channel") or {}
        ch_id = ch_obj.get("id", "") if isinstance(ch_obj, dict) else str(ch_obj)
        if not ch_id:
            continue
        dm_by_channel.setdefault(ch_id, []).append(m)

    for ch_id, ch_msgs in dm_by_channel.items():
        check_budget()
        flag_msgs = unanswered_candidates_after_greg(ch_msgs)
        if not flag_msgs:
            continue
        # 1x conversations.history probe per flagged channel: search.messages uses a
        # day-boundary window so Greg's reply may predate it — greg_last_ts defaults
        # to 0 and marks every non-Greg message as unanswered. The probe reads the
        # actual 3 most recent messages to verify Greg is NOT the latest sender.
        if greg_is_latest_sender_in_dm(token, ch_id):
            print(
                f"[scanner] DM {ch_id}: history probe confirms Greg is latest sender "
                f"— suppressing {len(flag_msgs)} candidate(s)",
                file=sys.stderr,
            )
            _last_source_activity_count += len(flag_msgs)
            continue
        _last_source_activity_count += len(flag_msgs)
        for flag_msg in flag_msgs:
            _dm_text = flag_msg.get("text") or ""
            ch_name = f"DM:{user_name(flag_msg.get('user'))}"
            hydrate_mentions(_dm_text)
            items.append(build_item(
                source="dm",
                status="unanswered",
                channel_id=ch_id,
                channel_name=ch_name,
                msg=flag_msg,
                sender_name=user_name(flag_msg.get("user")),
                user_lookup=user_cache,
            ))

    check_budget()

    # --- Channel/MPIM mention scan: search.messages (Tier 2, 1-3 calls total) ---
    # Replaces the previous 200-call conversations.history loop. Cuts API surface
    # from O(conversations) to O(mention-pages), eliminating the sustained 429 storm.
    search_matches = slack_search_mentions(token, since_seconds)
    _last_source_activity_count += sum(
        1
        for m in search_matches
        if m.get("user")
        and m.get("user") != GREG_USER_ID
        and not m.get("subtype")
    )

    for m in search_matches:
        check_budget()
        if m.get("user") == GREG_USER_ID:
            continue
        text = m.get("text") or ""
        if not mentions_greg(text):
            continue

        ch_obj = m.get("channel") or {}
        if isinstance(ch_obj, str):
            ch_id, ch_name, is_mpim = ch_obj, ch_obj, False
        else:
            ch_id = ch_obj.get("id", "")
            ch_name = ch_obj.get("name") or ch_id
            is_mpim = bool(ch_obj.get("is_mpim"))
            if ch_obj.get("is_im"):
                continue  # DMs handled above

        if not ch_id:
            continue

        hydrate_mentions(text)
        replied = False
        last_thread_user = m.get("user")
        followup_msg: Optional[Dict[str, Any]] = None
        if m.get("reply_count", 0):
            reps = slack_get(token, "conversations.replies", {
                "channel": ch_id,
                "ts": m.get("ts", ""),
                "limit": "50",
            })
            thread_messages = reps.get("messages") or []
            last_thread_user = next(
                (r.get("user") for r in reversed(thread_messages) if not r.get("subtype")),
                last_thread_user,
            )
            replied = any(r.get("user") == GREG_USER_ID for r in thread_messages[1:])
            # Same masking flaw as DMs: Greg's earlier thread reply must not bury
            # an actionable follow-up posted after it.
            followup_msg = oldest_unanswered_actionable(thread_messages[1:])
            time.sleep(API_DELAY_MS / 1000)

        direct_unanswered = unanswered_direct_question(False, is_mpim, text, last_thread_user)
        if replied and not direct_unanswered and followup_msg is None:
            continue

        if replied and not direct_unanswered and followup_msg is not None:
            followup_text = followup_msg.get("text") or ""
            hydrate_mentions(followup_text)
            items.append(build_item(
                source="thread_mention",
                status="unanswered",
                channel_id=ch_id,
                channel_name=ch_name,
                msg=followup_msg,
                sender_name=user_name(followup_msg.get("user")),
                user_lookup=user_cache,
                is_replied_by_greg=False,
            ))
            continue

        if direct_unanswered:
            source = "channel_mention"
            status = "unanswered"
        elif is_action_item(text):
            source = "action_item"
            status = "action_item"
        elif m.get("thread_ts") and m.get("thread_ts") != m.get("ts"):
            source = "thread_mention"
            status = "mentioned"
        else:
            source = "channel_mention"
            status = "mentioned"

        items.append(build_item(
            source=source,
            status=status,
            channel_id=ch_id,
            channel_name=ch_name,
            msg=m,
            sender_name=user_name(m.get("user")),
            user_lookup=user_cache,
            is_replied_by_greg=replied,
        ))

    # Filter out items Greg has manually actioned (suppression list)
    suppressed = load_suppression_list()
    if suppressed:
        before = len(items)
        items = [i for i in items if i["id"] not in suppressed]
        filtered = before - len(items)
        if filtered:
            print(f"[scanner] suppression filter: {filtered} item(s) removed", file=sys.stderr)

    # Filter out items where Greg already replied in-thread (safety net for is_replied_by_greg=True)
    items = [i for i in items if not i.get("is_replied_by_greg")]

    return items


def build_item(source: str, status: str, channel_id: str, channel_name: str,
               msg: Dict[str, Any], sender_name: str,
               user_lookup: Optional[Dict[str, str]] = None,
               is_replied_by_greg: bool = False) -> Dict[str, Any]:
    ts = msg.get("ts", "")
    text = msg.get("text") or ""
    age = int(time.time() - float(ts)) if ts else 0
    return {
        "id": stable_id(channel_id, ts),
        "source": source,
        "status": status,
        "channel_id": channel_id,
        "channel_name": channel_name,
        "sender_id": msg.get("user"),
        "sender_name": sender_name,
        "message_preview": message_preview(text, user_lookup),
        "message_ts": ts,
        "age_seconds": age,
        "slack_url": slack_url(channel_id, ts),
        "is_question": is_question(text),
        "is_replied_by_greg": is_replied_by_greg,
    }


def load_suppression_list() -> set:
    """Return set of item IDs that have been manually marked as actioned by Greg."""
    if not SUPPRESSION_JSON.exists():
        return set()
    try:
        data = json.loads(SUPPRESSION_JSON.read_text())
        return set(data.get("suppressed", {}).keys())
    except Exception:
        return set()


def suppress_items(item_ids: List[str], reason: str = "greg_actioned", note: str = "") -> None:
    """Add item IDs to the suppression list (atomic write)."""
    data: Dict[str, Any] = {}
    if SUPPRESSION_JSON.exists():
        try:
            data = json.loads(SUPPRESSION_JSON.read_text())
        except Exception:
            pass
    data.setdefault("suppressed", {})
    now = datetime.now(timezone.utc).isoformat()
    for item_id in item_ids:
        data["suppressed"][item_id] = {"suppressed_at": now, "reason": reason, "note": note}
    tmp = SUPPRESSION_JSON.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2))
    tmp.replace(SUPPRESSION_JSON)


# -- output -------------------------------------------------------------------

def write_snapshot(items: List[Dict[str, Any]], on_demand: bool) -> Dict[str, Any]:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    HISTORY_DIR.mkdir(parents=True, exist_ok=True)
    snapshot = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "workspace_team_id": SLACK_TEAM_ID,
        "scanner_version": "1.0",
        "scan_trigger": "on_demand" if on_demand else "cron",
        "total_count": len(items),
        "items": sorted(items, key=lambda x: -x["age_seconds"]),
    }
    # atomic write to latest
    tmp = LATEST_JSON.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(snapshot, indent=2))
    tmp.replace(LATEST_JSON)
    # also write date-stamped copy for history
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    (HISTORY_DIR / f"supreme-outstanding-{today}.json").write_text(json.dumps(snapshot, indent=2))
    return snapshot


def upsert_supabase(env: Dict[str, str], snapshot: Dict[str, Any]) -> None:
    if not snapshot["items"]:
        return
    rows = []
    for it in snapshot["items"]:
        rows.append({
            "id": it["id"],
            "scanned_at": snapshot["generated_at"],
            "workspace_team_id": snapshot["workspace_team_id"],
            "source": it["source"],
            "status": it["status"],
            "channel_id": it["channel_id"],
            "channel_name": it["channel_name"],
            "sender_id": it["sender_id"],
            "sender_name": it["sender_name"],
            "message_preview": it["message_preview"],
            "message_ts": it["message_ts"],
            "age_seconds": it["age_seconds"],
            "slack_url": it["slack_url"],
            "is_question": it["is_question"],
            "is_replied_by_greg": it["is_replied_by_greg"],
            "raw_json": it,
        })
    sb_request(env, "POST", "/supreme_outstanding_items", rows)


def write_digest(snapshot: Dict[str, Any]) -> str:
    date_str = datetime.fromisoformat(snapshot["generated_at"]).astimezone().strftime("%Y-%m-%d 08:00 PT")
    lines = [
        f"Supreme Slack — outstanding for Greg ({date_str})",
        f"Total: {snapshot['total_count']} items",
        "",
    ]
    if snapshot["items"]:
        lines.append("Top 10 oldest unresolved:")
        for i, it in enumerate(snapshot["items"][:10], 1):
            age_days = it["age_seconds"] // 86400
            age_hrs = (it["age_seconds"] % 86400) // 3600
            age_str = f"{age_days}d" if age_days else f"{age_hrs}h"
            tag = {
                "dm": f"DM from {it['sender_name']}",
                "channel_mention": f"@-mention in #{it['channel_name']}",
                "thread_mention": f"thread @-mention in #{it['channel_name']}",
                "action_item": f"action item in #{it['channel_name']}",
            }.get(it["source"], it["source"])
            lines.append(f"{i}. [{tag}, {age_str} ago] {it['message_preview'][:140]}")
    else:
        lines.append("Inbox zero today.")
    lines.append("")
    lines.append("Full list: https://hub.revopsglobal.com/app/supreme-outstanding")
    text = "\n".join(lines)
    DIGEST_TXT.write_text(text)
    return text


# -- main ---------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--since-hours", type=int, default=DEFAULT_SINCE_HOURS)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--on-demand", action="store_true",
                    help="Tag the snapshot as triggered by Hub UI rather than cron")
    ap.add_argument("--no-supabase", action="store_true")
    ap.add_argument("--no-digest", action="store_true")
    ap.add_argument("--suppress-ids", nargs="+", metavar="ID",
                    help="Mark item IDs as greg_actioned and exit (no scan)")
    args = ap.parse_args()

    if args.suppress_ids:
        suppress_items(args.suppress_ids, reason="greg_actioned",
                       note="manually suppressed via CLI")
        print(json.dumps({"suppressed": args.suppress_ids, "count": len(args.suppress_ids)}))
        return 0

    env = load_env()
    missing = [k for k in REQUIRED_ENV_KEYS if not env.get(k)]
    if missing:
        print(f"ERROR: missing required env vars: {', '.join(missing)}", file=sys.stderr)
        return 1

    token = get_token(env)
    if not token or not token.startswith(("xoxe.xoxp-", "xoxp-")):
        print(f"ERROR: bad token shape: {token[:20] if token else 'empty'}", file=sys.stderr)
        return 1

    print(
        f"[scanner] starting; since_hours={args.since_hours} "
        f"budget_secs={SCAN_WALL_CLOCK_BUDGET_SECS} "
        f"rate_limit_budget_secs={RATE_LIMIT_SLEEP_BUDGET_SECS}",
        file=sys.stderr,
    )
    try:
        items = scan(token, since_seconds=args.since_hours * 3600)
    except ScanBudgetExceeded as e:
        # Fail-fast surface for sustained Slack 429 storms. The scanner_triggers row
        # written by the cron wrapper will record error_code=scanner_timeout, matching
        # the existing failure-detection contract. Exit 2 distinguishes budget exhaust
        # from a clean exit 0 or env/auth error exit 1.
        print(f"[scanner] ERROR: scanner_timeout — {e}", file=sys.stderr)
        return 2
    except ScanRateLimited as e:
        # Cumulative 429 sleep exceeded budget or a single Retry-After was too large.
        # Exit 3 = rate_limited_budget_exceeded — distinct from wall-clock timeout (2).
        print(f"[scanner] ERROR: rate_limited_budget_exceeded — {e}", file=sys.stderr)
        return 3
    except ScanFetchFailed as e:
        # A required search.messages fetch returned not-ok (e.g. expired/revoked Slack
        # token). Exit 4 = slack_fetch_failed. The cron wrapper records a FAILED
        # scanner_triggers row for any non-zero exit, so the latest-completed-scan
        # watermark does NOT advance and the view keeps the last good batch instead of
        # wiping every still-open item to zero.
        print(f"[scanner] ERROR: slack_fetch_failed — {e}", file=sys.stderr)
        return 4
    print(f"[scanner] found {len(items)} outstanding items", file=sys.stderr)

    if not items and _last_source_activity_count:
        print(
            "[scanner] no outstanding items after suppression — "
            f"source_activity_count={_last_source_activity_count}",
            file=sys.stderr,
        )

    snapshot = write_snapshot(items, on_demand=args.on_demand)

    if not args.no_supabase and not args.dry_run:
        try:
            upsert_supabase(env, snapshot)
            print(f"[scanner] upserted {snapshot['total_count']} rows to supreme_outstanding_items", file=sys.stderr)
        except Exception as e:
            print(f"[scanner] WARN: supabase upsert failed (non-fatal): {e}", file=sys.stderr)

    if not args.no_digest:
        digest = write_digest(snapshot)
        print(f"[scanner] digest written to {DIGEST_TXT}", file=sys.stderr)

    print(json.dumps({
        "generated_at": snapshot["generated_at"],
        "total_count": snapshot["total_count"],
        "by_source": {s: sum(1 for i in snapshot["items"] if i["source"] == s)
                      for s in ("dm", "channel_mention", "thread_mention", "action_item")},
        "snapshot_path": str(LATEST_JSON),
        "digest_path": str(DIGEST_TXT),
    }, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
