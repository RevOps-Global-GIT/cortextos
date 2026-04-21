#!/usr/bin/env python3
"""
sync-experiment-memories — Bridge cortextOS autoresearch results into RGOS
agent memory.

Scans every agent's experiments/history/*.json under CTX_FRAMEWORK_ROOT/orgs/<org>/agents/*/
and posts each new file to Supabase agent-memory-store with memory_type
"optimization" + tags ["optimization","experiment"]. The RGOS /app/cortex/
optimization page filters orch_agent_memory by tag="optimization" to render
runs, so this is the producer it was always waiting for.

Idempotent via a .synced-<sha256prefix> sidecar next to each source file.
Runs safely every 15 min; only new/changed files POST.

Env:
  SUPABASE_URL                (required)
  INTERNAL_CRON_SECRET        (required)
  CTX_FRAMEWORK_ROOT          (default: /home/cortextos/cortextos)
  ORG                         (default: revops-global)

Exit 0 on success. Nonzero with logged errors on any failure — the cron can
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
FRAMEWORK_ROOT = pathlib.Path(os.environ.get("CTX_FRAMEWORK_ROOT", "/home/cortextos/cortextos"))
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


def sidecar_path(src: pathlib.Path, content_sha: str) -> pathlib.Path:
    return src.with_suffix(src.suffix + f".synced-{content_sha}")


def post_memory(agent_id: str, content: str, tags: list, importance: int) -> tuple[bool, str]:
    if not INTERNAL_CRON_SECRET:
        return False, "INTERNAL_CRON_SECRET not set"
    body = json.dumps(
        {
            "agent_id": agent_id,
            "content": content,
            "memory_type": "optimization",
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


def sync_one(src: pathlib.Path, agent_id: str) -> str:
    try:
        raw = src.read_bytes()
    except Exception as e:
        return f"SKIP read fail {src}: {e}"

    content_sha = hashlib.sha256(raw).hexdigest()[:12]
    marker = sidecar_path(src, content_sha)
    if marker.exists():
        return f"SKIP already synced {src.name}"

    try:
        payload = json.loads(raw)
    except Exception as e:
        return f"SKIP invalid JSON {src}: {e}"

    content = build_content(agent_id, payload, src.name)
    tags = ["optimization", "experiment"]
    metric = payload.get("metric")
    if metric:
        tags.append(f"metric:{metric}")
    importance = pick_importance(payload)
    ok, detail = post_memory(agent_id, content, tags, importance)
    if not ok:
        return f"FAIL {src.name} -> {detail}"

    # Clear any older marker (different sha) so we don't accumulate cruft.
    for stale in src.parent.glob(src.name + ".synced-*"):
        if stale != marker:
            try:
                stale.unlink()
            except Exception:
                pass
    marker.touch()
    return f"OK   {src.name} ({agent_id}) -> memory stored"


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
    for history_dir in agents_root.glob("*/experiments/history"):
        agent_id = history_dir.parent.parent.name
        for src in sorted(history_dir.glob("*.json")):
            result = sync_one(src, agent_id)
            log(result)
            if result.startswith("OK"):
                synced += 1
            elif result.startswith("FAIL"):
                failed += 1
            else:
                skipped += 1
    log(f"done: synced={synced} skipped={skipped} failed={failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
