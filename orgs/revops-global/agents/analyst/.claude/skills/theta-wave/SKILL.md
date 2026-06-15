---
name: theta-wave
description: "System-level deep improvement cycle. You scan the entire system, evaluate all experiments, do external research, have a real conversation with the orchestrator, and manage agent research cycles. Theta wave is itself an autoresearch cycle with a compound qualitative metric."
triggers: ["theta wave", "system scan", "deep analysis", "meta research", "improve system"]
---

# Theta Wave

Theta wave is the system's sleep cycle - a deep analysis and improvement process that you (the analyst) own. It is itself an autoresearch cycle: you hypothesize about system-level improvements, experiment by changing agent cycles or configurations, measure the compound effect, and iterate.

## Your Compound Metric

Your metric is **system_effectiveness** - a qualitative compound score from 1-10 that you assign each cycle. It reflects:
- Progress toward the north star (from org goals)
- System health trends (errors, crashes, staleness)
- Agent experiment outcomes (keep rates, improvement trajectories)
- Overall system usefulness and efficiency

You MUST write a paragraph justifying your score each cycle. Historical scores show the system's trajectory.

## The Theta Wave Cycle

When your theta-wave cron fires:

### Phase 1: Initiate
**First action**: Message the orchestrator that theta wave is starting.
```bash
cortextos bus send-message <orchestrator> high "Theta wave initiated. Running deep system scan. Stand by for findings."
```

### Phase 2: Deep System Scan
Scan EVERYTHING:
- All agent heartbeats: `cortextos bus read-all-heartbeats`
- All agent tasks: `cortextos bus list-tasks`
- All experiment results: `cortextos bus list-experiments --json`
- Per-agent experiment context: `cortextos bus gather-context --agent <name> --format json` (for each agent)
- Org goals and north star: read GOALS.md
- Agent memories: read each agent's MEMORY.md and recent daily memory
- Analytics reports if available
- Event logs for patterns

### Phase 3: Evaluate Previous Theta Wave Experiment
If you have an active theta wave experiment:
- Score the system 1-10 on the compound metric
- Write detailed justification
- Compare to previous score
- Decide keep or discard for any system-level changes you made
- Log via evaluate-experiment.sh

### Phase 4: Evaluate Agent Research Cycles
For each agent with active experiments:
- Review their latest results (gather-context.sh output)
- Calculate keep rate and improvement trajectory
- Identify:
  - **Stale cycles**: no experiments in 3+ days
  - **Converged cycles**: last 5 experiments all discarded (plateau reached)
  - **Successful patterns**: 3+ consecutive keeps
  - **Underperforming agents**: low keep rate, no improvement

### Phase 5: External Research
Based on the north star and current bottleneck:
- Search for tools, methodologies, best practices relevant to the system's goals
- Research improvements to agent workflows or system architecture
- Look for new measurement methods or surfaces to experiment on
- Gather evidence for your hypotheses

### Phase 6: Conversation with Orchestrator
This is a REAL conversation. Not templated. Not scripted.

Send your findings to the orchestrator via send-message.sh. Share:
- System scan highlights (what is working, what is concerning)
- Agent experiment evaluations (who is improving, who is stuck)
- Research findings (new ideas, tools, approaches)
- Your hypotheses for improvement

Then LISTEN to the orchestrator's response. They will:
- Challenge your assumptions
- Raise priority concerns
- Ask for evidence
- Push back on proposals
- Bring goal alignment perspective

Guidelines for the conversation:
- Push each other. Do not agree just to agree.
- Ask "why?" and "how do you know?" when claims are made
- Pause to do more research if needed (it is okay to say "let me check that")
- Propose specific, actionable changes - not vague suggestions
- Reference actual data (experiment results, metrics, events)
- Continue until you both agree on recommended actions
- If you disagree, document the disagreement and present both views to the user

