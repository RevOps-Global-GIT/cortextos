#!/usr/bin/env python3
"""
css-blast-radius-evidence-rate.py — deterministic CSS blast-radius evidence tracker.

Scans merged PRs (7-day rolling window) across cortextos, rgos, ob1-parents,
team-brain for visual PRs missing render evidence. Appends one row per day to
analyst/output/css-blast-radius-evidence-rate.jsonl.

Visual PR = touches *.css, *.scss, *.tsx, *.jsx (excluding audio-titled PRs).
Evidence = PR body contains a screenshot attachment or live-surface link.

Previously executed as an LLM natural-language cron prompt, which truncated
missing_evidence_pr_urls when missing count was high (29 missing on Jun 27
returned []). This script is deterministic: the URL list is never truncated.

Usage:
  python3 css-blast-radius-evidence-rate.py [--days 7] [--dry-run]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

REPOS = [
    "RevOps-Global-GIT/cortextos",
    "RevOps-Global-GIT/rgos",
    "RevOps-Global-GIT/ob1-parents",
    "RevOps-Global-GIT/team-brain",
]

VISUAL_EXTS_RE = re.compile(r"\.(css|scss|tsx|jsx)$", re.IGNORECASE)

AUDIO_TITLE_RE = re.compile(
    r"\b(ivy|voice|audio|playback|crackle|mic|TTS|PCM|AVAudio)\b", re.IGNORECASE
)

EVIDENCE_RE = re.compile(
    r"(!\[|\.png|\.jpg|\.gif|\.webp|screenshot|before.*after|loom\.com"
    r"|vercel.*preview|dogfood-evidence/|revopsglobal\.(com|ai)|ob1\.(revops|vercel))",
    re.IGNORECASE,
)

OUTPUT_PATH = Path(__file__).parent.parent / "output" / "css-blast-radius-evidence-rate.jsonl"


def gh(*args: str) -> list[dict]:
    cmd = ["gh"] + list(args)
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"[warn] gh error: {result.stderr.strip()}", file=sys.stderr)
        return []
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        return []


def get_visual_files(repo: str, pr_number: int) -> bool:
    files = gh(
        "pr", "view", str(pr_number),
        "--repo", repo,
        "--json", "files",
        "--jq", ".files[].path",
    )
    # files comes back as list of dicts when using --json, not --jq
    # retry with proper approach
    result = subprocess.run(
        ["gh", "pr", "view", str(pr_number), "--repo", repo, "--json", "files"],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        return False
    try:
        data = json.loads(result.stdout)
        return any(
            VISUAL_EXTS_RE.search(f["path"])
            for f in data.get("files", [])
        )
    except (json.JSONDecodeError, KeyError):
        return False


def has_evidence(body: str) -> bool:
    return bool(EVIDENCE_RE.search(body or ""))


def fetch_merged_prs(repo: str, since: datetime, limit: int = 100) -> list[dict]:
    result = subprocess.run(
        [
            "gh", "pr", "list",
            "--repo", repo,
            "--state", "merged",
            "--limit", str(limit),
            "--json", "number,title,body,url,mergedAt",
        ],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        print(f"[warn] fetch failed for {repo}: {result.stderr.strip()}", file=sys.stderr)
        return []
    try:
        prs = json.loads(result.stdout)
    except json.JSONDecodeError:
        return []

    in_window = []
    for pr in prs:
        merged_at_str = pr.get("mergedAt") or ""
        if not merged_at_str:
            continue
        try:
            merged_at = datetime.fromisoformat(merged_at_str.replace("Z", "+00:00"))
        except ValueError:
            continue
        if merged_at >= since:
            in_window.append(pr)
    return in_window


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--days", type=int, default=7)
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()

    now = datetime.now(timezone.utc)
    since = now - timedelta(days=args.days)
    today = now.strftime("%Y-%m-%d")

    visual_prs: list[dict] = []
    with_evidence: list[str] = []
    missing: list[str] = []

    for repo in REPOS:
        print(f"[css-blast-radius] scanning {repo}...", file=sys.stderr)
        prs = fetch_merged_prs(repo, since)
        for pr in prs:
            title = pr.get("title", "")
            if AUDIO_TITLE_RE.search(title):
                continue
            number = pr["number"]
            url = pr["url"]
            body = pr.get("body") or ""

            is_visual = get_visual_files(repo, number)
            if not is_visual:
                continue

            visual_prs.append({"url": url, "title": title})
            if has_evidence(body):
                with_evidence.append(url)
            else:
                missing.append(url)

    total = len(visual_prs)
    evidence_count = len(with_evidence)
    pct = round(evidence_count / total * 100, 1) if total > 0 else 0.0

    row = {
        "date": today,
        "style_prs_count": total,
        "with_evidence_count": evidence_count,
        "percent_attached": pct,
        "missing_evidence_pr_urls": missing,
        "note": (
            f"7-day rolling window ({since.strftime('%Y-%m-%d')} to {today}). "
            f"Repos: {', '.join(r.split('/')[1] for r in REPOS)}. "
            f"ob1-app excluded. Audio-titled excluded."
        ),
    }

    print(json.dumps(row))

    if not args.dry_run:
        try:
            with OUTPUT_PATH.open("a") as fh:
                fh.write(json.dumps(row) + "\n")
            print(f"[css-blast-radius] appended to {OUTPUT_PATH}", file=sys.stderr)
        except Exception as e:
            print(f"[warn] failed to append: {e}", file=sys.stderr)
            sys.exit(1)


if __name__ == "__main__":
    main()
