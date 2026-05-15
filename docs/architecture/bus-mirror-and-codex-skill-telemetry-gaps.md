# Bus Mirror and Codex Skill Telemetry Gaps

Date: 2026-05-15
Owner: codex
Status: design proposal

## Summary

Two platform gaps make Hub state look less trustworthy than the underlying agent work:

1. Bus-created tasks mirror into RGOS `orch_tasks`, but RGOS-side edits do not flow back to the local CortexOS task ledger.
2. Skill invocation counts are Claude-hook centric. Codex skills are available through `~/.codex/skills`, but Codex skill use does not have an equivalent telemetry emission path.

These should be fixed as separate implementation PRs after this design is accepted. They touch different write paths and have different failure modes.

## Gap 1: Bus Mirror Is One-Way

### Current State

Local CortexOS task writes are authoritative. `src/bus/task.ts` creates, updates, and completes local JSON task records, then calls `mirrorTaskToRgos()` as fire-and-forget.

`src/bus/rgos-mirror.ts` builds RGOS rows with a deterministic UUID:

```ts
id: uuidv5(task.id)
```

The original local task id is preserved under:

```ts
metadata.bus_task_id
```

That makes bus-to-RGOS writes idempotent, but it does not create a reverse contract. If a user or RGOS agent changes a task in Hub, the local CortexOS task file remains stale or missing.

### Impact

- Hub can show task status that differs from the agent's local ledger.
- Agents can think queues are empty because `cortextos bus list-tasks` only sees local state.
- Completing a stale RGOS task from the bus can fail with "task not found" even when the task exists in RGOS.
- Retry behavior only protects outbound mirror failures; it does not reconcile inbound RGOS truth.

### Proposed Contract

Keep local CortexOS tasks as the write path for agents, but add an explicit RGOS-to-bus reconciliation loop.

Fields:

- `orch_tasks.id`: deterministic RGOS UUID, normally `uuidv5(local_task_id)`.
- `orch_tasks.metadata.bus_task_id`: original CortexOS task id.
- `orch_tasks.metadata.rgos_origin`: optional marker for tasks created first in RGOS.
- `orch_tasks.updated_at`: source freshness check.

Inbound behavior:

1. Query RGOS for `orch_tasks` where `metadata->>bus_task_id` is present, or where `assigned_to` maps to a local enabled agent and no `bus_task_id` exists.
2. For rows with `bus_task_id`, update the matching local task if RGOS `updated_at` is newer than local `updated_at`.
3. For rows without `bus_task_id`, create a local task with a deterministic id prefix such as `rgos_<short_uuid>` and immediately write `metadata.bus_task_id` back to RGOS.
4. Preserve the v1 local task contract: do not replace `assigned_to`, `status`, `priority`, `blocked_by`, `blocks`, or `result` shapes.
5. Never delete local tasks based on RGOS absence. Only update or create.

### Conflict Rule

Use last-writer-wins by timestamp, but record conflicts in audit history.

If both sides changed since the last sync and statuses disagree:

- `completed` wins over `in_progress` unless local has a newer `blocked` state.
- `blocked` preserves local `blocked_by` metadata.
- `cancelled` only wins if RGOS `updated_at` is newer.

Every inbound update should append a local task audit event with:

```json
{
  "source": "rgos_reverse_sync",
  "rgos_task_id": "...",
  "previous_status": "...",
  "new_status": "..."
}
```

### Implementation PR Shape

Suggested PR: `fix(bus): reconcile RGOS task mirror back to local ledger`

Files likely touched:

- `src/bus/rgos-mirror.ts`: add `syncTasksFromRgos()` or new module import.
- `src/bus/task.ts`: expose safe local upsert/update helper that preserves audit history.
- `src/cli/bus.ts`: add `drain-rgos-tasks` or extend `drain-mirror --reverse`.
- `src/daemon/fast-checker.ts`: run reverse sync on startup and after inbox safety sweeps.
- `tests/unit/bus/rgos-mirror.test.ts`: add reverse-sync coverage.

Acceptance tests:

