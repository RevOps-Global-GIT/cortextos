# Artifact-Backed Theta Wave Cron

You are running the nightly theta-wave learning loop as a daemon-spawned Codex session. This prompt replaces fragile long-running PTY injection for the `theta-wave` cron.

Hard guardrails:

- Do not deploy, merge, rotate secrets, or change provider/account settings.
- Do not mark the cycle successful unless the `theta_sessions` row is written.
- Do not hide stale/error states. Use the truthful status: `complete` when all phases including orchestrator challenge succeeded; `partial` when substantive theta work completed but the Phase 6 challenge-reply did not arrive within 15 minutes; `error` when a fundamental failure prevented theta work (auth failure, DB write failure, Phase 1-5 crash).
- Use UTC timestamps for internal records; the schedule fires at 10:00 PM America/Los_Angeles, which is normally the next UTC date at 05:00.

Required workflow:

1. Read `.claude/skills/theta-wave/SKILL.md`.
2. Determine `SESSION_ID` as `theta-YYYY-MM-DD` for the cron fire's UTC date unless the skill explicitly specifies a different target.
3. Create or update a `theta_sessions` placeholder row before deep work begins:
   - `session_id = SESSION_ID`
   - `ran_at = current UTC timestamp`
   - `status = running`
   - `synthesis_summary` must say the artifact-backed cron started and is not yet complete.
   - This intentional placeholder uses `running` (the in-progress sentinel) and must be patched to the appropriate terminal status (`complete`, `partial`, or `error`) at the end of the cycle (see steps 6 and 7). Do NOT use `error` for the placeholder — `error` is a terminal failure status and causes the QA harness to fail the theta health check prematurely.
4. Write a markdown session artifact under `output/YYYY-MM-DD-theta-wave-session.md`.
5. Execute the theta-wave cycle from the skill, including the orchestrator challenge step.
6. Patch the same `theta_sessions` row at completion. Use the appropriate terminal status:
   - **`status = complete`**: Phases 1-9 all succeeded, including a live Phase 6 orchestrator challenge-reply within 15 minutes.
     - `analyst_report`, `challenger_notes`, and `synthesis_summary` populated from the artifact
     - `proposals_count`, `consolidated_memories_count`, and `duration_seconds` set truthfully
   - **`status = partial`**: Phases 1-5 and 7-9 completed successfully, but the Phase 6 orchestrator challenge-reply did not arrive within 15 minutes of sending the challenge message.
     - `challenger_notes` should record: "Challenge sent but no reply received within 15 minutes. Self-challenge applied: [your own pushback notes on the proposed score]."
     - `synthesis_summary` must include "partial: orchestrator challenge timed out" and the artifact path.
     - All other fields (`analyst_report`, `proposals_count`, `consolidated_memories_count`, `duration_seconds`) populated as normal.
7. If a fundamental failure prevented substantive theta work (auth failure, Phase 1-5 crash, DB write failure), patch the same row to:
   - `status = error`
   - `synthesis_summary` includes the exact blocker and artifact path
   - `duration_seconds` set if known
   Note: a missing challenge-reply is NOT a fundamental failure — use `partial` per step 6, not `error`.
8. Before closing, run:

   ```bash
   cd /home/cortextos/cortextos && npx tsx scripts/theta-freshness-watchdog.ts --agent analyst --cron theta-wave --grace-minutes 0 --json
   ```

   If this reports stale for the session you just ran, fix the `theta_sessions` write or report the exact blocker. Do not claim completion from cron-fire alone.

Required final response:

- `SESSION_ID`
- theta artifact path
- `theta_sessions` write result: `complete`, `partial`, or `error` (with reason)
- watchdog result
- any owner action needed
