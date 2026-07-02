# App Signals Deep QA Cron

Run a no-send production QA pass for App Signals and sync the `hub_qa` health snapshot.

## Steps

1. Create a bounded CortexOS task for the cron run with success criteria requiring:
   - current artifact path,
   - target/final URL,
   - browser status,
   - console/page errors,
   - `hub_qa` sync result or explicit blocker.
2. Source org secrets before running any QA script so the RGOS Supabase service credentials are in the cron shell:
   ```bash
   set -a
   source "$CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/secrets.env"
   set +a
   ```
3. Use an ephemeral Supabase admin magic-link session from existing configured RGOS service credentials. Do not use Greg's browser profile or Google OAuth.
4. Load `https://hub.revopsglobal.com/app/signals` in Playwright or `dev-browser`; the expected post-login route may canonicalize to `https://agentops.revopsglobal.com/signals`.
5. Capture JSON evidence and a screenshot under `output/app-signals-deep-qa/<timestamp>/`.
6. Mark the pass healthy only if:
   - the final route is not `/auth`,
   - the Signal Monitoring page renders,
   - console errors are zero,
   - failed requests are zero,
   - core metrics render (`Active Watchers`, `Active Signals`, `Critical`, `Last Scan`).
7. Upsert the fresh result to `agentops_deliverables` with `source='hub_qa'` using existing service credentials only. Do not mutate app data or click `Dismiss`.
8. Save artifacts to the task, complete the task with the pass/fail/follow-up counts, and log `cron_completed`.

## If Blocked

- If the prompt, auth seed, route, or sync credentials are missing, write a blocker artifact and mark the task blocked.
- Send an internal bus message to `analyst` or `orchestrator` only if the blocker requires their action.
- Do not send Telegram from Codex.
