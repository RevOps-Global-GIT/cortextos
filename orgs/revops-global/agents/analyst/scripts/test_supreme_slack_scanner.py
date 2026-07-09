#!/usr/bin/env python3
"""Unit tests for supreme-slack-scanner.py conversation heuristics.

Run: python3 orgs/revops-global/agents/analyst/scripts/test_supreme_slack_scanner.py
Exits 0 on success, 1 on first failure.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

SCANNER_PATH = Path(__file__).resolve().parent / "supreme-slack-scanner.py"
spec = importlib.util.spec_from_file_location("supreme_slack_scanner", SCANNER_PATH)
scanner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scanner)

GREG = scanner.GREG_USER_ID
MARI = "U0MARIMCM"


def msg(user: str, ts: str, text: str, subtype: str | None = None) -> dict:
    out = {"user": user, "ts": ts, "text": text}
    if subtype:
        out["subtype"] = subtype
    return out


def test_question_masked_by_bare_url_followup() -> None:
    """Regression: Mari's 23:30Z question must not be masked by her 23:55Z bare URL."""
    msgs = [
        msg(MARI, "1781134500.000100", "Hey Greg, can you confirm the Q3 attribution model is final?"),
        msg(MARI, "1781136000.000200", "https://docs.google.com/spreadsheets/d/abc123"),
    ]
    flagged = scanner.oldest_unanswered_actionable(msgs)
    assert flagged is not None, "unanswered question masked by non-actionable follow-up"
    assert flagged["ts"] == "1781134500.000100", f"expected the question flagged, got {flagged['ts']}"


def test_answered_dm_not_flagged() -> None:
    msgs = [
        msg(MARI, "1781134500.000100", "Can you confirm the model?"),
        msg(GREG, "1781135000.000200", "Confirmed, it's final."),
    ]
    assert scanner.oldest_unanswered_actionable(msgs) is None


def test_question_after_greg_reply_is_flagged() -> None:
    msgs = [
        msg(MARI, "1781134500.000100", "Can you confirm the model?"),
        msg(GREG, "1781135000.000200", "Confirmed."),
        msg(MARI, "1781136000.000300", "Thanks! And who owns the rollout?"),
    ]
    flagged = scanner.oldest_unanswered_actionable(msgs)
    assert flagged is not None
    assert flagged["ts"] == "1781136000.000300"


def test_only_non_actionable_outstanding_not_flagged() -> None:
    msgs = [
        msg(GREG, "1781134000.000050", "Here you go."),
        msg(MARI, "1781134500.000100", "thanks!"),
        msg(MARI, "1781136000.000200", "https://example.com/doc"),
    ]
    assert scanner.oldest_unanswered_actionable(msgs) is None


def test_oldest_of_multiple_questions_flagged() -> None:
    msgs = [
        msg(MARI, "1781136000.000300", "Also, when can we ship?"),
        msg(MARI, "1781134500.000100", "Who owns the rollout?"),
    ]
    flagged = scanner.oldest_unanswered_actionable(msgs)
    assert flagged is not None
    assert flagged["ts"] == "1781134500.000100", "must flag oldest unanswered question regardless of input order"


def test_subtype_and_userless_messages_ignored() -> None:
    msgs = [
        msg(MARI, "1781134500.000100", "Mari joined the channel?", subtype="channel_join"),
        {"ts": "1781134600.000150", "text": "can you check this bot ping?"},
    ]
    assert scanner.oldest_unanswered_actionable(msgs) is None


def test_action_verb_without_question_mark_flagged() -> None:
    msgs = [msg(MARI, "1781134500.000100", "please review the deck before Friday")]
    flagged = scanner.oldest_unanswered_actionable(msgs)
    assert flagged is not None


def test_empty_conversation() -> None:
    assert scanner.oldest_unanswered_actionable([]) is None


def test_greg_is_latest_sender_returns_true_when_greg_most_recent() -> None:
    """greg_is_latest_sender_in_dm returns True when Greg sent the last real message."""
    original_slack_get = scanner.slack_get
    try:
        scanner.slack_get = lambda token, method, params: {
            "ok": True,
            "messages": [
                {"user": GREG, "ts": "1781140000.000300", "text": "Got it, thanks."},
                {"user": MARI, "ts": "1781139000.000200", "text": "can you review this?"},
                {"user": MARI, "ts": "1781138000.000100", "text": "hey"},
            ],
        }
        assert scanner.greg_is_latest_sender_in_dm("token", "CH123") is True
    finally:
        scanner.slack_get = original_slack_get


def test_greg_is_latest_sender_returns_false_when_non_greg_most_recent() -> None:
    """greg_is_latest_sender_in_dm returns False when a non-Greg user sent the last message."""
    original_slack_get = scanner.slack_get
    try:
        scanner.slack_get = lambda token, method, params: {
            "ok": True,
            "messages": [
                {"user": MARI, "ts": "1781140000.000300", "text": "can you review this?"},
                {"user": GREG, "ts": "1781139000.000200", "text": "Sure, on it."},
            ],
        }
        assert scanner.greg_is_latest_sender_in_dm("token", "CH123") is False
    finally:
        scanner.slack_get = original_slack_get


