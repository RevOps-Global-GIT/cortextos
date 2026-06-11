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
