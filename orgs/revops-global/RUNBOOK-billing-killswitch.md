# Runbook: June 15 Billing Reclassification Kill-Switch

**Owner:** Greg. **Created:** 2026-06-10 (June 15 billing migration plan).
**Trigger:** Evidence that PTY daemon agents are being billed as **programmatic** (drawing the $200/mo credit pool or hard-failing) instead of riding the Max subscription as interactive sessions.

## Background

On 2026-06-15 Anthropic moved programmatic usage (`claude -p`, Agent SDK, GitHub Actions) off Max
subscriptions onto $200/mo per-user programmatic credits (hard-fail on exhaustion; overflow billing
is OFF for this org by decision — see team-brain `docs/audits/2026-06-10-fleet-ops-audit.md` addendum).
Detection is currently a TTY check. The cortextos PTY agents run inside real node-pty TTYs
(`src/pty/agent-pty.ts`) and are expected to remain classified **interactive** (subscription-billed,
$0 marginal). That classification is a bet, not a guarantee. This runbook is the pre-staged response
if the bet fails. Target: **< 1 hour from detection to stabilized fleet.**

## Detection signals (any of these = open this runbook)

1. **Credit draw on a PTY account.** `cortextos bus check-usage-api` snapshots
   (`state/usage/latest.json`, daily JSONLs under `state/usage/`) show a credit-utilization
   dimension, or the Anthropic console shows programmatic-credit draw on an account that only
   runs PTY agents.
2. **New error strings in agent stdout/crash logs** mentioning credits, programmatic usage,
   billing, or upgrade prompts (`~/.cortextos/<instance>/logs/<agent>/stdout.log`, `crashes.log`).
3. **Fleet-wide simultaneous auth/limit failures** that don't match the known 5h/7d rate-limit
   shape handled by `src/bus/oauth.ts` rotation.
4. **Console:** subscription usage page shows PTY-agent volume migrated to the credit/API line.

## Response — Stage 1 (default, zero-spend posture): wind-down + Codex spillover

Per the approved migration plan, the default response is NOT to start paying — it is to shed load:

1. **Tier-down** per the `rate-limit-management` skill (3-tier wind-down). Practically:
   - Stop all non-core Claude agents immediately:
     `cortextos stop dev` (and any on-demand agents currently running: dev-2, qa-agent, mobile-agent, family-agent, design-agent, hub-dogfood).
   - Keep: `orchestrator` (coordination + Telegram front-door), `monitor` (haiku, near-free), `analyst` only if mid-critical-task.
2. **Codex spillover** for execution work: the orchestrator routes execution-shaped tasks to the
   Codex lane (`codex`, `codex-2` agents; `src/bus/spawn-codex.ts`; account pool in
   `orchestrator/config.json` `codex_account_pool` — 1 active + 2 standby). This lane already
   carried the front-door during the 2026-05-24 P0.
3. **If even the orchestrator is affected:** switch the Telegram front-door to the Codex
   app-server runtime (documented precedent: `codex_runtime_note` 2026-05-24 in orchestrator
   config; recovery path in `telegram_owner_note`).
4. **Notify Greg** via the orchestrator with the detection evidence. Do not silently degrade.

## Response — Stage 2 (Greg-gated escalation): API-key cutover

Only on Greg's explicit go (this converts $0 marginal into real API spend; the July-1 review
in the migration plan owns this decision):

1. Create a dedicated workspace + API key in the Anthropic console with a **hard monthly cap**
   (recommended $500–1,000/mo). The workspace cap is the runaway backstop — set it before the key
   is used anywhere.
2. Flip agents to the key using `scripts/billing-killswitch.sh` (see `--help`), or manually:
   append to `orgs/revops-global/agents/<agent>/.env` (loaded last into the PTY env, overrides
   org `secrets.env` — see `src/pty/agent-pty.ts` lines ~118-131):
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   ```
   and comment out any `CLAUDE_CODE_OAUTH_TOKEN` line in the same file so auth is unambiguous.
3. Restart each flipped agent: `cortextos stop <agent> && cortextos start <agent>`.
4. **Verify billing landed on the key** — do not assume. In the agent's working directory run:
   ```
   claude -p 'ok' --output-format json
   ```
   and confirm the init metadata reports `apiKeySource` = environment key (not OAuth). Then
   confirm spend appears in the console workspace, not the subscription page.
5. Stand down by re-commenting the key lines and restarting (`billing-killswitch.sh stand-down`).

## Drill

Rehearse Stage 2 mechanics on `monitor` (haiku — lowest stakes): arm, fire for monitor only,
verify `apiKeySource`, stand down. Time it; target < 15 min for one agent, < 1 hour fleet-wide.

## Related

- Migration plan + decision record: team-brain `docs/audits/2026-06-10-fleet-ops-audit.md` (addendum)
- Usage monitoring: `src/bus/oauth.ts` (`check-usage-api`, `state/usage/`)
- Codex limit classification: `src/bus/codex-fallback.ts`
- Model policy: team-brain `CLAUDE.md` → Model Policy