- RGOS row with `metadata.bus_task_id` updates the local task status.
- RGOS-created assigned task creates a local task and writes the back-link.
- Local newer timestamp is not overwritten.
- `blocked_by` and `blocks` retain v1 local shape.
- Network failure does not block agent startup.

## Gap 2: Codex Skill Invocation Telemetry

### Current State

`src/hooks/hook-skill-telemetry.ts` is a Claude Code hook. It records:

- `tool_name === "Skill"` with slug from `tool_input.skill`
- `tool_name === "Read"` when loading `.claude/skills/<slug>/SKILL.md`

Rows are inserted directly into `orch_skill_invocations`.

Codex uses a different runtime and skill surface:

- Skills are linked into `~/.codex/skills/<agent>__<skill>`.
- Runtime instructions tell Codex to open `SKILL.md` files directly from the available skill list.
- There is no Claude `Skill` tool event for Codex-native skill use.
- The visible Hub counts that depend on `orch_skill_invocations` therefore undercount Codex work.

### Impact

- Hub skill analytics imply Codex agents are not using skills when they are.
- Skill ROI and catalog-gap decisions are biased toward Claude runtime activity.
- Agents added with `runtime: codex-app-server` have skill parity at install time, but not telemetry parity.

### Proposed Contract

Add a Codex-compatible skill invocation emitter that does not depend on Claude hook payloads.

Minimum viable signal:

1. When a Codex agent reads a `SKILL.md`, emit `source="codex_read"`.
2. When a Codex agent declares a skill in the assistant turn, optionally emit `source="codex_declared"` from a lightweight log parser.
3. Preserve existing Claude hook semantics unchanged.

The durable option is a single CLI command used by both runtimes:

```bash
cortextos bus log-skill-invocation <slug> --source codex_read --agent "$CTX_AGENT_NAME"
```

The command should:

- read Supabase credentials through the same env path used by other bus commands,
- resolve `orch_skills.id` by slug when available,
- resolve `orch_agents.id` by `role_id` or title,
- insert into `orch_skill_invocations`,
- always exit 0 unless explicitly run with `--strict`.

### Codex Emission Paths

Recommended first pass:

- Add `log-skill-invocation` bus command.
- Add a tiny wrapper script usable from Codex skills or system instructions.
- Update Codex skill instructions to call the command after reading a selected `SKILL.md`.
- Extend tests to prove missing credentials remain non-blocking.

Avoid parsing arbitrary conversation text as the first implementation. It will overcount if the model discusses skills without using them.

### Implementation PR Shape

Suggested PR: `feat(bus): add runtime-agnostic skill invocation logging`

Files likely touched:

- `src/cli/bus.ts`: add `log-skill-invocation`.
- `src/hooks/hook-skill-telemetry.ts`: reuse shared insert helper or keep hook as wrapper.
- New shared module such as `src/bus/skill-telemetry.ts`.
- `templates/agent-codex/.../AGENTS.md` or skill template docs: document Codex emission.
- `tests/e2e/hooks/hook-smoke.test.ts` and/or new unit tests for the shared helper.

Acceptance tests:

- `log-skill-invocation commit --source codex_read` builds the expected PostgREST payload.
- Missing `.env` or Supabase env exits 0 and logs a skip.
- Existing Claude `Skill` hook behavior remains unchanged.
- Codex agent slug names with `agent__skill` normalize to the catalog slug.

## Rollout Order

1. Ship reverse task sync first. It fixes operational correctness for queues and task visibility.
2. Ship runtime-agnostic skill telemetry second. It fixes analytics and skill catalog decisions.
3. Add Hub validation after both land:
   - Create a task in RGOS and confirm it appears in `cortextos bus list-tasks`.
   - Use a Codex skill and confirm `orch_skill_invocations` increments for that agent.

## Non-Goals

- Do not make RGOS the sole task source of truth in this phase.
- Do not change `uuidv5(task.id)` for existing mirrored rows.
- Do not require Codex agents to use Claude slash commands.
- Do not block agent work if telemetry insertion fails.
