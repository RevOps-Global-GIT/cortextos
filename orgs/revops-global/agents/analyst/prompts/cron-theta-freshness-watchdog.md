# Theta Freshness Watchdog Cron

Run a read-only freshness check for the nightly theta-wave learning loop.

Hard guardrails:

- Read-only only: do not write `theta_sessions`, do not backfill rows, do not change crons, and do not deploy or merge.
- Do not treat cron-fire as success. Success requires a fresh `theta_sessions` row for the expected session date.
- If stale, report the stale state to orchestrator with the exact latest row and expected session id.

Steps:

1. Run:

   ```bash
   cd /home/cortextos/cortextos && npx tsx scripts/theta-freshness-watchdog.ts --agent analyst --cron theta-wave --grace-minutes 90 --json
   ```

2. If the command returns `status: "fresh"` or `status: "pending"`, record the result in your final response and stop.
3. If the command returns `status: "stale"` or exits non-zero:
   - send an internal bus message to orchestrator with the output JSON
   - do not create or modify session rows
   - do not use fallback/manual success criteria

Required final response:

- watchdog status
- expected session id
- latest durable theta session
- whether orchestrator was notified
