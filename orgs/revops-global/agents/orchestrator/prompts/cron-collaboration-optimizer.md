# Collaboration Optimizer Cron

> Recovery note: the original VM-only prompt file was not present in git, daemon state backups, local prompt snapshots, or Claude file history. This reviewed reconstruction is based on the live cron prompt in `config.json`, orchestrator coordination responsibilities, recent morning-brief issues, and CortexOS task/bus workflow rules.

Execute exactly one weekly collaboration-friction retro. Write recommendations and exit.

## Boundaries

- Do not send Telegram.
- Do not deploy, merge, restart agents, or change cron cadence from this cron.
- Do not create broad meta-work without concrete evidence.
- Do not duplicate existing tasks. Link or update the existing owner lane when one exists.
- Keep this as a retro and routing pass, not a repair sprint.

## Inputs

Review the last 7 days where available:

- Orchestrator and director goals and memory.
- Recent morning/evening/overnight briefs.
- `cortextos bus check-inbox`.
- `cortextos bus list-tasks --format json`.
- `cortextos bus list-agents`.
- Recent event log slices if available through bus tooling.
- Cron logs for missed, no-op, or repeatedly blocked crons.

## What Counts As Friction

- Duplicate tasks for the same blocker.
- Work held by an agent that is down, disabled, unscaffolded, or stale.
- Human tasks without clear step-by-step instructions.
- Approval tasks missing a parent blocked task.
- Repeated cron fires that no-op, fail from missing prompt files, or depend on dead VM paths.
- Cross-agent contradiction where one source says complete but live proof says otherwise.
- Missing artifact proof for a claimed QA, deploy, merge, or live-fix status.
- Routing drift, such as browser/UI work being dispatched to the wrong runtime.

## Steps

1. Build a short evidence table of the top collaboration frictions. Prefer exact ids, agent names, cron names, PR numbers, artifact paths, and timestamps.
2. For each candidate friction, check whether there is already an active durable task or current owner. Do not create a duplicate.
3. Write the report under:
   ```text
   output/collaboration-optimizer/YYYYMMDD-HHMM-report.md
   ```
4. Include:
   - top 3 to 7 frictions,
   - evidence,
   - recommended owner,
   - recommended next action,
   - whether a task already exists,
   - what not to do if the tempting action would duplicate work.
5. Create or update a durable task only for a narrow, immediately actionable fix with clear success criteria. Otherwise leave the report as recommendations.
6. Send an internal bus message to `director` only when a recommendation changes same-day priorities or needs Greg's decision.
7. Log completion:
   ```bash
   cortextos bus log-event action cron_completed info --meta '{"agent":"orchestrator","cron":"collaboration-optimizer","report":"<report_path>"}'
   ```

## Output Standard

The report should be brief and operational. It should let director or Greg decide what to do without rereading raw logs.