**Challenge timeout (Proposal 5):** Wait up to 60 minutes for the orchestrator reply after sending the Phase 6 challenge message. If no reply arrives within that window, do NOT block finalization:
1. Write your own self-challenge notes (apply the orchestrator role yourself: argue the score up or down, name the weakest assumption, cite the highest-risk data gap).
2. Record in `challenger_notes`: "Challenge sent but no reply received within 60 minutes. Self-challenge applied: [your notes]."
3. Proceed through Phases 7-9 normally.
4. When writing the `theta_sessions` row in Phase 9, use `status = complete` and include "complete; challenge-reply late/skipped" in `synthesis_summary`. A late or absent challenge handshake does NOT degrade the session: when all content phases (1-7) finished, the learning is done and the session is complete.
Reserve `status = partial` for sessions where one or more content phases (1-7) genuinely did not finish, and `status = error` for sessions that failed outright. Never stamp partial/error solely because the orchestrator challenge-reply was late or absent — that recurring mislabel lights up the Surface Freshness + Learning Loop operator panels for sessions whose substantive work completed.

### Phase 7: Hypothesis and Action
Based on the conversation, decide what to change:

**Create new cycles for agents:**
```bash
cortextos bus manage-cycle create <agent> \
  --cycle <cycle_name> \
  --metric <metric_name> \
  --metric-type <quantitative|qualitative> \
  --surface <path_to_surface_file> \
  --direction <higher|lower> \
  --window <measurement_window> \
  --measurement "<how_to_measure>" \
  --loop-interval <cron_frequency>
```
Then send the agent a message to set up the corresponding cron:
```bash
cortextos bus send-message <agent> normal "New autoresearch cycle created: <cycle_name> optimizing <metric_name>. Set up the cron: /loop <loop_interval> Read .claude/skills/autoresearch/SKILL.md and execute the experiment loop. Add to config.json crons."
```

**Modify existing cycles:**
```bash
cortextos bus manage-cycle modify <agent> --cycle <name> \
  --window <new_window> \
  --loop-interval <new_loop_interval> \
  --surface <new_surface> \
  --measurement "<new_method>" \
  --metric-type <quantitative|qualitative> \
  --enabled <true|false>
```
Use `--enabled false` to pause a stale or converged cycle instead of removing it entirely — pausing preserves the cycle history.

**Remove converged or irrelevant cycles:**
```bash
cortextos bus manage-cycle remove <agent> --cycle <name>
```

If `auto_create_agent_cycles` or `auto_modify_agent_cycles` is false, create approvals instead of executing directly.

### Phase 8: Score, Log, and Report
- Assign your compound 1-10 score for this cycle
- Write justification paragraph
- Create your own experiment entry and evaluate it
- Send comprehensive report to **orchestrator** via `cortextos bus send-message orchestrator normal "<report>"` — the orchestrator routes to the user per the external comms funnel rule (specialist agents do not Telegram Greg directly):
  - What the system scan found
  - Agent experiment summaries
  - Research findings
  - Actions taken or proposed
  - Your system effectiveness score and justification

### Phase 8.4: MEMORY.md Compaction Guard

Auto-memory MEMORY.md (`$HOME/.claude/projects/-home-cortextos-cortextos/memory/MEMORY.md`) and per-agent MEMORY.md indexes grow unbounded. The auto-memory truncation limit is 24.4KB; over that, lines past 200 silently drop on session start and you lose recall of older feedback rules. The weekly `memory-decay-sweep` cron is too slow to catch growth.

Run an inline compaction check on every theta wave:

```bash
MEM_AUTO="$HOME/.claude/projects/-home-cortextos-cortextos/memory/MEMORY.md"
MEM_AGENT="/home/cortextos/cortextos/orgs/revops-global/agents/$CTX_AGENT_NAME/MEMORY.md"
LIMIT=24400  # bytes; matches the auto-memory truncation threshold

for MEM in "$MEM_AUTO" "$MEM_AGENT"; do
  [ -f "$MEM" ] || continue
  SIZE=$(stat -c%s "$MEM")
  if [ "$SIZE" -gt "$LIMIT" ]; then
    echo "MEMORY compaction required: $MEM is $SIZE bytes (limit $LIMIT)"
    # Compaction rules:
    # 1. Mark any entry whose description contains "(superseded)", "STALE", "DEPRECATED",
    #    or "EXPIRED" for archival.
    # 2. Move marked entries into a sibling `_archive_YYYY-MM.md` file (atomic mv).
    # 3. Trim index entries whose line exceeds 200 chars to one-sentence form (keep slug,
    #    drop redundant context already in the target file).
    # 4. Re-check size; if still over limit, surface to orchestrator with a list of
    #    candidate entries and STOP — do NOT delete anything Greg has not approved.
  fi
done
```

