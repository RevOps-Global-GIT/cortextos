#!/usr/bin/env python3
"""
optimize-agent-claude-md — Self-optimization runner for cortextOS agent CLAUDE.md files.

For each configured agent, this script:
  1. Checks orch_optimization_budgets. monthly_token_budget <= 0 means
     self-optimization is DISABLED for the agent (skip). If the row's
     optimization_month_start is missing or from a prior month, the cycle
     counter is reset to 0 and re-anchored to the 1st of the current month
     before gating (this column is owned by the optimization writers;
     cortextos-vm-sync rolls month_start for MTD spend but never touches
     optimization_month_start). Skips when the current-month counter has
     already crossed the budget.
  2. Pulls the last N orch_tasks assigned to this agent from RGOS Supabase as
     test inputs. Requires >=3 real tasks; skips the agent otherwise.
  3. Reads the agent's CLAUDE.md body (frontmatter-stripped) and runs it as a
     system prompt against each test input via Claude Haiku.
  4. Evaluates each output against the agent's eval_criteria via Claude Sonnet.
     Each criterion is binary PASS/FAIL; score = pass_count / (batch_size * criteria_count).
  5. If no baseline exists yet for this agent, records the current body as
     baseline (no mutation). On subsequent runs, mutates the body via Sonnet,
     scores the variant, keeps it if it improves on the best recorded score.
  6. Writes a run record to:
       - experiments/history/run-<timestamp>.json (matching the shape
         sync-experiment-memories.py consumes). Accepted mutations include a
         truncated unified diff of the CLAUDE.md body (mutation_diff) so the
         Self-Optimization tab shows WHAT changed, not just the score move.
         The record carries source: "optimize-agent-claude-md" so the sync
         bridge stamps the claude-md-optimizer tag that AgentOps freshness
         watches.
       - experiments/best_body.md (the best-known body, for reference)
       - experiments/state.json (best_score, run_number)
     The sync-experiment-memories timer (15-min cadence) is the SOLE writer
     into orch_agent_memory for runs produced by this script, so there is no
     direct post_memory call here.
  7. Increments orch_optimization_budgets.optimization_tokens_used_this_month by
     an estimate (batch_size * exec_tokens + batch_size * eval_tokens + optional
     mutate_tokens). Real token usage is read back from the Anthropic response
     when available and clamped to the estimate for budgeting.

Designed to run under systemd as user cortextos on a weekly timer:
  /etc/systemd/system/optimize-agent-claude-md.service
  /etc/systemd/system/optimize-agent-claude-md.timer

Env (loaded from $CTX_FRAMEWORK_ROOT/orgs/revops-global/secrets.env):
  ANTHROPIC_API_KEY         optional — for execute, eval, mutate. If unset
                            or shape-invalid, the runner fetches from the
                            anthropic-key-fetch edge function instead (see
                            below). Prefer leaving this unset so rotations
                            live in one place (Supabase edge secrets).
  SUPABASE_RGOS_URL         required — RGOS project
  SUPABASE_RGOS_SERVICE_KEY required — for task fetch + budget updates
  INTERNAL_CRON_SECRET      required when ANTHROPIC_API_KEY is not set in
                            env; authenticates to anthropic-key-fetch.
  CTX_FRAMEWORK_ROOT        default current working directory
  ORG                       default revops-global

Key resolution: env first (for VM deploys that keep a local copy), then
the anthropic-key-fetch edge function (single-source-of-truth rotations).
The source used is logged to stderr on each invocation so audit logs show
where the key came from.

Memory delivery: the history JSON written here is picked up by the
separate sync-experiment-memories.{service,timer} (15-minute cadence) which
POSTs to agent-memory-store with sidecar-based idempotency. Runs surface at
/app/cortex/optimization within 15 minutes of completion.

Usage:
  optimize-agent-claude-md.py                          # all configured agents
  optimize-agent-claude-md.py --agent analyst          # one agent
  optimize-agent-claude-md.py --agent dev --dry-run    # no API calls, no writes
  optimize-agent-claude-md.py --list                   # list configured agents
  optimize-agent-claude-md.py --reset-state --agent X  # wipe experiments state
"""
from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import os
import pathlib
import random
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

try:
    import yaml  # type: ignore
except ImportError:
    print("ERROR: PyYAML is required. Install with: pip install pyyaml", file=sys.stderr)
    sys.exit(2)

try:
    import anthropic  # type: ignore
except ImportError:
    print("ERROR: anthropic is required. Install with: pip install anthropic", file=sys.stderr)
    sys.exit(2)


# ---- config --------------------------------------------------------------

EXECUTE_MODEL = "claude-haiku-4-5-20251001"
EVAL_MODEL = "claude-sonnet-4-6"
MUTATE_MODEL = "claude-sonnet-4-6"

