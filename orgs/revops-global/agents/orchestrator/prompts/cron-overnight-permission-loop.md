# Overnight Permission Loop Cron

> Recovery note: the original VM-only prompt file was not present in git, daemon state backups, local prompt snapshots, or Claude file history. This reviewed reconstruction is based on the live cron prompt in `config.json`, CortexOS approval/human-task rules, and orchestrator's overnight briefing responsibilities.

Execute exactly one narrow permission and unblock digest. Do not mutate external systems and exit.

## Boundaries

- Do not send Telegram.
- Do not email, post, deploy, merge, purchase, rotate credentials, delete data, or mutate production app data.
- Do not approve or reject approvals on Greg's behalf.
- Do not create noisy duplicate tasks.
- Do not start long investigations. This is a digest pass.

## Scope

Collect current permission and unblock items that need Greg, director, or an owner lane:

- Pending approvals.
- Human tasks.
- Blocked tasks waiting on approval, credentials, auth refresh, spend limits, external accounts, or physical/user action.
- Overnight agent messages that ask for permission or report blocked work.
- Repeated cron failures that require a secret, auth session, prompt file, or merge approval.

## Steps

1. Gather current state:
   ```bash
   cortextos bus check-inbox
   cortextos bus list-tasks --status blocked --format json
   cortextos bus list-tasks --project human-tasks --format json
   cortextos bus list-approvals --format json
   cortextos bus list-agents
   ```
   If a command is unavailable, note the exact command and error in the digest.
2. Collapse duplicates. If two tasks represent the same human action, present one canonical item and list the duplicate ids.
3. For each item, classify:
   - `approval`: Greg decision required before action.
   - `human`: Greg or another human must perform a capability step.
   - `owner`: another agent owns the next action.
   - `blocked-no-action`: known hold where no overnight action is appropriate.
4. Preserve exact ids, PR numbers, artifact paths, repo names, and required proof.
5. Write the digest under:
   ```text
   output/overnight-permission-loop/YYYYMMDD-HHMM-digest.md
   ```
6. If a P0/P1 item needs same-day awareness, send one concise internal bus message to `director` with the digest path. Do not message Greg directly from this cron.
7. Log completion:
   ```bash
   cortextos bus log-event action cron_completed info --meta '{"agent":"orchestrator","cron":"overnight-permission-loop","digest":"<digest_path>"}'
   ```

## Output Format

Use these sections:

- `Needs Greg`
- `Needs Director`
- `Needs Owner Agent`
- `Known Holds`
- `Duplicates Collapsed`
- `Commands That Failed`

Keep each item action-oriented: current state, why it is blocked, exact next action, and proof required to clear it.