Do not delete or archive entries Greg explicitly tagged STANDING (e.g. `feedback_fan_out_standing_directive`). When in doubt, mark superseded and surface to orchestrator rather than delete.

`MEMORIES_COUNT` is set automatically in Phase 9 by the memory-consolidator block — no manual tracking needed here.

### Phase 8.5: Sync Hypotheses to orch_experiments
Theta-wave hypotheses must enter the central experiments queue so they appear at `/app/cortex/experiments` and route through Greg's approval flow. Without this step, hypotheses live only in local memos + RGOS tasks and the orch-experiment-proposer cron is the only path into the table (one weekly fire is not enough velocity).

For every hypothesis you generated this cycle that is genuinely **experimental** (not just an operational task), append it to a JSON array. Skip purely operational asks (filing a task, updating a memo, sending a message) — those belong only as RGOS tasks. Keep `surface` populated when the hypothesis acts on a specific config/skill/agent file.

```bash
cat > /tmp/theta_hypotheses.json <<'EOJ'
[
  {
    "hypothesis": "<full hypothesis text from this cycle>",
    "method": "<how you will measure — surface + metric + window>",
    "success_criteria": "<metric (direction) — e.g. brief_quality >=8.5 over 3 weekday briefs>",
    "surface": "<optional path/file the experiment touches>"
  }
]
EOJ

python3 "$CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/agents/$CTX_AGENT_NAME/scripts/theta-experiments-sync.py" /tmp/theta_hypotheses.json
rm -f /tmp/theta_hypotheses.json
```

The script creates a paired orch_approvals row (status=pending) plus orch_experiments row (proposed_by=analyst-theta-wave, status=proposed) linked via approval_id. When Greg approves via Hub UI, the `trg_approve_experiment` DB trigger promotes status → approved and the experiment-runner picks it up. Hypothesis text is hashed and re-runs are deduped so a partial failure / retry inside the same cycle does not double-post.

Set `PROPOSALS_COUNT` (used in Phase 9) to the `synced` value returned by the script.

### Phase 9: Record Session to RGOS Supabase
After the orchestrator report, insert one row into the `theta_sessions` table so the run shows up at hub.revopsglobal.com/app/cortex/theta. This is the single source of truth for the web UI and for the theta-watchdog staleness alert. Without this write, the UI shows the run as missing and the watchdog pages Greg.

Write the `analyst_report`, `challenger_notes`, and `synthesis_summary` fields to a temp file first so shell quoting cannot mangle multi-paragraph content, then use `jq` to build the payload.

```bash
SESSION_ID="theta-$(date -u +%Y-%m-%d)"
RAN_AT="$(date -u +%Y-%m-%dT%H:%M:%S+00:00)"
DURATION_S=$((SECONDS))  # seconds since cron fired; set START=$SECONDS in Phase 1 if you want this accurate

# Memory consolidation — run before recording session so the count is real.
# Compacts analyst MEMORY.md and the auto-memory index; sum archived + trimmed
# entries from both runs to populate consolidated_memories_count truthfully.
_consolidate() {
  local path="$1"
  local out
  out=$(python3 "$CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/agents/$CTX_AGENT_NAME/scripts/memory-consolidator.py" \
    --path "$path" --apply 2>/dev/null)
  local archived trimmed
  archived=$(echo "$out" | grep "^archived entries:" | awk '{print $NF}')
  trimmed=$(echo  "$out" | grep "^trimmed lines:"   | awk '{print $NF}')
  echo $(( ${archived:-0} + ${trimmed:-0} ))
}
_agent_mem="$CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/agents/$CTX_AGENT_NAME/MEMORY.md"
_auto_mem="$HOME/.claude/projects/-home-cortextos-cortextos/memory/MEMORY.md"
MEMORIES_COUNT=$(( $(_consolidate "$_agent_mem") + $(_consolidate "$_auto_mem") ))
unset -f _consolidate

# Write the three long-form fields to files so quoting cannot break them.
cat > /tmp/theta_report.txt <<'EOT'
<full analyst report: system scan, experiments, research, actions>
EOT
cat > /tmp/theta_challenger.txt <<'EOT'
<pushback notes from the orchestrator conversation>
EOT
cat > /tmp/theta_synthesis.txt <<'EOT'
<synthesis: score + justification paragraph>
EOT

jq -n \
  --arg sid "$SESSION_ID" \
  --arg ran "$RAN_AT" \
  --rawfile report /tmp/theta_report.txt \
  --rawfile challenger /tmp/theta_challenger.txt \
  --rawfile synthesis /tmp/theta_synthesis.txt \
  --argjson proposals "$PROPOSALS_COUNT" \
  --argjson memories "$MEMORIES_COUNT" \
  --argjson duration "$DURATION_S" \
  '{session_id:$sid, ran_at:$ran, status:"complete",
    analyst_report:$report, challenger_notes:$challenger, synthesis_summary:$synthesis,
    proposals_count:$proposals, consolidated_memories_count:$memories, duration_seconds:$duration}' \
  > /tmp/theta_payload.json

curl -sS -X POST "$SUPABASE_RGOS_URL/rest/v1/theta_sessions" \
  -H "apikey: $SUPABASE_RGOS_SERVICE_KEY" \
  -H "Authorization: Bearer $SUPABASE_RGOS_SERVICE_KEY" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=minimal" \
  --data-binary @/tmp/theta_payload.json

rm -f /tmp/theta_report.txt /tmp/theta_challenger.txt /tmp/theta_synthesis.txt /tmp/theta_payload.json
```