# Per-cycle token ceiling used for BOTH budget accounting and abort guarding.
# Derived from:
#   batch_size=5 × execute ≤ 2_000 tokens
#   batch_size=5 × eval    ≤ 800 tokens
#   mutate                 ≤ 3_500 tokens
MAX_TOKENS_PER_CYCLE = 20_000
EXECUTE_MAX_TOKENS = 2_000
EVAL_MAX_TOKENS = 800
MUTATE_MAX_TOKENS = 3_500

DEFAULT_BATCH_SIZE = 5
DEFAULT_MIN_TEST_INPUTS = 3
DEFAULT_MAX_TEST_INPUTS = 20

# Cap on the unified diff recorded for accepted mutations. Keeps the memory
# payload reviewable in the Self-Optimization tab without bloating
# orch_agent_memory rows.
MUTATION_DIFF_MAX_CHARS = 4_000


# ---- prompts -------------------------------------------------------------

EVAL_PROMPT = """You are evaluating an AI agent's response against its operating instructions.

AGENT TASK INPUT:
{test_input}

AGENT OUTPUT:
{output}

EVALUATION CRITERIA:
{criteria_text}

Rate each criterion strictly as PASS (true) or FAIL (false). Respond in this exact JSON format:
{json_template}

For any criterion that fails, add a brief, specific note to the failures array explaining what was missing or wrong. Vague failure notes do not help the optimizer.
"""

MUTATION_PROMPT = """You are optimizing an AI agent's CLAUDE.md operating instructions.
Your goal: modify the instructions so the agent's outputs consistently pass ALL evaluation criteria without losing its core identity.

AGENT IDENTITY (preserve exactly):
- Role: {agent_id}
- Purpose: {metric}

CURRENT INSTRUCTIONS:
---
{current_body}
---

LAST BATCH SCORE: {score:.2f}/{max_score:.2f} ({score_pct:.0%})
CRITERIA BREAKDOWN:
{criteria_breakdown}

COMMON FAILURES IN THIS BATCH:
{failures}

BEST-SO-FAR SCORE: {best_score:.2f}/{max_score:.2f}

MUTATION RULES:
- Preserve the agent's role, tools, integrations, and core purpose exactly.
- For any criterion below 80 percent pass rate, add an explicit, imperative instruction.
- Use directive language ("Always include X", "Never omit Y"), not aspirational ("try to include X").
- Mutate from the best-so-far version provided above, not from a regression.
- Return ONLY the new instruction body. No preamble, no explanation, no markdown fences, no frontmatter delimiters.
"""


# ---- data shapes ---------------------------------------------------------

@dataclass
class TestInputSource:
    """How to gather representative test inputs for an agent.

    kind="orch_tasks":  pull last `limit` orch_tasks matching `filters`
                        (filter keys become eq.<value> on the REST query).
    kind="static":      use `static` list verbatim, ignore all live data.
    kind="mixed":       concatenate `static` + orch_tasks results, static
                        first so they always appear in the batch sample.
    """

    kind: str
    limit: int
    filters: dict
    static: list[str]


@dataclass
class AgentConfig:
    agent_id: str
    metric: str
    batch_size: int
    eval_criteria: list[dict]
    baseline_only: bool
    test_input_source: TestInputSource
    config_path: pathlib.Path
    experiments_dir: pathlib.Path
    claude_md_path: pathlib.Path


# ---- env + paths ---------------------------------------------------------

def load_dotenv_file(path: pathlib.Path) -> None:
    if not path.is_file():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


def framework_root() -> pathlib.Path:
    return pathlib.Path(os.environ.get("CTX_FRAMEWORK_ROOT", str(pathlib.Path.cwd())))


def org_name() -> str:
    return os.environ.get("ORG", "revops-global")


def agent_dir(agent_id: str) -> pathlib.Path:
    return framework_root() / "orgs" / org_name() / "agents" / agent_id


def all_agent_dirs() -> list[pathlib.Path]:
    root = framework_root() / "orgs" / org_name() / "agents"
    if not root.is_dir():
        return []
    return sorted(p for p in root.iterdir() if p.is_dir() and (p / "CLAUDE.md").is_file())


# ---- config -------------------------------------------------------------

