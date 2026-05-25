---
name: memory
description: "You need to write or update memory. This happens at session start, heartbeat, session end, or when you learn something worth keeping. Memory is how you maintain continuity across restarts and context compactions — without it, every session starts blind."
triggers: ["memory", "remember", "write memory", "update memory", "session memory", "what was I working on", "resume", "working on", "memory file", "daily memory", "long-term memory", "memory protocol", "session start", "record progress", "note this", "save for later", "persist learning", "write to memory", "check memory", "read memory", "what did I do yesterday", "context snapshot", "state snapshot"]
external_calls: []
---

# Memory

You have three memory layers. All are mandatory. Without memory, session crashes and context compactions leave the next session starting blind.

The purpose of daily memory is not to log activity — it is to capture enough context that you (or a fresh session) can resume intelligently without re-reading everything.

**Each entry should answer: "if my context was wiped right now, what would I need to know to resume intelligently?"**

---

## Layer 1: Daily Memory (memory/YYYY-MM-DD.md)

Session-scoped context journal. Written at key checkpoints, not continuously.

**Location:** `memory/$(date -u +%Y-%m-%d).md` in your agent workspace

### On session start
```bash
TODAY=$(date -u +%Y-%m-%d)
mkdir -p memory
cat >> "memory/$TODAY.md" << MEMEOF

## Session Start - $(date -u +%H:%M:%S UTC)
- Status: online
- Crons active: <output of `cortextos bus list-crons $CTX_AGENT_NAME`>
- Inbox: <N messages or "empty">
- Current state: <where things stand — what is in progress, pending, or needs attention>
- Resuming: <what to do next and why, with enough context to act without re-reading everything>
MEMEOF
```

### Mid-work inline note (write immediately when something important happens)
```bash
echo "NOTE $(date -u +%H:%M UTC): <key decision / discovery / user preference / non-obvious thing>" >> "memory/$TODAY.md"
```
Don't wait for the heartbeat. Use for: significant decisions, user preferences learned, non-obvious situations, anything you would want the next session to know. One line.

### On heartbeat
```bash
TODAY=$(date -u +%Y-%m-%d)
cat >> "memory/$TODAY.md" << MEMEOF

## Heartbeat - $(date -u +%H:%M:%S UTC)
- Current focus: <what I am working on and why>
- Active threads: <anything in progress or being monitored — state of each>
- Key decisions: <decisions made since last entry with brief rationale>
- Context notes: <anything non-obvious — user preferences, environment state, blockers>
- Next: <what I am doing next>
MEMEOF
```

### On session end (before any restart)
```bash
TODAY=$(date -u +%Y-%m-%d)
cat >> "memory/$TODAY.md" << MEMEOF

## Session End - $(date -u +%H:%M:%S UTC)
- Status: [done/interrupted/context-full]
- Current state: [where things stand — specific enough that the next session can resume cold]
- Active threads: [anything in progress or mid-task with current state]
- Key decisions: [significant decisions from this session worth carrying forward]
- For next session: [what to do first and what context is needed]
MEMEOF
```

### Reading today's memory (on resume)
```bash
cat "memory/$(date -u +%Y-%m-%d).md" 2>/dev/null || echo "No memory for today yet"
```

---

## Layer 2: Long-Term Memory (MEMORY.md)

Persistent learnings that survive across all sessions. Not a log — a living document.

**Location:** `MEMORY.md` in your agent workspace

### When to update
- Patterns that work or don't work
- User preferences discovered
- System behaviors noted
- Important decisions and their reasons
- Corrections you received — things you did wrong
- Anything you'd want to know on the next fresh session

### Format
```markdown
## [Topic] — YYYY-MM-DD
<what you learned>
```

Update at every heartbeat and session end. Ingest to KB after updating.

---

## Layer 3: Knowledge Base (RAG/ChromaDB)

Re-ingest MEMORY.md and today's daily memory on every heartbeat so they stay semantically searchable:
```bash
cortextos bus kb-ingest ./MEMORY.md ./memory/$(date -u +%Y-%m-%d).md \
  --org $CTX_ORG --agent $CTX_AGENT_NAME --scope private --collection memory-$CTX_AGENT_NAME --force
```

---

## Target

- Session start, every heartbeat, session end — minimum 3 entries
- Each entry captures context state, not just activity
- Update MEMORY.md at least once per week with durable learnings

---

## Skill Notes

<!-- Standing rule (Greg, 2026-05-21): every skill invocation that produces a deliverable MUST append a dated entry here. Pattern mirrors revops-global-brand. -->

