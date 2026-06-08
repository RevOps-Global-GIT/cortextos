# AgentOps Hourly Dogfood

Run one bounded AgentOps dogfood pass using the full available QA stack. Claude Max is restored — use all routes.

## Goal

Evaluate AgentOps like a product expert and a real operator, not just a selector checker. The pass should find anything that looks incorrect, stale, misleading, not helpful, incomplete, broken, or unclear, then route small scoped fixes without creating duplicate tasks.

## Mandatory First Step: Run Playwright Harness

**Always run the Playwright harness first, regardless of Codex state.** The harness is Codex-credit-independent — it uses a headless Chromium browser with a minted Supabase session. Never report "blocked by Codex credits."

Run it for every priority page on each pass (rotate to cover all 8 within 2–3 passes if time-constrained):

```bash
# Sync QA worktree to current fork/main (always use fully-qualified ref — bare fork/main is ambiguous)
git -C /home/cortextos/cortextos fetch fork main --quiet
git -C /home/cortextos/cortextos-qa reset --hard refs/remotes/fork/main --quiet

cd /home/cortextos/cortextos-qa

# Priority pages — run each individually via npx tsx:
npx tsx scripts/hub-qa-playwright.ts --page /analytics --no-send
npx tsx scripts/hub-qa-playwright.ts --page /fleet --no-send
npx tsx scripts/hub-qa-playwright.ts --page /app/fleet/tasks --no-send
npx tsx scripts/hub-qa-playwright.ts --page /app/fleet/activity --no-send
npx tsx scripts/hub-qa-playwright.ts --page /app/cortex/theta --no-send
npx tsx scripts/hub-qa-playwright.ts --page /app/supreme-outstanding --no-send
npx tsx scripts/hub-qa-playwright.ts --page /app/work/inbox --no-send
npx tsx scripts/hub-qa-playwright.ts --page /app/work/approvals --no-send
npx tsx scripts/hub-qa-playwright.ts --page /app/fleet-sessions --no-send
```

Each run writes a report to `orgs/revops-global/agents/codex/output/playwright-qa/`. Collect FAIL results across all pages before proceeding.

The QA worktree (`/home/cortextos/cortextos-qa`) is a git worktree always synced to `refs/remotes/fork/main` before each run — harness code is always current main, eliminating stale-harness false-positives. FAILs from this worktree are real.

**Fallback command if `npx tsx` is not available:** `npx ts-node --esm scripts/hub-qa-playwright.ts`

## Mandatory Second Step: Operator Health Panels (the surfaces Greg screenshots)

Page-load PASS is NOT enough. Greg screenshots the operator panels, not the route checks. Every pass MUST inspect these four panels and assert the data is TRUE, not just present. For each, record the concrete number and whether it is a real problem or panel noise.

1. **NEEDS YOU** — `[N] Task blocked`, `[N] Supreme`, `[N] Cron misses`.
   - For each blocked task: is it genuinely blocked on a HUMAN action (surface to orchestrator with the exact step), or stranded on a dead/idle agent (re-home it)? A blocked card stranded on a dead agent is a FAIL, not "owned."
   - `Cron misses > 0`: name the missed cron and confirm whether it silently failed (`last_fired_at` vs `last_fire_attempted_at`) — do not leave it unexplained.

2. **RGOS Recurring Tasks** (Late/Stale badge) — list every task showing "Late."
   - A recurring task firing into a frozen/unwired pipeline (e.g. LinkedIn Engage while outbound is frozen) is NOISE → it should be PAUSED, not left to re-alert. Flag any such task for pause.
   - A real missed window on a live task is a P2 → route it.

3. **Quality + Knowledge Health** — Supreme scanner, Hub QA, Wiki health, **Advisor canary**.
   - For Advisor canary (and any "X old; threshold Ymin" row): compute age vs threshold. If age > threshold it is STALE → find what writes its health-state and why it stopped, restart it. Do not report the panel "healthy" while any row reads Stale.