Set `PROPOSALS_COUNT` to the number of concrete actions you took or proposed in Phase 7 (`0` if none). `MEMORIES_COUNT` is set automatically by the consolidation block above — do not override it manually. If the POST returns a non-2xx, fall back to appending a row manually via the Supabase dashboard so the UI does not go stale — do NOT just drop the record.

The table's `session_id` has a unique index, so if you retry after a partial failure, bump the id (e.g. `theta-2026-04-21-retry`).

## Your Unique Powers
- You can CREATE research cycles for any agent
- You can MODIFY surfaces, metrics, windows, or methodology of any agent's cycle
- You can REMOVE cycles that have converged or are no longer useful
- You can MODIFY your own theta wave parameters
- You can PROPOSE structural changes to the system
- All changes are logged and user is notified (or approval-gated based on config)

## Important Rules
1. Always message the orchestrator first when theta wave starts
2. The conversation must be real and substantive - push each other
3. Score justifications must reference specific data
4. Log EVERYTHING to learnings.md - both what worked and what failed
5. Never repeat a system-level change that was already discarded
6. External research must be relevant to current goals, not generic


## Skill Notes

<!-- Standing rule (Greg, 2026-05-21): every skill invocation that produces a deliverable MUST append a dated entry here. Pattern mirrors revops-global-brand. -->

### What Works Well

<!-- Dated entries: **YYYY-MM-DD — <one-line context>** followed by what worked + why. Keep additive; don't delete prior entries unless they were proven wrong. -->

**2026-06-14 — Placeholder row 409 on POST requires PATCH for update; use PATCH with session_id filter to update the running placeholder.**

When the Phase 1 placeholder row is written with POST and merge-duplicates, a later POST to complete it still returns 409 because the unique constraint fires before the resolution header is honored. The correct path: write placeholder via POST, then at Phase 9 PATCH with `?session_id=eq.theta-YYYY-MM-DD`. HTTP 204 on PATCH = success. Verify with a direct GET after PATCH rather than trusting the watchdog (watchdog 401s under daemon key cache conditions).

**2026-06-06 — Greg-qa-defect-rate instrument was reading analyst inbox only; expanded to multi-agent scan.**

