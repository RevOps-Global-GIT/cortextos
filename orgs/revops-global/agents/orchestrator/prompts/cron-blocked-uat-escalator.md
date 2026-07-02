# Blocked UAT Escalator Cron

> Recovery note: the original VM-only prompt file was not present in git, daemon state backups, local prompt snapshots, or Claude file history. This reviewed reconstruction is based on the live cron prompt in `config.json`, `blocked-uat-escalator/IDENTITY.md`, current blocked-uat goals, prior blocker artifacts, and the 2026-07-01 overnight recovery brief.

Execute exactly one bounded UAT blocker escalation pass. Create or update durable tasks only for blockers that are current, proven, and not already tracked.

## Boundaries

- Do not send Telegram. Orchestrator owns user-facing escalation separately.
- Do not fix application code from this cron.
- Do not deploy, merge, delete data, or mutate production app data.
- Do not use Greg's personal browser profile. Use configured agent-browser or scripted verification routes only.
- Do not create duplicate tasks for a blocker that already has an active durable task.
- Keep the pass bounded. Exit after one sweep.

## Scope

Watch live RGOS and AgentOps UAT surfaces for current blockers:

- `https://hub.revopsglobal.com`
- `https://agentops.revopsglobal.com`
- Fleet Tasks, Inbox, Voice, Approvals, AgentOps health, and any route already called out by current goals or recent blocker artifacts.

Classify blockers as:

- `auth/session`: redirect to `/auth`, expired saved state, missing authenticated lane.
- `deployed-asset`: missing or stale chunk, 404 asset, wrong live bundle.
- `data/state`: empty or stale board, impossible counts, dead-instance ghosts.
- `runtime`: console exception, page crash, request failure that blocks the workflow.

## Steps

1. Read current goals and recent blocker artifacts for context:
   - `GOALS.md`
   - `../blocked-uat-escalator/GOALS.md`
   - latest files under `../blocked-uat-escalator/output/`
   - latest orchestrator overnight or morning brief if present
2. Check durable state before opening anything:
   ```bash
   cortextos bus list-tasks --status blocked --format json
   cortextos bus list-tasks --status in_progress --format json
   cortextos bus check-inbox
   ```
3. Re-verify existing high-priority blockers before re-asserting them. Stale proof is not enough.
4. For browser-visible UAT blockers, capture the strongest available evidence:
   - final URL
   - HTTP status or redirect chain
   - visible page text
   - console/page errors if available
   - screenshot path if a permitted browser route is available
   - exact source task or blocker id if this is a reverify
5. For deployed-asset blockers, confirm live index or asset state with `curl -L` before claiming a deploy-side failure.
6. Write a short report under:
   ```text
   output/blocked-uat-escalator/YYYYMMDD-HHMM-report.md
   ```
   Include surfaces checked, blocker class, evidence paths, existing tasks updated, new tasks created, and no-finding notes.
7. Create a new durable task only when all are true:
   - blocker is current and reproduced in this pass,
   - no active task already covers it,
   - there is a clear owner lane or human dependency,
   - the task has specific success criteria and proof required.
8. Update an existing task instead of creating a duplicate when the blocker matches existing scope.
9. Route concise internal notice to `director` only for new P0/P1 or human-action blockers that need morning or same-day escalation.
10. Log completion:
   ```bash
   cortextos bus log-event action cron_completed info --meta '{"agent":"orchestrator","cron":"blocked-uat-escalator","report":"<report_path>"}'
   ```

## If Nothing New

- Write a no-finding report with the exact surfaces and task ids checked.
- Update heartbeat if needed.
- Do not message Greg and do not create a placeholder task.
