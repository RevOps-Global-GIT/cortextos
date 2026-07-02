#!/usr/bin/env python3
"""
sync-experiment-memories - Bridge cortextOS autoresearch results into RGOS
agent memory.

Scans every agent's experiments/history/*.json under CTX_FRAMEWORK_ROOT/orgs/<org>/agents/*/
and posts each new file to Supabase agent-memory-store with memory_type
"optimization" + tags ["optimization","experiment"]. The RGOS /app/cortex/
optimization page filters orch_agent_memory by tag="optimization" to render
runs, so this is the producer it was always waiting for.

Records produced by the weekly optimize-agent-claude-md timer additionally
get the "claude-md-optimizer" tag (detected via payload.source or the
"run-<timestamp>" experiment_id shape). AgentOps overview freshness keys on
that tag specifically, so agent-authored hypothesis experiments living in the
same history dirs cannot mask a dead weekly timer.

Idempotent via a .synced-<sha256prefix> sidecar next to each source file.
Runs safely every 15 min; only new/changed files POST.

Env:
  SUPABASE_URL                (required)
  INTERNAL_CRON_SECRET        (required)
  CTX_FRAMEWORK_ROOT          (default: current working directory)
  ORG                         (default: revops-global)

Exit 0 on success. Nonzero with logged errors on any failure: the cron can
alert via journald.
"""

import hashlib
import json
import os
import pathlib
import sys
import urllib.request
import urllib.error


SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://yyizocyaehmqrottmnaz.supabase.co")
INTERNAL_CRON_SECRET = os.environ.get("INTERNAL_CRON_SECRET")
FRAMEWORK_ROOT = pathlib.Path(os.environ.get("CTX_FRAMEWORK_ROOT", str(pathlib.Path.cwd())))
ORG = os.environ.get("ORG", "revops-global")


def log(msg: str) -> None:
    print(f"[sync-experiment-memories] {msg}", flush=True)


def build_content(agent_id: str, payload: dict, filename: str) -> str:
    """The RGOS OptimizationRunCard runs `JSON.parse(memory.content)` and
    reads `score_delta` and `status` off the parsed object. So content must
    be a JSON string, not markdown. Augment with those two derived fields
    and a couple of labels; the UI renders the JSON verbatim when expanded."""
    augmented = _augment_for_ui(payload)
    augmented.setdefault("agent", agent_id)
    augmented.setdefault("source_file", filename)
    return json.dumps(augmented, indent=2)


def _augment_for_ui(payload: dict) -> dict:
    """The RGOS OptimizationRunCard reads `score_delta` and `status` off the
    parsed memory content. Derive them from whatever the agent wrote."""
    out = dict(payload)
    if "status" not in out:
        if payload.get("experiment_id") == "baseline":
            out["status"] = "baseline"
        elif "scores" in payload or "baseline_comparison" in payload or "experiment_results" in payload:
            # Any of these mean the analyst actually ran a measurement pass.
            out["status"] = "completed"
        else:
            out["status"] = "unknown"
    if "score_delta" not in out:
        bc = payload.get("baseline_comparison") or {}
        improvement = bc.get("improvement")
        if isinstance(improvement, str):
            try:
                out["score_delta"] = float(improvement.replace("+", ""))
            except ValueError:
                pass
        elif isinstance(improvement, (int, float)):
            out["score_delta"] = float(improvement)
    return out


CLAUDE_MD_OPTIMIZER_TAG = "claude-md-optimizer"


def derive_tags(payload: dict) -> list:
    """Tags for the memory row. Everything in experiments/history/ gets
    ["optimization", "experiment"] (+ metric:<name>); records written by the
    weekly CLAUDE.md optimizer also get CLAUDE_MD_OPTIMIZER_TAG so the
    AgentOps freshness source can watch the weekly timer specifically.
    Detection: explicit payload.source (new runner versions) or the
    "run-<timestamp>" experiment_id shape (history written by older
    versions)."""
    tags = ["optimization", "experiment"]
    metric = payload.get("metric")
    if metric:
        tags.append(f"metric:{metric}")
    if (
        payload.get("source") == "optimize-agent-claude-md"
        or str(payload.get("experiment_id") or "").startswith("run-")
    ):
        tags.append(CLAUDE_MD_OPTIMIZER_TAG)
    return tags


def pick_importance(payload: dict) -> int:
    delta = _augment_for_ui(payload).get("score_delta")
    if delta is None:
        return 6  # baseline / neutral
    abs_delta = abs(float(delta))
    if abs_delta >= 1.0:
        return 9
    if abs_delta >= 0.5:
        return 8
    if abs_delta >= 0.1:
        return 7
    return 6