4. **Capabilities → Experiments** — `AVG IMPROVEMENT` and the per-row `Score` column.
   - `AVG IMPROVEMENT` of exactly `+0.0` with blank `Score` ("-") on completed runs is a BROKEN measurement display, NOT a real flat-line — the computed deltas live in `orch_agent_memory` optimization entries (verify via `mcp__rgos__cortex_optimization_status`). Treat blank scores on completed experiments as a P2 data-truthfulness defect.
   - Separately note the REAL trajectory (best_score_ratio trend) so a stuck/regressing metric is surfaced honestly, not hidden behind a display bug.

Record each panel's numbers in the report. If any panel shows a real problem, it is a finding — a green route-check does NOT override a red operator panel.

## Runtime Preference (after Playwright)

Use routes in this priority order — never report "blocked" due to Codex credits, as alternatives are always available:

1. **Playwright harness** (`scripts/hub-qa-playwright.ts`) — mandatory authenticated page check route; always runs first regardless of Codex state.
2. **agent-browser** — primary browser route for visual/interactive checks needing a real browser; use for screenshot proof and click interactions.
3. **Claude in-context** — API/SQL/data verification; always available.
4. **Codex Chrome** — optional supplement when other routes are active.

## Pages To Sample

Prioritize the surfaces Greg just reviewed and complained about:

- `/analytics`
- `/fleet`
- `/app/fleet/tasks`
- `/app/fleet/activity`
- `/app/cortex/theta`
- `/supreme-outstanding`
- `/app/work/inbox`
- `/app/work/approvals`
- Any visible AgentOps page with stale, fake, duplicated, unclear, or non-actionable data.

Do not require every page every hour if that would make the pass too slow. Rotate coverage and keep an explicit coverage list.

## Review Standard

For each checked page, evaluate:

- Meaning: is it clear what this page/card/metric means?
- Value: would Greg know what to do next?
- Currency: does the data look fresh and source-backed?
- Correctness: do labels, counts, statuses, and timestamps agree with source/task state?
- Trust: is demo/fixture/fake data clearly labeled?
- Completeness: are errors, empty states, auth blockers, and partial data disclosed honestly?
- Nav/IA: are sections duplicative or unclear, especially schedules, crons, routines, and task groupings?
- Visual usability: do controls, cursors, labels, buttons, and cards overlap or hide content?

Selector-only PASS is not sufficient. Stale data, misleading labels, fake data presented as real, weak insight, unclear meaning, incomplete workflows, and no next action are dogfood failures.

## Severity Classification

After collecting Playwright FAIL/DEFERRED results and any agent-browser evidence, classify each finding:

- **P1**: Auth broken, page not loading, data completely missing, critical workflow blocked.
- **P2**: Misleading data, stale content older than 1h, broken filter/action, missing key metric.
- **P3**: UX friction, minor label issues, low-value empty states, cosmetic problems.

Route P1 and P2 findings immediately to orchestrator inbox:
```bash
cortextos bus send-message orchestrator normal "Dogfood P1/P2 findings: <page> — <brief summary of issues>"
```

Do NOT Telegram Greg directly. Orchestrator decides when and whether to surface to Greg.

## Actions

- If a problem is small and already has an assigned owner/task, update that task with evidence instead of opening a duplicate.
- If a new distinct defect exists, create exactly one scoped task with:
  - success_criteria
  - out_of_scope
  - escalation_triggers
  - source_hierarchy
  - preferred_runtime
  - required_capabilities
  - fallback_reason
  - goal_ancestry
- Use existing active lanes when applicable:
  - Fixture isolation
  - Truthful dogfood latest-run status
  - Activity/Theta truthfulness
  - Schedule/nav IA
  - Cursor/avatar visual occlusion
  - Supreme Mentions freshness

## Output

Write a short report under `output/agentops-hourly-dogfood/YYYYMMDD-HHMM-report.md` with:

- Runtime used and auth state.
- Pages sampled (include which were run via Playwright vs other routes).
- Playwright results summary (PASS/FAIL/DEFERRED per page).
- Findings by severity (P1/P2/P3).
- Existing tasks updated.
- New tasks created, if any.
- Exact blockers, if any.
- Next hour recommendation.

Log an `agentops_hourly_dogfood` event. Do NOT send Telegram directly to Greg. Route all P1/P2 findings to orchestrator via `cortextos bus send-message orchestrator normal "<summary>"`. Orchestrator decides when and whether to surface to Greg.
