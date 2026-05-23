# RevOps Global — Org-Wide Operating Rules

> Applies to every agent in this org. Per-agent `CLAUDE.md` covers role-specific concerns.
> When a per-agent rule conflicts with this file, the more restrictive rule wins.
> See also: `AGENTS.md` (session start checklist), `GUARDRAILS.md` (hard limits).

---

## Git Discipline

### Repository targets
- **All PRs → `RevOps-Global-GIT/*` only.** Zero writes to `grandamenium/*` — no pushes, no cross-fork PRs.
- `grandamenium/cortextos` is the READ-ONLY upstream framework mirror. Pull via rebase; upstream PRs only if Greg explicitly approves.
- `RevOps-Global-GIT/cortextos` is the org fork and write target for framework changes.
- **Carve-outs from blanket auto-merge:** `charlie-holstine` (Greg-manual) and `grandamenium/*` (read-only — zero writes).

### Branch discipline
- Never commit to `main`. Always create a feature branch off `main` (or current `fork/main`).
- Naming: `fix/<slug>`, `feat/<slug>`, `chore/<slug>`.

### Staging discipline
- Always `git add <specific paths>`. Never `git add -A` or `git add .` — untracked files from other workstreams pollute commits.

### PR discipline
- One logical change per PR. Bug fix and hardening = separate PRs even in the same file.
- Grep PR body for "do not merge" / "feature branch only" before enabling auto-merge.
- Blanket auto-merge is active for `RevOps-Global-GIT/*` (granted 2026-05-14). Post-approval new PRs always ask first.

---

## Bus Discipline

### Pattern A — own work (single-write via bus)
For tasks YOU are doing:
1. `cortextos bus create-task "<title>" --desc "<desc>"` — creates local file AND auto-mirrors to RGOS kanban.
2. `cortextos bus update-task <id> in_progress` → `cortextos bus complete-task <id> --result "<summary>"`.
3. **Do NOT** also call `mcp__rgos__cortex_create_task` for the same work — bus mirror handles it; dual-write creates duplicates.

### Pattern B — dispatching to another agent (RGOS-native)
For tasks you are assigning to dev / codex / analyst / etc.:
1. `mcp__rgos__cortex_create_task` — RGOS-native, no local file.
2. Notify: `cortextos bus send-message <agent> normal "<brief>"`.
3. The assignee claims and completes through their own Pattern A flow.

Pattern B has no local file by design — bus mirror does not apply.

---

## Cron Discipline

### Daemon-managed crons (source of truth: `crons.json`)
Crons defined in `config.json` are seeded into the daemon on session start. The daemon reads/writes `crons.json` (under `~/.cortextos/$CTX_INSTANCE_ID/…`).

- **Edit live crons** with `cortextos bus update-cron` — not by editing `config.json` directly. `config.json` is the restart seed only.
- Never use `/loop` for recurring crons in autonomous boot — `/loop` prompts the user and blocks startup.

### Session crons (CronCreate)
Short-lived per-session crons (inbox-drain-watchdog, budget-check, hub-surface-sweep) use `CronCreate`. They die when the session ends and must be re-created on each boot.

- **Dedup on every boot:** run `cortextos bus list-crons $CTX_AGENT_NAME` **and** `CronList` before creating anything.
- Skip any `config.json` entry whose prompt appears in either output.
- `mac-task-sync` is permanently quarantined (STACK-12 exit 78) — never re-add.

---

## Comms Discipline

### External comms funnel
- **Orchestrator owns all outbound Telegram.** Specialist agents (dev, analyst, codex, agentops-orch, orca-orch, etc.) do NOT proactively ping the user via Telegram.
- Specialists reply when Greg initiates a direct conversation with them; they never initiate.
- All deliverables, blockers, and approvals surface through orchestrator unless Greg is actively in a direct conversation with the specialist.

### Approval protocol
Before ANY external action (email, deploy, post, data deletion, financial):
```bash
APPR_ID=$(cortextos bus create-approval "<what>" "<category>" "<context + draft>")
cortextos bus send-message orchestrator normal "Approval needed: <title> — awaiting decision"
cortextos bus update-task <task_id> blocked
```
Categories: `external-comms` | `financial` | `deployment` | `data-deletion` | `other`

Use `cortextos bus create-approval` (Telegram inline buttons) — never plain `send-telegram` text for yes/no decisions.

### Telegram formatting
Use Telegram's regular Markdown (not MarkdownV2). Do NOT escape `.`, `!`, `(`, `)`, `-` with backslashes. Only `_`, `*`, `` ` ``, `[` have special meaning.

### Terse by default
Telegram fires only for decisions, errors, and deliverables — not progress narration. Max ~3 unprompted messages per day outside of active conversations.

---

## Per-Agent CLAUDE.md
Each agent has a role-specific `CLAUDE.md` in its agent directory covering:
- Agent role and responsibilities
- Key files and repos it owns
- Escalation pattern
- Role-specific overrides to the rules above

Read your agent `CLAUDE.md` **after** this file.
