# Local Patches to cortextOS

This file documents local modifications to the upstream cortextOS codebase that do not exist on github.com/grandamenium/cortextos/main. Any upstream sync must preserve these.

## Branch: feat/daemon-cron-scheduler (current HEAD)

5 commits ahead of main, not pushed, no upstream tracking:

- 3cd25f7 refactor(cron-scheduler): drop log field from ManagedAgent interface
- 04560a3 feat(daemon): wire cron scheduler into AgentProcess + AgentManager (Phase 2)
- 9601b09 feat(daemon): standalone cron scheduler module (Phase 1)
- 9c7b082 feat(daemon): persist cron fire timestamps and add gap-detection nudge (issue #67)
- e11193c local: orphan cleanup, suppress duplicate boot notifications, fix CtxEnv type

**Why:** These commits implement proper cron expression handling so entries like `0 22 * * *` actually fire. Without them, interval-based crons work but cron-syntax crons silently drop. morning-brief and theta-wave both require this branch to fire.

**Files touched:** src/daemon/agent-manager.ts, src/daemon/agent-process.ts, src/daemon/cron-scheduler.ts, tests/unit/daemon/cron-scheduler.test.ts

**Status:** Local only. No upstream PR. Upstream reconciliation plan: TBD.

## Instance symlink

`~/.cortextos/default` is a symlink to `~/.cortextos/cortextos1`. This exists because the daemon was started with `--instance cortextos1` but `cortextos` CLI commands default to `--instance default`. The symlink makes both paths resolve to the same tree so bare CLI commands reach the running daemon. Deleting it breaks all `notify-agent` calls.

## Skill patches: theta-wave Phase 9

`templates/analyst/.claude/skills/theta-wave/SKILL.md` (and the live analyst copy) have a Phase 9 appended that upstream does not have. Phase 9 tells the analyst to call `mcp__rgos__cortex_theta_record_session` at the end of every theta wave cycle so the RGOS `theta_sessions` table populates. Without this, the RGOS dashboard theta page stays empty.

## ecosystem.config.js drift

`ecosystem.config.js` contains stale paths pointing at `/Users/davidhunter/` (upstream dev's machine) and `CTX_ORG=ascendops`. The running daemon does NOT use this file — PM2 was configured directly with the correct paths. Regenerating via `cortextos ecosystem` would need env vars set correctly first.

## Missing: scripts/upgrade.sh

Analyst's `upstream-sync` cron references `bash /home/cortextos/cortextos/scripts/upgrade.sh --dry-run` but this script does not exist. The cron fires daily into a nonexistent path. Either create the script or remove the cron. Yesterday's session log claimed this was built but it is not present.

## sessionRefresh writes .session-refresh marker (2026-04-15)

`src/daemon/agent-process.ts` — `sessionRefresh()` now writes `.session-refresh` into the agent's stateDir before calling `stop()`. The SessionEnd hook `src/hooks/hook-crash-alert.ts` already looks for this marker (line 121) but nothing upstream was writing it, so every planned 4h session rotation fell through to the default `crash` classification and sent `🚨 CRASH: agent died unexpectedly` to Telegram instead of `♻️ session refresh`. Without this patch, meeting-prep posts 6+ false-alarm CRASH notifications per day.

**Files touched:** `src/daemon/agent-process.ts` (sessionRefresh method only).

## TelegramPoller stop-before-start race (2026-04-15)

`src/telegram/poller.ts` + `src/daemon/agent-manager.ts` — fixes a race that caused orphaned, un-stoppable TelegramPollers to accumulate inside a long-running daemon, producing continuous `Conflict: terminated by other getUpdates request` (HTTP 409) from Telegram and silently disabling inbound messaging for the affected agent. 2026-04-15 incident: meeting-prep logged 1,339 conflicts and was effectively offline for hours.

**Mechanism:** `agent-manager.startAgent()` previously did `setTimeout(() => poller.start(), pollerDelay)` to stagger boot-time pollers. If any code path called `stopAgent()` during that delay, `poller.stop()` would set `running=false` on a poller whose while-loop hadn't started, the deferred `start()` would later fire and unconditionally set `running=true`, and the resulting poll loop was orphaned — no `entry.poller` reference held it, so no subsequent `stopAgent()` could ever kill it. A later `startAgent()` would then create a second live poller for the same bot token and the two would race forever.

**Fix:**
- `TelegramPoller.start()` now takes an `initialDelayMs` parameter and does the stagger internally.
- New `stopRequested` / `started` flags make `start()` idempotent and make `stop()` effective regardless of whether `start()` has run yet.
- `agent-manager.ts` no longer uses `setTimeout` for poller start; it calls `poller.start(pollerDelay)` directly and the delay is handled inside the poller.

**Files touched:** `src/telegram/poller.ts`, `src/daemon/agent-manager.ts`.

**Status:** Local only. No upstream PR. The upstream BUG-011 fix (PR #11) addressed PTY restart races but did not touch the TelegramPoller start-stop race.
