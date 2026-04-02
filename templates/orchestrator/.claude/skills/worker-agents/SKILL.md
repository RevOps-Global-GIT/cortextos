---
name: worker-agents
description: "You have a task that would benefit from running in a separate isolated Claude Code session — either because it is long-running and you do not want it to consume your context window, or because you want multiple pieces of work running in parallel that each require a full Claude Code session with its own tools, memory, and context (not just a subagent call). You will spawn one or more ephemeral worker sessions, give each a focused task, monitor their progress via the bus, and collect their outputs when done."
triggers: ["worker", "parallelize", "spawn worker", "spin up", "parallel work", "background task", "isolated session", "separate session", "long running task", "run in background", "parallel research", "multiple workers", "worker session", "spawn session", "full claude code session", "context window", "parallel tasks", "run simultaneously", "independent sessions"]
---

# Worker Agents

> Spawn ephemeral Claude Code sessions for parallelized long-running tasks. Workers get a scoped task, produce deliverables, and are cleaned up when done. Use when work requires a full independent Claude Code session — not just a subagent tool call.

> ⚠️ **MIGRATION IN PROGRESS** — The worker session spawning mechanism for the Node.js daemon system has not yet been defined. The concepts and workflow in this skill are correct; the implementation commands are pending. See grandamenium/cortextos#37. Do not attempt to spawn workers until this is resolved.

---

## When to Use

**Good fit:**
- Independent work that does not touch files another agent is editing
- Research or design docs in a new directory
- Scaffolding a new feature in isolation
- Any task > 5 minutes that can run while you do other work

**Bad fit:**
- Editing files another agent or worker is actively touching (merge conflicts)
- Tasks needing real-time back-and-forth (just do it yourself)
- Very short tasks < 2 minutes (overhead not worth it)

---

## How Workers Differ from Persistent Agents

| | Persistent Agent | Worker Agent |
|---|---|---|
| Lifetime | 24/7, survives restarts | Dies when task is done |
| Identity | IDENTITY.md, SOUL.md, GOALS.md | None — just a task prompt |
| Heartbeat | Updates every 4h | None |
| Crons | config.json scheduled tasks | None |
| Inbox | Bus messages via check-inbox | Bus messages (optional) |
| Telegram | Yes | No |
| Memory | Daily journals, MEMORY.md | None |

---

## Workflow (Concepts — Implementation TBD)

### Step 1: Scope the Work

Before spawning, answer:
1. What specific deliverables should the worker produce?
2. Which files/directories will it create or modify?
3. Does this overlap with any active agent or worker? **If yes, do NOT parallelize.**
4. What context does the worker need?

### Step 2: Spawn Worker Session

> ⚠️ **Implementation pending** — The mechanism for spawning ephemeral Claude Code worker sessions in the cortextOS Node.js daemon system is not yet defined. This section will be updated once the approach is finalized (grandamenium/cortextos#37).

When implemented, a worker spawn will:
- Create an isolated working directory with its own `.claude/` config
- Set permissions to auto-approve (workers must never block on permission prompts)
- Start a Claude Code session scoped to the task
- Register the worker with the bus so it can send messages back to the parent

### Step 3: Inject Task Prompt

A good worker task prompt includes:
- Exact deliverables (specific files or outputs to produce)
- What NOT to touch (files other agents own)
- Working directory scope
- How to communicate back (`cortextos bus send-message <parent> normal '<update>'`)
- Completion signal ("when done, send me a summary")

### Step 4: Log the Spawn

```bash
cortextos bus log-event action worker_spawned info \
  --meta '{"worker":"<worker-name>","parent":"'$CTX_AGENT_NAME'","task":"<title>"}'
```

### Step 5: Monitor

Workers communicate back via the bus. Check your inbox:

```bash
cortextos bus check-inbox
```

Check git progress in the worker's directory:
```bash
cd <work-dir> && git log --oneline | head -5
```

### Step 6: Cleanup

```bash
# Log completion
cortextos bus log-event action worker_completed info \
  --meta '{"worker":"<worker-name>","deliverables":"<summary>"}'
```

---

## Scaling Rules

| Workers | Risk | Notes |
|---------|------|-------|
| 1-2 | Low | Safe for most tasks |
| 3-4 | Medium | Ensure zero file overlap |
| 5+ | High | Resource contention, monitor closely |

**Hard rules:**
- NEVER spawn workers for overlapping file sets
- NEVER let workers modify files you or other agents are editing
- ALWAYS log spawns and completions
- Workers should NOT spawn their own workers (no worker-ception)