def test_greg_is_latest_sender_fails_open_on_api_error() -> None:
    """greg_is_latest_sender_in_dm returns False (fail-open) when API call fails."""
    original_slack_get = scanner.slack_get
    try:
        scanner.slack_get = lambda token, method, params: {"ok": False, "error": "channel_not_found"}
        assert scanner.greg_is_latest_sender_in_dm("token", "CH123") is False
    finally:
        scanner.slack_get = original_slack_get


def test_greg_is_latest_sender_skips_subtype_messages() -> None:
    """greg_is_latest_sender_in_dm ignores subtype messages when finding latest sender."""
    original_slack_get = scanner.slack_get
    try:
        scanner.slack_get = lambda token, method, params: {
            "ok": True,
            "messages": [
                {"subtype": "channel_join", "ts": "1781141000.000400", "text": "joined"},
                {"user": MARI, "ts": "1781140000.000300", "text": "can you review this?"},
                {"user": GREG, "ts": "1781139000.000200", "text": "Sure."},
            ],
        }
        assert scanner.greg_is_latest_sender_in_dm("token", "CH123") is False
    finally:
        scanner.slack_get = original_slack_get


def test_dm_search_raises_on_api_failure() -> None:
    """Regression: a not-ok search.messages(is:dm) must raise ScanFetchFailed rather than
    return [] — swallowing it made a failed scan look like inbox-zero and wiped the view."""
    original_slack_get = scanner.slack_get
    try:
        scanner.slack_get = lambda token, method, params: {"ok": False, "error": "invalid_auth"}
        raised = False
        try:
            scanner.slack_search_dms("token", 3600)
        except scanner.ScanFetchFailed:
            raised = True
        assert raised, "slack_search_dms swallowed an API failure instead of raising"
    finally:
        scanner.slack_get = original_slack_get


def test_mention_search_raises_on_api_failure() -> None:
    """Regression: a not-ok search.messages(mentions) must raise ScanFetchFailed rather than
    break and return partial/empty matches."""
    original_slack_get = scanner.slack_get
    try:
        scanner.slack_get = lambda token, method, params: {"ok": False, "error": "ratelimited"}
        raised = False
        try:
            scanner.slack_search_mentions("token", 3600)
        except scanner.ScanFetchFailed:
            raised = True
        assert raised, "slack_search_mentions swallowed an API failure instead of raising"
    finally:
        scanner.slack_get = original_slack_get


def test_upsert_resolves_superseded_when_empty() -> None:
    """A successful but empty scan must still resolve superseded rows (close-out),
    not no-op — otherwise stale 'open' rows accumulate forever (214 had piled up)."""
    calls = []
    original_sb = scanner.sb_request
    try:
        scanner.sb_request = lambda env, method, path, body=None: calls.append((method, path, body))
        snapshot = {"generated_at": "2026-07-09T16:15:00+00:00",
                    "workspace_team_id": scanner.SLACK_TEAM_ID, "items": []}
        scanner.upsert_supabase({}, snapshot)
        methods = [c[0] for c in calls]
        assert "POST" not in methods, "must not POST when there are no items"
        assert "PATCH" in methods, "empty scan must still resolve superseded rows"
        patch = next(c for c in calls if c[0] == "PATCH")
        assert "status=neq.resolved" in patch[1] and "scanned_at=lt." in patch[1], patch[1]
        assert patch[2] == {"status": "resolved"}
    finally:
        scanner.sb_request = original_sb


def test_upsert_posts_then_resolves_when_items_present() -> None:
    """With items, the scan POSTs the current set then resolves anything it did not
    re-stamp (scanned_at < this run) — the just-upserted rows are preserved."""
    calls = []
    original_sb = scanner.sb_request
    try:
        scanner.sb_request = lambda env, method, path, body=None: calls.append((method, path, body))
        item = {"id": "x", "source": "dm", "status": "unanswered", "channel_id": "C",
                "channel_name": "DM", "sender_id": "U", "sender_name": "n",
                "message_preview": "p", "message_ts": "1", "age_seconds": 1,
                "slack_url": "u", "is_question": True, "is_replied_by_greg": False}
        snapshot = {"generated_at": "2026-07-09T16:15:00+00:00",
                    "workspace_team_id": scanner.SLACK_TEAM_ID, "items": [item]}
        scanner.upsert_supabase({}, snapshot)
        assert [c[0] for c in calls] == ["POST", "PATCH"], [c[0] for c in calls]
    finally:
        scanner.sb_request = original_sb


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        try:
            t()
            print(f"PASS {t.__name__}")
        except AssertionError as e:
            print(f"FAIL {t.__name__}: {e}")
            sys.exit(1)
    print(f"{len(tests)} tests passed")
    sys.exit(0)