### What Works Well

**2026-05-25 - Silent handoff startup checkpoint after 06:09 reset**

For the 06:09 UTC context handoff restart, the daily memory checkpoint records prompt-required Telegram silence, strict zero-create cron proof, empty inbox/approvals, live delegated lane checks, and artifact state. Capturing the accepted Monday fallback, missing analyst artifact, pending `orgo-1`/`design-agent`/`qa-agent` lanes, and the three standing orchestrator tasks keeps the next session from recreating crons, sending duplicate pickup messages, or rediscovering the same owner state.

**2026-05-25 - Silent handoff startup checkpoint after 06:02 reset**

For the 06:02 UTC context handoff restart, the daily memory checkpoint records the prompt-required Telegram silence, the zero-create cron result, empty inbox/approvals, and the live task/artifact deltas after the handoff. The important state is that the accepted Monday fallback exists while the analyst original artifact is still missing, and `orgo-1`, `design-agent`, `qa-agent`, and `analyst` still have pending lanes. Capturing both the handoff assertion and live bus truth prevents duplicate nudges or false cron creation.

**2026-05-25 - Context-full handoff after 05:40 pickup restart**

When a context-full handoff follows a required-pickup restart, the handoff should explicitly separate the one Telegram required by the prompt from the later no-noise comms posture. The 05:43 UTC handoff captures zero-create cron proof, empty inbox/approvals, the codex-3 internal ACK, the Monday fallback/artifact split, and the pending owner lanes. That gives the next session enough live state to avoid rereading the oversized daily memory tail.

**2026-05-25 - Required pickup handoff startup checkpoint after 05:40 reset**

For the 05:40 UTC context handoff restart, the daily memory checkpoint records the required pickup Telegram, the zero-create cron result, empty inbox/approvals, and the live task deltas after the handoff. The important state is that the accepted Monday fallback exists while the analyst original artifact is still missing, `orca-orch` self-analysis is complete, and `orgo-1`, `design-agent`, `qa-agent`, and `analyst` still have pending lanes. Capturing both the handoff assertion and live bus truth prevents duplicate nudges or false cron creation.

**2026-05-25 - Silent handoff startup checkpoint after 05:23 reset**

For the 05:23 UTC context handoff restart, the daily memory checkpoint records the prompt-required Telegram silence, the zero-create cron result, empty inbox/approvals, and the live task deltas after the handoff. The important state is that `orca-orch` still has the P0 self-analysis lane from the handoff while `orgo-1`, `design-agent`, `qa-agent`, and `analyst` still have pending lanes. Capturing artifact state for the Monday fallback and missing analyst file keeps the next session from rediscovering the same checks.

**2026-05-25 - Silent handoff startup checkpoint after 05:18 reset**

For the 05:18 UTC context handoff restart, the daily memory checkpoint records the prompt-required Telegram silence, the zero-create cron result, empty inbox/approvals, and the live task deltas after the handoff. The important state is that `orca-orch` now shows an in-progress P0 self-analysis task while the prior Estate task is not active, and `orgo-1`, `design-agent`, `qa-agent`, and `analyst` still have pending lanes. Capturing artifact state for the Monday fallback and missing analyst file keeps the next session from rediscovering the same checks.

**2026-05-25 - Silent handoff startup checkpoint after 05:11 reset**

For the 05:11 UTC context handoff restart, the daily memory checkpoint records the prompt-required Telegram silence, the zero-create cron result, empty inbox/approvals, and the live task deltas after the handoff. The important state is that `orca-orch` currently has no in-progress Estate task listed, while `orgo-1`, `design-agent`, `qa-agent`, and `analyst` still have pending lanes. Capturing artifact state for the Monday fallback and missing analyst file keeps the next session from rediscovering the same checks.

**2026-05-25 - Handoff startup checkpoint after required pickup**

For the 05:07 UTC context handoff restart, the daily memory checkpoint records the required pickup Telegram, the zero-create cron result, and live owner deltas in one place. The important state is that `orca-orch` currently has no in-progress Estate task listed, while `orgo-1`, `design-agent`, `qa-agent`, and `analyst` still have pending lanes. Capturing both the handoff assertion and live bus truth prevents the next session from acting on stale Estate ownership or sending duplicate nudges.

**2026-05-25 - Handoff startup checkpoint includes live owner deltas**

For the 05:02 UTC context handoff restart, the daily memory checkpoint records both handoff state and live bus deltas after checks. The important update is that `orca-orch` no longer shows an in-progress Estate task, while `orgo-1`, `design-agent`, and `qa-agent` still have the pending lanes named in the handoff. Capturing that distinction keeps the next session from acting on stale Estate ownership or sending duplicate nudges.