def load_agent_config(agent_id: str) -> AgentConfig | None:
    ad = agent_dir(agent_id)
    claude_md = ad / "CLAUDE.md"
    if not claude_md.is_file():
        return None
    experiments = ad / "experiments"
    experiments.mkdir(parents=True, exist_ok=True)
    (experiments / "history").mkdir(exist_ok=True)

    config_path = experiments / "config.yaml"
    if not config_path.is_file():
        return None
    data = yaml.safe_load(config_path.read_text()) or {}
    if data.get("agent_id") and data["agent_id"] != agent_id:
        raise ValueError(
            f"config.yaml agent_id '{data['agent_id']}' does not match dir '{agent_id}'"
        )

    eval_criteria = data.get("eval_criteria") or []
    if not isinstance(eval_criteria, list) or not eval_criteria:
        raise ValueError(f"config.yaml for {agent_id} must set a non-empty eval_criteria list")
    for c in eval_criteria:
        if not (isinstance(c, dict) and c.get("name") and c.get("description")):
            raise ValueError(
                f"config.yaml eval_criteria for {agent_id}: each entry needs name + description"
            )

    raw_tis = data.get("test_inputs") or {}
    if not isinstance(raw_tis, dict):
        raise ValueError(
            f"config.yaml test_inputs for {agent_id} must be a mapping (got {type(raw_tis).__name__})"
        )
    kind = str(raw_tis.get("source") or "orch_tasks")
    if kind not in ("orch_tasks", "static", "mixed"):
        raise ValueError(
            f"config.yaml test_inputs.source for {agent_id} must be one of "
            "'orch_tasks', 'static', 'mixed'"
        )
    static_inputs = raw_tis.get("static") or []
    if kind in ("static", "mixed") and not static_inputs:
        raise ValueError(
            f"config.yaml test_inputs.source={kind} for {agent_id} requires a non-empty static list"
        )
    if not isinstance(static_inputs, list) or not all(
        isinstance(s, str) and s.strip() for s in static_inputs
    ):
        raise ValueError(
            f"config.yaml test_inputs.static for {agent_id} must be a list of non-empty strings"
        )
    filters = raw_tis.get("filters") or {}
    if not isinstance(filters, dict):
        raise ValueError(f"config.yaml test_inputs.filters for {agent_id} must be a mapping")
    test_input_source = TestInputSource(
        kind=kind,
        limit=int(raw_tis.get("limit") or DEFAULT_MAX_TEST_INPUTS),
        filters=filters,
        static=[s.strip() for s in static_inputs],
    )

    return AgentConfig(
        agent_id=agent_id,
        metric=str(data.get("metric") or f"{agent_id}_output_quality"),
        batch_size=int(data.get("batch_size") or DEFAULT_BATCH_SIZE),
        eval_criteria=eval_criteria,
        baseline_only=bool(data.get("baseline_only", False)),
        test_input_source=test_input_source,
        config_path=config_path,
        experiments_dir=experiments,
        claude_md_path=claude_md,
    )


# ---- state --------------------------------------------------------------

def load_state(cfg: AgentConfig) -> dict:
    state_path = cfg.experiments_dir / "state.json"
    if state_path.is_file():
        try:
            return json.loads(state_path.read_text())
        except Exception:
            pass
    return {"best_score": None, "run_number": 0}


def save_state(cfg: AgentConfig, state: dict) -> None:
    (cfg.experiments_dir / "state.json").write_text(json.dumps(state, indent=2))


def load_best_body(cfg: AgentConfig) -> str | None:
    best_path = cfg.experiments_dir / "best_body.md"
    if best_path.is_file():
        return best_path.read_text()
    return None


def save_best_body(cfg: AgentConfig, body: str) -> None:
    (cfg.experiments_dir / "best_body.md").write_text(body)


def split_frontmatter(text: str) -> tuple[str, str]:
    if text.startswith("---"):
        end = text.find("---", 3)
        if end != -1:
            return text[: end + 3], text[end + 3 :].lstrip("\n")
    return "", text


# ---- Supabase ------------------------------------------------------------

def _request(url: str, method: str, headers: dict, body: Any = None, timeout: int = 30) -> tuple[int, str]:
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", errors="replace")


def supabase_headers() -> dict:
    key = os.environ.get("SUPABASE_RGOS_SERVICE_KEY")
    if not key:
        raise RuntimeError("SUPABASE_RGOS_SERVICE_KEY not set")
    return {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }


def supabase_url() -> str:
    url = os.environ.get("SUPABASE_RGOS_URL") or os.environ.get("SUPABASE_URL")
    if not url:
        raise RuntimeError("SUPABASE_RGOS_URL not set")
    return url.rstrip("/")


def fetch_budget(agent_id: str) -> dict | None:
    status, body = _request(
        f"{supabase_url()}/rest/v1/orch_optimization_budgets"
        f"?select=*&agent_id=eq.{agent_id}&limit=1",
        "GET",
        supabase_headers(),
    )
    if status >= 400:
        raise RuntimeError(f"fetch_budget {agent_id}: {status} {body}")
    rows = json.loads(body or "[]")
    return rows[0] if rows else None


