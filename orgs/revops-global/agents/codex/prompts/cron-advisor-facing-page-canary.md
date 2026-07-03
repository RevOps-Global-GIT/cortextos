# Advisor Facing Page Canary Cron

> Recovery note: the original VM-only prompt file was not present in git, daemon state backups, local prompt snapshots, or Claude file history. This reviewed reconstruction is based on the live cron prompt in `config.json`, prior canary artifacts under `output/advisor-facing-page-canary/`, the historical untracked runner `.advisor-facing-page-canary.mjs`, and current `scripts/advisor-canary-claude.mjs` behavior.

Run one bounded no-send advisor-facing dashboard canary and refresh the `advisor_canary` health snapshot when credentials allow it.

## Boundaries

- Do not send Telegram.
- Do not use Greg's personal browser profile or Computer Use for browser/UI/web automation.
- Do not deploy, merge, edit app code, or mutate production app data.
- Do not reconstruct missing secrets. If a required secret is absent, write a blocker artifact and stop.
- Keep this to one pass. Do not start loops or schedule follow-up crons.

## Target

- Production URL: `https://fidelity-dashboard-five.vercel.app`
- Canonical output: `output/advisor-facing-page-canary/<timestamp>/`
- Required artifacts:
  - `results.json`
  - `canary-browser-results.json`
  - `report.md`
  - screenshot when a permitted headless/browser route is available
- Health source: `agentops_deliverables.source='advisor_canary'`

## Steps

1. Create a bounded CortexOS task only if the run will take more than a quick cron pass. Otherwise, write the artifact and log the cron completion.
2. Set a UTC timestamp and create the output directory under this agent:
   ```bash
   STAMP=$(date -u +%Y-%m-%d-%H%M)
   OUT_DIR="output/advisor-facing-page-canary/$STAMP"
   mkdir -p "$OUT_DIR"
   ```
3. Prefer the maintained repo runner when it is safe on the current host. The runner controls the final timestamped output path; `OUT_DIR` is for prompt-level blockers:
   ```bash
   RUNNER="${CTX_FRAMEWORK_ROOT:-}/scripts/advisor-canary-claude.mjs"
   if [[ -z "$CTX_FRAMEWORK_ROOT" || ! -f "$RUNNER" ]]; then
     echo "advisor canary runner missing" > "$OUT_DIR/blocker.txt"
     exit 2
   fi
   if grep -q 'REPO = .*cortextos' "$RUNNER"; then
     echo "advisor canary runner still contains a VM-only fixed repo path" > "$OUT_DIR/blocker.txt"
     exit 2
   fi
   node "$RUNNER"
   ```
4. If the maintained runner is blocked by a host-path or missing-secret error, do not patch the script inline during the cron. Write:
   - `blocker.json` with the command, exit code, stderr summary, missing path or env var, and next action.
   - `report.md` with status `blocked`.
5. A healthy result requires all of:
   - HTTP status is 200.
   - The page contains `Portfolio Command Center`.
   - Upload copy or upload markup is present.
   - An advice disclaimer is present.
   - Stale paid-feed wording is absent.
   - Page errors and material failed requests are zero when a browser route runs.
6. If the canary fails because the production page is stale or broken, preserve the artifact and route a concise internal bus message to `orchestrator` with the artifact path. Do not open duplicate tasks if an active advisor-canary or Fidelity dashboard task already exists.
7. If credentials allow, refresh the `advisor_canary` row in `agentops_deliverables` using existing service credentials only. If the sync fails because `INTERNAL_CRON_SECRET` or RGOS service credentials are missing, keep the canary artifact and record the sync blocker separately.
8. Log completion:
   ```bash
   cortextos bus log-event action cron_completed info --meta '{"agent":"'$CTX_AGENT_NAME'","cron":"advisor-facing-page-canary","artifact":"'"$OUT_DIR"'"}'
   ```

## If Blocked

- Write the blocker artifact under the timestamped output directory.
- Send an internal bus message to `orchestrator` only when another agent or human action is required.
- Do not retry indefinitely and do not mark the surface healthy without current artifact proof.