# ── Recallable lesson digestion ──────────────────────────────────────────────
# The raw experiment JSON posted above is non-recallable telemetry by design
# (agent-memory-store skips embeddings for structured payloads). On its own that
# starves the recall corpus: agents flood the table with experiment JSON but
# almost never deposit a durable PROSE memory, so match_agent_memory returns
# nothing for most agents. This step closes the loop: when an experiment
# CONCLUDES, it distills a short prose lesson the agent can actually recall.

# Only conclusions carry a learnable takeaway. Baselines/declarations/unknowns
# (an experiment that hasn't been measured yet) are skipped.
DIGESTIBLE_STATUSES = {"improved", "completed", "regressed"}

# Cap the recorded prompt-diff excerpt in a lesson: enough to convey what
# changed, not so much it dominates the embedding or the card.
LESSON_DIFF_MAX_CHARS = 600


def _trim_diff(diff: str) -> str:
    d = diff.strip()
    if len(d) <= LESSON_DIFF_MAX_CHARS:
        return d
    return d[:LESSON_DIFF_MAX_CHARS].rstrip() + "\n... (diff truncated)"


def lesson_from_payload(agent_id: str, payload: dict) -> str | None:
    """Distill a concluded experiment into a one-paragraph PROSE lesson, or None
    when the payload carries no reapplyable takeaway.

    The returned string is deliberately non-JSON (never starts with { or [) so
    agent-memory-store embeds it: structured payloads are skipped from recall,
    prose is not. This is what turns the telemetry firehose into a growing,
    per-agent recall corpus."""
    aug = _augment_for_ui(payload)
    status = str(aug.get("status") or "").lower()
    if status not in DIGESTIBLE_STATUSES:
        return None
    metric = str(payload.get("metric") or "").strip()
    if not metric:
        return None

    hypothesis = str(payload.get("hypothesis") or "").strip()
    # Accepted CLAUDE.md rewrites record the actual change (optimize-agent-claude-md
    # writes mutation_diff); including a trimmed excerpt is what makes the lesson
    # teach WHAT changed, not just that a number moved.
    diff = str(payload.get("mutation_diff") or "").strip()
    # A conclusion with neither a hypothesis nor a recorded change carries no
    # reapplyable knowledge ("a metric moved by X"). Skip it rather than emit a
    # content-free stub that crowds out real lessons on small-k recall.
    if not hypothesis and not diff:
        return None

    exp_id = str(payload.get("experiment_id") or payload.get("id") or "").strip()
    delta = aug.get("score_delta")

    if status == "improved":
        outcome = "Accepted: the change improved this metric and is now live."
    elif status == "regressed":
        outcome = "Rejected: the change regressed this metric and was reverted."
    elif isinstance(delta, (int, float)) and delta > 0:
        outcome = "Measured an improvement on this metric."
    elif isinstance(delta, (int, float)) and delta < 0:
        outcome = "Measured a regression on this metric."
    else:
        outcome = "Ran a measured evaluation on this metric."

    lines = [f"Self-optimization lesson for {agent_id} (metric: {metric})."]
    if hypothesis:
        lines.append(f"Hypothesis tested: {hypothesis}")
    if isinstance(delta, (int, float)):
        lines.append(f"Score delta: {delta:+.3f}.")
    lines.append(outcome)
    if diff:
        lines.append(f"Change applied:\n{_trim_diff(diff)}")
    if exp_id:
        lines.append(f"(experiment {exp_id})")
    # Defensive: hypothesis/diff text can carry dashes from CLAUDE.md bodies;
    # normalize em/en dashes out (Greg hard rule applies to all output).
    return "\n".join(lines).replace("—", "-").replace("–", "-")


def lesson_importance(payload: dict) -> int:
    """Lessons are recallable prose; floor at pick_importance (>=6 so they also
    mirror to the wiki). Accepted CLAUDE.md rewrites are the highest-signal
    lessons an agent can carry, so they land at >=8."""
    base = pick_importance(payload)
    if str(_augment_for_ui(payload).get("status") or "").lower() == "improved":
        return max(base, 8)
    return base


def sidecar_path(src: pathlib.Path, content_sha: str) -> pathlib.Path:
    return src.with_suffix(src.suffix + f".synced-{content_sha}")


def lesson_sidecar_path(src: pathlib.Path, content_sha: str) -> pathlib.Path:
    # Independent of the telemetry marker so a transient lesson-post failure
    # retries next run without re-posting the (already-stored) telemetry row.
    return src.with_suffix(src.suffix + f".lesson-{content_sha}")