def current_month_start() -> str:
    """First day of the current UTC month, ISO date string."""
    return datetime.now(timezone.utc).date().replace(day=1).isoformat()


def is_current_budget_month(optimization_month_start: object) -> bool:
    """True when the optimization-cycle counter is anchored to this UTC month.

    A missing/NULL anchor means the row predates the optimization_month_start
    column (or was created by cortextos-vm-sync, which never sets it) — treat
    it as stale so the counter gets a clean reset.
    """
    if not optimization_month_start:
        return False
    return str(optimization_month_start)[:7] == current_month_start()[:7]


def reset_budget_month(budget_id: str) -> None:
    """Zero the optimization-cycle counter and anchor it to this month.

    Only optimization_tokens_used_this_month + optimization_month_start are
    touched; tokens_used_this_month (MTD compute spend) is owned by
    cortextos-vm-sync.
    """
    status, body = _request(
        f"{supabase_url()}/rest/v1/orch_optimization_budgets?id=eq.{budget_id}",
        "PATCH",
        {**supabase_headers(), "Prefer": "return=minimal"},
        {
            "optimization_tokens_used_this_month": 0,
            "optimization_month_start": current_month_start(),
            "updated_at": datetime.now(timezone.utc).isoformat(),
        },
    )
    if status >= 400:
        raise RuntimeError(f"reset_budget_month {budget_id}: {status} {body}")


def build_mutation_diff(before: str, after: str, limit: int = MUTATION_DIFF_MAX_CHARS) -> str:
    """Unified diff of an accepted CLAUDE.md mutation, truncated for memory
    payloads. Rendered by the Self-Optimization tab so accepted rewrites are
    reviewable without SSHing to the VM."""
    diff = "\n".join(
        difflib.unified_diff(
            before.splitlines(),
            after.splitlines(),
            fromfile="CLAUDE.md (before)",
            tofile="CLAUDE.md (after)",
            lineterm="",
        )
    )
    if len(diff) > limit:
        diff = diff[:limit] + f"\n... [diff truncated at {limit} chars]"
    return diff


def update_budget_tokens(budget_id: str, current_opt_tokens: int, delta: int) -> None:
    new_total = current_opt_tokens + delta
    status, body = _request(
        f"{supabase_url()}/rest/v1/orch_optimization_budgets?id=eq.{budget_id}",
        "PATCH",
        {**supabase_headers(), "Prefer": "return=minimal"},
        {
            "optimization_tokens_used_this_month": new_total,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        },
    )
    if status >= 400:
        raise RuntimeError(f"update_budget_tokens {budget_id}: {status} {body}")


def _anthropic_key_shape_ok(key: str | None) -> bool:
    """Fast sanity check: real Anthropic keys start with sk-ant- and are ~100+
    chars of base64url. A 64-char hex string (what the Supabase Management
    API returns for every project secret) fails. Empty/None fails."""
    if not key:
        return False
    if not key.startswith("sk-ant-"):
        return False
    if len(key) < 80:
        return False
    import re as _re
    if _re.fullmatch(r"[0-9a-fA-F]+", key):
        return False
    return True


