# AgentOps Hourly Dogfood — Cron Prompt

Bounded product/operator dogfood pass. Runs every hour. Do not deploy, merge, post externally, or create duplicate tasks.

---

## Step 1 — Playwright Visual QA (MANDATORY, non-optional)

This step MUST run on every pass. Do not skip it, even if Codex credits are unavailable. The harness runs locally via `npx tsx` — it does not require Codex.

Determine a timestamp slug for this run's output directory:

```bash
SLUG=$(date -u +%Y%m%d-%H%M)
RUN_DIR="output/agentops-hourly-dogfood/${SLUG}"
mkdir -p "$RUN_DIR"
```

Run the harness for each page below. Execute them **in parallel** (background jobs):

```bash
cd /home/cortextos/cortextos

npx tsx scripts/hub-qa-playwright.ts --page / --user greg@revopsglobal.com --no-send > "$RUN_DIR/pw-dashboard.log" 2>&1 &
npx tsx scripts/hub-qa-playwright.ts --page /app/fleet/tasks --user greg@revopsglobal.com --no-send > "$RUN_DIR/pw-fleet-tasks.log" 2>&1 &
npx tsx scripts/hub-qa-playwright.ts --page /app/orchestrator --user greg@revopsglobal.com --no-send > "$RUN_DIR/pw-orchestrator.log" 2>&1 &
npx tsx scripts/hub-qa-playwright.ts --page /app/fleet/activity --user greg@revopsglobal.com --no-send > "$RUN_DIR/pw-activity.log" 2>&1 &

wait
echo "Playwright runs complete."
```

Collect results:

```bash
for log in "$RUN_DIR"/pw-*.log; do
  echo "=== $log ===" && tail -15 "$log"
done
```

Screenshots are written to `orgs/revops-global/agents/codex/output/playwright-qa/`.

**If a playwright run fails** (non-zero exit, timeout, auth error):
- Log the failure verbatim in the report under `## Playwright Failures`
- Continue to Step 2 — do NOT abandon the pass
- Do NOT report "no browser available" as if playwright was never attempted

---

## Step 2 — Bus/SQL Supplement Pass

After playwright, do the read-only fleet/task sweep:

```bash
cortextos bus list-tasks --org revops-global --status in_progress | head -30
cortextos bus list-agents
cortextos bus read-all-heartbeats
```

Query Supabase for recent task runs if relevant to findings.

---

## Step 3 — Triage Findings

For each finding:
- **P0/P1 defect**: create a task via `cortextos bus create-task` and route to the right owner. Telegram Greg only for P0/P1 or human-action blockers.
- **P2/P3 defect**: create a task, no Telegram.
- **Already tracked**: add evidence to the existing task, do not create a duplicate.
- **Resolved**: note it as RESOLVED in the report.

Duplicate check: run `cortextos bus list-tasks --org revops-global --status open` before creating any new defect task.

---

## Step 4 — Write Report

Write the run report to `output/agentops-hourly-dogfood/${SLUG}-report.md` with:

```markdown
# AgentOps Hourly Dogfood — <SLUG>

## Runtime
Playwright harness: <pages run, pass/fail per page>
Supplement: bus/SQL sweep

## Playwright Results
| Page | Status | Key Checks |
|------|--------|------------|
| / | PASS/FAIL/DEFERRED | ... |
| /app/fleet/tasks | ... | ... |
| /app/orchestrator | ... | ... |
| /app/fleet/activity | ... | ... |

## Playwright Failures
(if any — include exit code and last 5 lines of log)

## Findings
...

## Tasks Updated
...

## New Tasks Created
...

## Artifacts
- output/agentops-hourly-dogfood/<SLUG>/pw-*.log
- orgs/revops-global/agents/codex/output/playwright-qa/*.png (latest)
```

---

## Constraints

- Do NOT deploy, merge to main, post externally, or create duplicate tasks
- Do NOT modify secrets.env or .env files
- Do NOT restart agents or daemons
- Do NOT call `cortextos bus complete-task` on any task you did not create this pass
- Playwright step is non-negotiable — log the attempt even if it fails