def post_memory(
    agent_id: str,
    content: str,
    tags: list,
    importance: int,
    memory_type: str = "optimization",
) -> tuple[bool, str]:
    if not INTERNAL_CRON_SECRET:
        return False, "INTERNAL_CRON_SECRET not set"
    body = json.dumps(
        {
            "agent_id": agent_id,
            "content": content,
            "memory_type": memory_type,
            "tags": tags,
            "importance": importance,
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        f"{SUPABASE_URL}/functions/v1/agent-memory-store",
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-Internal-Secret": INTERNAL_CRON_SECRET,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return True, resp.read().decode("utf-8", errors="replace")[:500]
    except urllib.error.HTTPError as e:
        return False, f"HTTP {e.code}: {e.read().decode('utf-8', errors='replace')[:300]}"
    except Exception as e:
        return False, f"{type(e).__name__}: {e}"


def digest_lesson(
    src: pathlib.Path, agent_id: str, payload: dict, content_sha: str
) -> str | None:
    """Best-effort: post a recallable PROSE lesson for a concluded experiment.
    Returns a log line on attempt, or None when nothing was digestible / already
    digested. Idempotent via its own sidecar; the agent-memory-store dedupe
    guard (cosine >= 0.95) further collapses near-identical re-digests."""
    lesson = lesson_from_payload(agent_id, payload)
    if not lesson:
        return None
    marker = lesson_sidecar_path(src, content_sha)
    if marker.exists():
        return None

    tags = ["self-optimization", "lesson"]
    metric = payload.get("metric")
    if metric:
        tags.append(f"metric:{metric}")
    # memory_type "lesson" is a durable prose type: embedded (recallable) and,
    # at importance >= 6, mirrored to the wiki. Tags deliberately omit
    # "optimization" so these never reach the OptimizationRunCard feed, which
    # JSON.parse()s memory.content and would choke on prose.
    ok, detail = post_memory(
        agent_id, lesson, tags, lesson_importance(payload), memory_type="lesson"
    )
    if not ok:
        return f"lesson FAIL {src.name} -> {detail}"

    for stale in src.parent.glob(src.name + ".lesson-*"):
        if stale != marker:
            try:
                stale.unlink()
            except Exception:
                pass
    marker.touch()
    return f"lesson OK {src.name} ({agent_id})"


def sync_one(src: pathlib.Path, agent_id: str) -> tuple[str, str | None]:
    try:
        raw = src.read_bytes()
    except Exception as e:
        return f"SKIP read fail {src}: {e}", None

    content_sha = hashlib.sha256(raw).hexdigest()[:12]
    marker = sidecar_path(src, content_sha)
    already_synced = marker.exists()

    try:
        payload = json.loads(raw)
    except Exception as e:
        return f"SKIP invalid JSON {src}: {e}", None

    # Even when the telemetry row is already synced, the prose lesson may not be
    # (e.g. the digestion step was added after the row first synced) so always
    # give digestion a chance; it no-ops via its own sidecar when done.
    if already_synced:
        return f"SKIP already synced {src.name}", digest_lesson(src, agent_id, payload, content_sha)

    content = build_content(agent_id, payload, src.name)
    tags = derive_tags(payload)
    importance = pick_importance(payload)
    ok, detail = post_memory(agent_id, content, tags, importance)
    if not ok:
        return f"FAIL {src.name} -> {detail}", None

    # Clear any older marker (different sha) so we don't accumulate cruft.
    for stale in src.parent.glob(src.name + ".synced-*"):
        if stale != marker:
            try:
                stale.unlink()
            except Exception:
                pass
    marker.touch()
    return f"OK   {src.name} ({agent_id}) -> memory stored", digest_lesson(
        src, agent_id, payload, content_sha
    )


def main() -> int:
    if not INTERNAL_CRON_SECRET:
        log("INTERNAL_CRON_SECRET required")
        return 2
    agents_root = FRAMEWORK_ROOT / "orgs" / ORG / "agents"
    if not agents_root.is_dir():
        log(f"no agents root at {agents_root}")
        return 3

    synced = 0
    failed = 0
    skipped = 0
    lessons = 0
    for history_dir in agents_root.glob("*/experiments/history"):
        agent_id = history_dir.parent.parent.name
        for src in sorted(history_dir.glob("*.json")):
            result, lesson = sync_one(src, agent_id)
            log(result)
            if result.startswith("OK"):
                synced += 1
            elif result.startswith("FAIL"):
                failed += 1
            else:
                skipped += 1
            if lesson:
                log(lesson)
                if lesson.startswith("lesson OK"):
                    lessons += 1
    log(f"done: synced={synced} lessons={lessons} skipped={skipped} failed={failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