def _fetch_anthropic_key_from_edge_fn() -> str | None:
    """Fetch ANTHROPIC_API_KEY plaintext from the anthropic-key-fetch edge
    function. Requires SUPABASE_RGOS_URL (or SUPABASE_URL) + INTERNAL_CRON_SECRET
    in env. Returns None if either is missing or the call fails — caller
    decides whether to error out."""
    url = os.environ.get("SUPABASE_RGOS_URL") or os.environ.get("SUPABASE_URL")
    secret = os.environ.get("INTERNAL_CRON_SECRET")
    if not url or not secret:
        return None
    endpoint = url.rstrip("/") + "/functions/v1/anthropic-key-fetch"
    req = urllib.request.Request(
        endpoint,
        method="POST",
        headers={"Content-Type": "application/json", "X-Internal-Secret": secret},
        data=b"{}",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            payload = json.loads(resp.read().decode("utf-8", errors="replace"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")[:200]
        print(
            f"[anthropic-key-fetch] HTTP {e.code}: {body}",
            file=sys.stderr,
        )
        return None
    except Exception as e:
        print(
            f"[anthropic-key-fetch] {type(e).__name__}: {e}",
            file=sys.stderr,
        )
        return None
    return payload.get("key")


def resolve_anthropic_key() -> tuple[str | None, str]:
    """Return (key, source). Prefer a valid env value (secrets.env on VM)
    to avoid a network call on every invocation; fall back to the
    anthropic-key-fetch edge function so rotations can happen in a single
    place (Supabase edge secrets). Source is one of:
      - "env"            — env var looked right, used it
      - "edge_function"  — env missing/malformed, edge fn returned a real key
      - "none"           — nothing usable found
    """
    env_key = os.environ.get("ANTHROPIC_API_KEY")
    if _anthropic_key_shape_ok(env_key):
        return env_key, "env"
    fetched = _fetch_anthropic_key_from_edge_fn()
    if _anthropic_key_shape_ok(fetched):
        return fetched, "edge_function"
    return (fetched or env_key or None), "none"


def _fetch_orch_tasks(agent_id: str, filters: dict, limit: int) -> list[str]:
    """Pull orch_tasks.description matching filters. If the config supplies no
    filters, default to assigned_to=<agent_id> so the old behavior is stable."""
    query_filters = dict(filters) if filters else {}
    query_filters.setdefault("assigned_to", agent_id)
    params = [
        "select=description",
        "description=not.is.null",
        f"order=created_at.desc",
        f"limit={limit}",
    ]
    for k, v in query_filters.items():
        # REST needs eq.<value>; urlencode the value to protect spaces.
        params.append(
            f"{urllib.parse.quote(str(k), safe='')}=eq.{urllib.parse.quote(str(v), safe='')}"
        )
    url = f"{supabase_url()}/rest/v1/orch_tasks?" + "&".join(params)
    status, body = _request(url, "GET", supabase_headers())
    if status >= 400:
        raise RuntimeError(f"_fetch_orch_tasks {agent_id}: {status} {body}")
    rows = json.loads(body or "[]")
    return [r["description"] for r in rows if r.get("description")]


def gather_test_inputs(cfg: "AgentConfig") -> list[str]:
    """Dispatch on cfg.test_input_source.kind.

    - static: use the static list verbatim.
    - orch_tasks: pull from Supabase, optionally filtered.
    - mixed: static list first, then orch_tasks appended (dedup preserved).
    """
    src = cfg.test_input_source
    if src.kind == "static":
        return list(src.static)
    if src.kind == "orch_tasks":
        return _fetch_orch_tasks(cfg.agent_id, src.filters, src.limit)
    if src.kind == "mixed":
        out = list(src.static)
        seen = set(out)
        for candidate in _fetch_orch_tasks(cfg.agent_id, src.filters, src.limit):
            if candidate not in seen:
                out.append(candidate)
                seen.add(candidate)
        return out
    raise ValueError(f"unknown test_input_source.kind: {src.kind}")


# ---- claude helpers ------------------------------------------------------

def _message_text(resp) -> str:
    parts = []
    for block in resp.content:
        if getattr(block, "type", None) == "text":
            parts.append(block.text)
    return "".join(parts).strip()


def _token_total(resp) -> int:
    usage = getattr(resp, "usage", None)
    if not usage:
        return 0
    inp = getattr(usage, "input_tokens", 0) or 0
    out = getattr(usage, "output_tokens", 0) or 0
    return int(inp) + int(out)


def execute_one(client, system_body: str, test_input: str) -> tuple[str, int]:
    resp = client.messages.create(
        model=EXECUTE_MODEL,
        max_tokens=EXECUTE_MAX_TOKENS,
        system=system_body,
        messages=[{"role": "user", "content": test_input}],
    )
    return _message_text(resp), _token_total(resp)


def evaluate_one(
    client, test_input: str, output: str, criteria: list[dict]
) -> tuple[dict, int]:
    criteria_text = "\n".join(
        f"{i + 1}. {c['name'].upper()}: {c['description']}"
        for i, c in enumerate(criteria)
    )
    json_keys: dict[str, Any] = {c["name"]: True for c in criteria}
    json_keys["failures"] = []
    json_template = json.dumps(json_keys, indent=2)
    prompt = EVAL_PROMPT.format(
        test_input=test_input,
        output=output,
        criteria_text=criteria_text,
        json_template=json_template,
    )
    resp = client.messages.create(
        model=EVAL_MODEL,
        max_tokens=EVAL_MAX_TOKENS,
        messages=[{"role": "user", "content": prompt}],
    )
    raw = _message_text(resp)
    # Strip ```json fences if the judge wrapped them
    if "```" in raw:
        parts = raw.split("```")
        if len(parts) >= 2:
            cand = parts[1]
            if cand.startswith("json"):
                cand = cand[4:]
            raw = cand.strip()
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        parsed = {c["name"]: False for c in criteria}
        parsed["failures"] = [f"judge_returned_invalid_json: {raw[:120]}"]
    return parsed, _token_total(resp)


def mutate_body(
    client,
    agent_id: str,
    metric: str,
    current_body: str,
    best_body: str,
    score: float,
    max_score: float,
    criteria_breakdown: str,
    failures: list[str],
) -> tuple[str, int]:
    prompt = MUTATION_PROMPT.format(
        agent_id=agent_id,
        metric=metric,
        current_body=best_body,  # mutate from best known
        score=score,
        max_score=max_score,
        score_pct=(score / max_score) if max_score else 0.0,
        criteria_breakdown=criteria_breakdown,
        failures="\n".join(f"- {f}" for f in failures[:20]) or "- none recorded",
        best_score=score,
    )
    resp = client.messages.create(
        model=MUTATE_MODEL,
        max_tokens=MUTATE_MAX_TOKENS,
        messages=[{"role": "user", "content": prompt}],
    )
    return _message_text(resp), _token_total(resp)


# ---- core loop -----------------------------------------------------------

def score_body(
    client,
    cfg: AgentConfig,
    body: str,
    test_inputs: list[str],
) -> tuple[dict, int]:
    """Run body against test_inputs, evaluate each, return aggregated scoring + token total."""
    per_criterion_pass: dict[str, int] = {c["name"]: 0 for c in cfg.eval_criteria}
    all_failures: list[str] = []
    per_input: list[dict] = []
    total_tokens = 0

    for test_input in test_inputs:
        output, exec_tokens = execute_one(client, body, test_input)
        total_tokens += exec_tokens
        verdict, eval_tokens = evaluate_one(client, test_input, output, cfg.eval_criteria)
        total_tokens += eval_tokens
        failures = verdict.pop("failures", []) or []
        all_failures.extend(str(f) for f in failures if f)
        for c in cfg.eval_criteria:
            if bool(verdict.get(c["name"])):
                per_criterion_pass[c["name"]] += 1
        per_input.append(
            {
                "test_input": test_input[:200],
                "output_preview": output[:400],
                "verdict": verdict,
            }
        )

    batch_size = len(test_inputs)
    total_criteria = len(cfg.eval_criteria) * batch_size
    passed = sum(per_criterion_pass.values())
    return (
        {
            "score": passed,
            "max_score": total_criteria,
            "score_ratio": (passed / total_criteria) if total_criteria else 0.0,
            "per_criterion_pass": per_criterion_pass,
            "failures": all_failures,
            "per_input": per_input,
        },
        total_tokens,
    )


def criteria_breakdown(cfg: AgentConfig, per_criterion_pass: dict, batch_size: int) -> str:
    return "\n".join(
        f"- {name}: {count}/{batch_size} ({(count / batch_size if batch_size else 0):.0%})"
        for name, count in per_criterion_pass.items()
    )


def run_agent(
    client: "anthropic.Anthropic | None",
    cfg: AgentConfig,
    dry_run: bool,
    task_limit: int,
) -> dict:
    """Execute one optimization cycle for one agent. Returns a run summary dict."""
    timestamp = datetime.now(timezone.utc)
    run_id = timestamp.strftime("%Y%m%dT%H%M%S")

    # 1. Budget gate. monthly_token_budget <= 0 means self-optimization is
    # disabled for this agent (the MCP tool and the UI share this semantic).
    budget = fetch_budget(cfg.agent_id)
    if budget is None:
        return {"agent_id": cfg.agent_id, "skipped": True, "reason": "no_budget_row"}
    opt_cap = int(budget.get("monthly_token_budget") or 0)
    if opt_cap <= 0:
        return {
            "agent_id": cfg.agent_id,
            "skipped": True,
            "reason": "optimization_disabled",
            "monthly_token_budget": opt_cap,
        }
    opt_used = int(budget.get("optimization_tokens_used_this_month") or 0)
    if not is_current_budget_month(budget.get("optimization_month_start")):
        # Month rolled over (or the row was never anchored): the counter is
        # stale, so zero it before gating. Dry runs must not write.
        if not dry_run:
            reset_budget_month(budget["id"])
        opt_used = 0
    if opt_used >= opt_cap:
        return {
            "agent_id": cfg.agent_id,
            "skipped": True,
            "reason": "budget_exhausted",
            "optimization_tokens_used_this_month": opt_used,
            "monthly_token_budget": opt_cap,
        }

    # 2. Test inputs (dispatched by cfg.test_input_source.kind)
    inputs = gather_test_inputs(cfg)
    if len(inputs) < DEFAULT_MIN_TEST_INPUTS:
        return {
            "agent_id": cfg.agent_id,
            "skipped": True,
            "reason": "insufficient_task_history",
            "have": len(inputs),
            "need": DEFAULT_MIN_TEST_INPUTS,
        }
    random.seed(int(timestamp.timestamp()))
    random.shuffle(inputs)
    test_inputs = inputs[: cfg.batch_size]

    # 3. Body + state
    raw = cfg.claude_md_path.read_text()
    frontmatter, current_body = split_frontmatter(raw)
    best_body = load_best_body(cfg) or current_body
    state = load_state(cfg)
    prev_best_score = state.get("best_score")
    run_number = int(state.get("run_number") or 0) + 1

    if dry_run:
        return {
            "agent_id": cfg.agent_id,
            "dry_run": True,
            "batch_size": len(test_inputs),
            "run_number": run_number,
            "prev_best_score": prev_best_score,
            "eval_criteria": [c["name"] for c in cfg.eval_criteria],
            "claude_md_sha": hashlib.sha256(current_body.encode()).hexdigest()[:12],
        }

    assert client is not None

    # 4. Baseline: score the current body once. No mutation.
    baseline_summary, baseline_tokens = score_body(client, cfg, current_body, test_inputs)
    ratio_current = baseline_summary["score_ratio"]

    result: dict[str, Any] = {
        "experiment_id": f"run-{run_id}",
        "run_id": run_id,
        "run_number": run_number,
        "agent_id": cfg.agent_id,
        "agent": cfg.agent_id,
        # Lets sync-experiment-memories.py distinguish weekly CLAUDE.md runs
        # from agent-authored hypothesis experiments in the same history dir.
        "source": "optimize-agent-claude-md",
        "metric": cfg.metric,
        "batch_size": len(test_inputs),
        "generated_at": timestamp.isoformat(),
        "scores": {
            "current": {
                "score": baseline_summary["score"],
                "max_score": baseline_summary["max_score"],
                "ratio": ratio_current,
                "per_criterion_pass": baseline_summary["per_criterion_pass"],
            }
        },
        "status": "baseline" if prev_best_score is None or cfg.baseline_only else "completed",
    }

    tokens_used = baseline_tokens
    accepted = False
    new_body: str | None = None
    mutation_summary: dict | None = None

    # 5. Mutate only if we already have a baseline and not configured baseline-only.
    if prev_best_score is not None and not cfg.baseline_only:
        breakdown = criteria_breakdown(
            cfg, baseline_summary["per_criterion_pass"], len(test_inputs)
        )
        mutated_body, mutate_tokens = mutate_body(
            client,
            cfg.agent_id,
            cfg.metric,
            current_body,
            best_body,
            baseline_summary["score"],
            baseline_summary["max_score"],
            breakdown,
            baseline_summary["failures"],
        )
        tokens_used += mutate_tokens

        mutation_summary, mutated_tokens = score_body(
            client, cfg, mutated_body, test_inputs
        )
        tokens_used += mutated_tokens
        ratio_mutated = mutation_summary["score_ratio"]

        result["scores"]["mutation"] = {
            "score": mutation_summary["score"],
            "max_score": mutation_summary["max_score"],
            "ratio": ratio_mutated,
            "per_criterion_pass": mutation_summary["per_criterion_pass"],
        }
        result["baseline_comparison"] = {
            "prev_best_score_ratio": prev_best_score,
            "current_ratio": ratio_current,
            "mutation_ratio": ratio_mutated,
            "improvement": round(ratio_mutated - ratio_current, 4),
        }
        result["score_delta"] = round(ratio_mutated - ratio_current, 4)

        if ratio_mutated > ratio_current:
            accepted = True
            new_body = mutated_body
            result["status"] = "improved"
            # Accepted rewrites go live on the agent's next session — record
            # exactly what changed so the run history is reviewable.
            result["mutation_diff"] = build_mutation_diff(current_body, mutated_body)
            result["mutation_chars"] = {
                "before": len(current_body),
                "after": len(mutated_body),
            }
        else:
            result["status"] = "regressed"
            result["mutation_rejected"] = True
    else:
        result["score_delta"] = 0.0
        result["baseline_comparison"] = {
            "prev_best_score_ratio": prev_best_score,
            "current_ratio": ratio_current,
            "mutation_ratio": None,
            "improvement": 0.0,
        }

    # 6. Apply changes and persist.
    if accepted and new_body is not None:
        # Write the mutated body back with original frontmatter. Keep best_body + state in sync.
        new_content = (frontmatter + "\n\n" + new_body) if frontmatter else new_body
        cfg.claude_md_path.write_text(new_content)
        save_best_body(cfg, new_body)
        state["best_score"] = mutation_summary["score_ratio"]  # type: ignore[union-attr]
    elif prev_best_score is None:
        # First-run baseline becomes the best we know
        save_best_body(cfg, current_body)
        state["best_score"] = ratio_current

    state["run_number"] = run_number
    state["last_run_at"] = timestamp.isoformat()
    state["last_run_id"] = run_id
    save_state(cfg, state)

    # 7. History record — shape matches sync-experiment-memories.py expectations.
    # Memory insertion is owned by sync-experiment-memories.{service,timer}
    # which sweeps this directory every 15 minutes and POSTs to
    # agent-memory-store with sidecar-based idempotency. We do NOT post here
    # to avoid duplicate memory rows (one from the direct post, one from the
    # bridge). UI latency after a cycle completes is at most 15 minutes.
    history_path = cfg.experiments_dir / "history" / f"run-{run_id}.json"
    history_path.write_text(json.dumps(result, indent=2))
    result["importance"] = 8 if accepted else 6

    # 8. Budget update — clamp to the per-cycle ceiling to prevent runaway
    billable = min(max(tokens_used, 0), MAX_TOKENS_PER_CYCLE)
    update_budget_tokens(budget["id"], opt_used, billable)

    result["tokens_used"] = tokens_used
    result["tokens_billed"] = billable
    return result


# ---- CLI ----------------------------------------------------------------

def cli_list() -> int:
    for ad in all_agent_dirs():
        cfg = None
        try:
            cfg = load_agent_config(ad.name)
        except Exception as e:
            print(f"{ad.name:20}  config_error: {e}")
            continue
        if cfg is None:
            print(f"{ad.name:20}  no_config")
            continue
        state = load_state(cfg)
        print(
            f"{ad.name:20}  metric={cfg.metric:35}"
            f"  run_number={state.get('run_number', 0)}"
            f"  best_score={state.get('best_score')}"
        )
    return 0


def cli_reset(agent_id: str) -> int:
    cfg = load_agent_config(agent_id)
    if cfg is None:
        print(f"No config for {agent_id}", file=sys.stderr)
        return 1
    for name in ["state.json", "best_body.md"]:
        p = cfg.experiments_dir / name
        if p.exists():
            p.unlink()
    print(f"reset state for {agent_id}")
    return 0


def main() -> int:
    load_dotenv_file(framework_root() / "orgs" / org_name() / "secrets.env")
    load_dotenv_file(framework_root() / ".env")

    parser = argparse.ArgumentParser(
        description="CortextOS agent CLAUDE.md self-optimization runner"
    )
    parser.add_argument("--agent", help="Run only this agent_id (default: all configured)")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Do not call Anthropic, do not write files, do not touch Supabase",
    )
    parser.add_argument("--list", action="store_true", help="List configured agents")
    parser.add_argument(
        "--reset-state",
        action="store_true",
        help="Wipe experiments/state.json and best_body.md for the target agent",
    )
    parser.add_argument(
        "--task-limit",
        type=int,
        default=DEFAULT_MAX_TEST_INPUTS,
        help="Max orch_tasks to pull as candidate test inputs (before batch sampling)",
    )
    args = parser.parse_args()

    if args.list:
        return cli_list()
    if args.reset_state:
        if not args.agent:
            print("--reset-state requires --agent", file=sys.stderr)
            return 2
        return cli_reset(args.agent)

    if args.agent:
        targets = [args.agent]
    else:
        targets = [ad.name for ad in all_agent_dirs()]

    client: "anthropic.Anthropic | None" = None
    if not args.dry_run:
        key, source = resolve_anthropic_key()
        if not key:
            print(
                "ERROR: ANTHROPIC_API_KEY not available. Set it in secrets.env "
                "OR configure INTERNAL_CRON_SECRET + SUPABASE_RGOS_URL so the "
                "runner can fetch from the anthropic-key-fetch edge function.",
                file=sys.stderr,
            )
            return 2
        if not _anthropic_key_shape_ok(key):
            print(
                "ERROR: ANTHROPIC_API_KEY does not look like an Anthropic API "
                "key (expected sk-ant-api03-... with ~100+ chars). "
                f"Source: {source}. Got length={len(key)}.",
                file=sys.stderr,
            )
            return 2
        print(f"[anthropic-key] using source={source} length={len(key)}", file=sys.stderr)
        client = anthropic.Anthropic(api_key=key)

    overall: list[dict] = []
    exit_code = 0
    for agent_id in targets:
        cfg = load_agent_config(agent_id)
        if cfg is None:
            overall.append({"agent_id": agent_id, "skipped": True, "reason": "no_config"})
            continue
        t0 = time.monotonic()
        try:
            summary = run_agent(client, cfg, dry_run=args.dry_run, task_limit=args.task_limit)
            summary["elapsed_seconds"] = round(time.monotonic() - t0, 2)
            overall.append(summary)
            print(json.dumps(summary, indent=2))
        except Exception as e:
            exit_code = 1
            overall.append(
                {
                    "agent_id": agent_id,
                    "error": f"{type(e).__name__}: {e}",
                    "elapsed_seconds": round(time.monotonic() - t0, 2),
                }
            )
            print(
                json.dumps(overall[-1], indent=2),
                file=sys.stderr,
            )

    print(json.dumps({"agents": overall}, indent=2))
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