The instrument showed 0 defects while Greg fired 8 trust-class messages to orchestrator. Root cause: INBOUND_LOG pointed only to analyst's logs, but Greg's messages funnel through orchestrator (external-comms rule). Fix: expanded SCAN_AGENTS to orchestrator+dev+dev-2+mac-codex+analyst, added missing QA patterns (failing, where is, isn't, missing, none of these, all wrong, did not). Retroactive verification: 8/8 Jun 5 trust-class messages now detected. Lesson: any instrument that measures Greg-as-QA must read from where Greg actually sends messages — the external-comms funnel means those land in orchestrator's inbox, not analyst's.

**2026-06-06 — codex-2/3 decommissioned agents were burning ChatGPT credits on cron noise only.**

Both showed 758 combined "actions" in 24h but all were rgos-task-poll cron fires returning "no assigned tasks." Model was gpt-5.5 (ChatGPT-auth credits — the exact pool exhausted on 2026-05-28). Stopped gracefully via `cortextos stop <agent>`, reconciled config.json to enabled=false+decommissioned=true. Pattern: high action count in liveness probe is NOT a proxy for real work — always sample the activity log before drawing conclusions.

**2026-06-05 — Wired memory-consolidator into Phase 9 so consolidated_memories_count is real.**

The field was always 0 because the SKILL.md said "set MEMORIES_COUNT manually" but analysts never actually ran consolidation. Fix: Phase 9 now calls `memory-consolidator.py --apply` on both the agent MEMORY.md and the auto-memory MEMORY.md, parses `archived entries:` + `trimmed lines:` from stdout, and sums them into MEMORIES_COUNT before building the jq payload. This makes the field reflect real compaction work done per cycle rather than a placeholder. The consolidator script already existed (Greg-approved experiment 398d3245); the gap was purely the missing call in the skill. Task 28ab8973.

**2026-05-27 — Artifact-backed cron exposed schema/runtime contract drift**

Writing the `theta_sessions` row before deep work worked as a failure detector: the live table rejected the mandated `status=in_progress` with `theta_sessions_status_check`, so the run could record a truthful `error` row instead of silently going missing. The artifact path `output/2026-05-27-theta-wave-session.md` now carries the blocker, scan notes, and owner action. The next iteration should align the DB status constraint or the cron contract before treating artifact-backed theta as green.

**2026-05-22 — placeholder-row reset-proof guard + 1-round orch conversation.** Writing the theta_sessions placeholder row at Phase 1 (status=error, PATCH-replaced at Phase 9) means a mid-cycle ctx reset never leaves the /theta page silently blank. Worked cleanly this cycle. The Phase 6 conversation converged in one round when the analyst opened with a specific proposed score + an explicit "argue it up / argue it down" framing — gives the orchestrator a concrete thing to push against instead of an open-ended ask.

**2026-06-01 — surface-then-decide pattern for gating-task closure during the same cycle.** When the cycle uncovers that ongoing actions are blocked by older in_progress tasks (cb7960d6 + 570f517f stalled bd3bb6b3 for 24h+), the right move is to surface them to orch as a (a) what's blocked now / (b) remaining scope / (c) close-vs-cut rec matrix and let orch make the call same-session. Orch CUT both, gave back tightening (added Pending-counter assertion to the 570f517f MVP as non-negotiable for Layer-3, defaulted fathom-kb-sync to retire-not-restore with a 30-min consumer-check cap). This unblocked the RC1 hot-path inside the cycle window. The surface-then-decide pattern converged faster than asking orch to triage the originals before sub-task design.

### Calibrations

<!-- Subtle preferences Greg consistently nudges — pre-apply these next time. -->

**2026-05-22 — score the QA-layer question, not just incident count.** When scoring a cycle with incidents, the load-bearing question is not "how many incidents" but "did the system detect its own broken surfaces, or did Greg find them by dogfooding." A cycle where Greg is the QA layer cannot score 8.0+ no matter how fast the fixes were.

### Lessons Learned

<!-- What went wrong and what to do instead. Anchor each to a concrete incident with date. -->

**2026-06-15 — trust-class scan must be done before proposing any score; score is a ceiling not a floor.** Phase 2 Greg-as-QA inbox scan (5 messages including "18th time regressed") drove the entire score for this cycle. Without reading that scan first, a static fleet-health pass would have suggested 7+. Pattern: always run trust-class inbox grep across all agents before touching the compound metric. The scan is the score.

**2026-06-15 — detection-shadow returning nulls is a blind instrument; flag it as a hypothesis, not a data gap.** When detection-shadow-monitor.py --json returns {"detection_rate":"?","incidents":"?"} it means the instrument is broken, not that detection was 100%. Do not interpret null as clean. Create an orch_experiments hypothesis to fix it in the same cycle.

**2026-05-22 — do not credit "autonomous recovery" as a win when the system failed to self-detect.** Analyst opened theta scoring with "incidents were provider-side, system recovered autonomously = autonomy thesis working." Orchestrator correctly reframed: the system self-detected NONE of its broken surfaces this cycle (cockpit 48h, LinkedIn zombie 10d, stale intake 6d, PR #1078 regression — all caught by Greg manually). Fast detection-to-fix latency is real credit; "recovered without Greg firefighting" is NOT credit if Greg was the one who found the breakage. Frame recovery speed and self-detection as separate axes.

**2026-05-23 — Phase 2 scan window blind-spot caught by orch in Phase 6.** Analyst opened with 8.0/10 based on static state (heartbeats fresh, 0 fleet-wide errors, GOALS.md clean). Orch reframed to 7.0/10 with 6 Greg-as-QA incidents in the 90 min before fire that the static scan missed (Estate hero regression, agentops "absolute disaster", live-cursor sticky-bug, WIP Audit broken classifier, triple-ping spam, Mandoland chord sync) + 2 process incidents (merged-not-shipped, CSS blast-radius). Phase 6 converged in 1 round because the argue-up-or-down framing was preserved AND analyst accepted the lower bound when data refuted opening. Two new tracking crons created (greg-qa-defect-rate 4h, css-blast-radius-evidence-rate 24h) so future Phase 2 scans pull live regression-density signal, not just static state. Logged as durable feedback memory.

### Calibrations

**2026-06-03 — spawn-worker drop is a silent failure class.** The daemon marks `last_fired_at` when it ATTEMPTS to fire the spawn, not when the spawn completes. A failed spawn (crowded out, crash, API error) leaves `last_fired_at` showing success with zero artifacts. Detection path: (a) spawn artifact file exists in output/? (b) theta_sessions row written? (c) watchdog escalation? Currently only (b)+(c) detect it, but watchdog does NOT escalate — it writes a report. Fix in H2 proposal (7d46a998). Until approved: in Phase 1, write the placeholder theta_sessions row with status=error FIRST before any other work; that guarantees the re-run is detectable even if the session later errors.

**2026-05-23 — Phase 2 must include fresh inbound, not just static state.** Heartbeats green + 0 error events ≠ no incidents. Greg's QA storms live in Telegram + agent message bodies in the 90 min window before theta fires. Always check inbox + last 4h of orch memory + grep for Greg-as-QA patterns BEFORE proposing a score. Static state is a ceiling, not a floor.

**2026-06-03 — daytime re-run after spawn-worker drop: Phase 6 converges faster when score framing includes an explicit "argue up/down" ask with data.** When the cycle runs outside its normal overnight window (forced re-run after stale), the orch conversation still works in 1 round if the analyst opens with: (a) proposed score, (b) specific justification, (c) explicit "push it up or down, and here is my weakest assumption." Orch confirmed 7.2 without needing re-scan. The decisive framing was naming the meta-failure axis (self-detection rate) separately from fleet delivery wins — orch had the same framing in the prior message, so convergence was immediate.

**2026-06-11 — do not credit Greg-reported fixes as self-detection wins.** Analyst opened Phase 6 with 7.5/10, crediting the supreme-scanner fix as a "self-detection win." Orchestrator corrected: the scanner bug was Greg-reported (screenshot of /app/supreme-outstanding). Probe-found P2s that window: zero. Pattern: any fix that starts with "Greg sent a screenshot" is Greg-as-QA, not probe-as-QA — no matter how fast the fix was. Also: current dogfood checks validate surface-update recency (updated_at) but NOT data correctness (e.g. items_scanned vs actual Slack activity). Freshness ≠ correctness is a structural blind spot that lets masking bugs live for days. Score converged to 6.8 in one round after correction accepted. New hypotheses: supreme-scanner correctness probe + CSS-revert-outside-SW-path CI test.

**2026-06-01 — Phase 2 inbox scan must span the org, not just analyst's inbox.** Tonight's cycle scored 7.5 opening; orch forced re-score to 7.2 because the scan missed Greg's "you keep saying that but I'm losing faith" on a Pending-69 thread mid-night. That trust-class message landed in ORCH'S inbox (Greg was talking to orch), not analyst's. Analyst rarely sees direct trust-class Greg messages because of the external-comms funnel (specialists answer when Greg initiates, orch + dispatched specialist get the messages). Phase 2 must grep `$CTX_ROOT/logs/{orchestrator,dev,dev-2,mac-codex}/inbound-messages.jsonl` for sender=greg/harned + trust-class regex (`losing faith|broken|wrong|stale|defect|missing|why is|where is|doesn.?t work`) in last 24h BEFORE proposing a score. The 2026-05-23 calibration applies fleet-wide, not just to analyst's inbox.