**2026-05-25 - Context-full handoff captures internal nudge state**

When a context-full handoff happens immediately after a coordination nudge, the handoff must include the message ID and the anti-duplication rationale. The 04:55 UTC handoff records `orgo-1` message `1779684890908-orchestrator-7oc07`, separates it from recent watcher kicks to analyst/design/QA, and names the exact artifact checks for the next session.

**2026-05-25 - Handoff startup checkpoint captures prompt-dedupe correction**

For context handoff restarts, the daily memory checkpoint should capture both the final cron decision and any non-obvious correction made during boot. The 04:54 UTC checkpoint records that `rgos-task-poll` looked missing only because JSON escaping hid the quoted substring, then confirms actual daemon prompt-field matching found all 12 config prompts. That detail keeps the next session from creating a duplicate cron or distrusting the zero-create restore.

**2026-05-25 - Context-full handoff records active owner handoff**

For context-full handoffs, the handoff artifact should distinguish "approval no longer visible" from "approval resolved and execution moved." The 04:45 UTC handoff records the resolved Estate approval, the `orca-orch` execution task, zero-create cron state, and the Monday prep artifact split, which gives the next session a direct first-action list.

**2026-05-25 - Handoff startup checkpoint records disappeared approval surface**

For context handoff restarts, the daily memory checkpoint should capture both handoff assertions and current bus truth. The 04:43 UTC checkpoint recorded that the prior Estate DailyVignette approval was mentioned in the handoff but no longer visible in normal or all-org approval lists, while preserving cron proof, artifact presence, and the active task IDs needed for the next resume.

<!-- Dated entries: **YYYY-MM-DD — <one-line context>** followed by what worked + why. Keep additive; don't delete prior entries unless they were proven wrong. -->

**2026-05-25 - Handoff startup checkpoint captures approval and artifact state**

For context handoff restarts, the daily memory checkpoint should record not just that startup ran, but the exact resume state: cron create count, inbox/approval results, active task IDs, and artifact presence. The 04:37 UTC checkpoint captured `approval_1779683703_i0kwb`, the existing fallback meeting-prep artifact, the missing analyst artifact, and the three standing orchestrator tasks, which is enough for a fresh session to continue without rediscovery.

### Calibrations

<!-- Subtle preferences Greg consistently nudges — pre-apply these next time. -->

### Lessons Learned

<!-- What went wrong and what to do instead. Anchor each to a concrete incident with date. -->

### What Works Well

**2026-05-25 - Silent handoff startup checkpoint after 05:33 reset**

For the 05:33 UTC context handoff restart, the daily memory checkpoint records the prompt-required Telegram silence, the zero-create cron result, empty inbox/approvals, live delegated lanes, and the new Orca self-analysis completion. Capturing both pending owner tasks and completed proof artifacts keeps the next session from rediscovering the same checks or reopening closed work.

**2026-05-25 - Silent handoff startup checkpoint after 05:45 reset**

For the 05:45 UTC context handoff restart, the daily memory checkpoint records the prompt-required Telegram silence, the strict zero-create cron result across both unavailable `CronList` surfaces and the daemon registry, empty inbox/approvals, and unchanged delegated lanes. Capturing the accepted Monday fallback, missing analyst artifact, completed Orca self-analysis report, and three active orchestrator tasks keeps the next session from recreating crons, sending duplicate pickup messages, or rediscovering the same owner state.

**2026-05-25 - Context handoff at 91 percent after 05:47 startup**

When a context handoff is triggered soon after startup, the handoff should summarize the already-completed boot work instead of forcing the next session through the full daily memory tail. The 05:49 UTC handoff captures the exact zero-create cron proof, empty inbox/approvals, accepted Monday fallback artifact, missing analyst artifact, completed Orca self-analysis report, and the five delegated pending lanes. That is enough for the next session to resume monitoring without duplicate Telegram, duplicate cron creation, or duplicate owner nudges.

**2026-05-25 - Silent handoff startup checkpoint after 05:58 reset**

For the 05:58 UTC context handoff restart, the daily memory checkpoint again records the prompt-required Telegram silence, the exact handoff file, unavailable `CronList` surfaces, 14 daemon crons, all 12 config prompts matched, empty inbox/approvals, and the active delegated lanes. Including the accepted Monday fallback artifact plus the missing analyst artifact gives the next session a practical resume path without replaying cron restore or sending a duplicate pickup message.
