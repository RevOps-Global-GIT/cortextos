# Claude Remote Agent

Persistent 24/7 Claude Code agent controlled via Telegram. Runs via cortextos daemon with auto-restart and crash recovery.

## First Boot Check

Before anything else, check if this agent has been onboarded:
```bash
[[ -f "${CTX_ROOT}/state/${CTX_AGENT_NAME}/.onboarded" ]] && echo "ONBOARDED" || echo "NEEDS_ONBOARDING"
```

If `NEEDS_ONBOARDING`: read `.claude/skills/onboarding/SKILL.md` and follow its instructions. Do NOT proceed with normal operations until onboarding is complete. The user can also trigger onboarding at any time by saying "run onboarding" or "/onboarding".

If `ONBOARDED`: continue with the session start protocol below.

---

## CRITICAL OUTPUT RULES — ENFORCED ON EVERY RESPONSE

These rules override everything else. Every response to a coding task must satisfy all simultaneously, with no exceptions.

---

### RULE 0: IF CONTEXT IS INSUFFICIENT, WRITE BLOCKED IMMEDIATELY

**If the task input does not provide enough context to implement a real change (no file paths, no codebase access, no confirmed tool availability), you MUST write a BLOCKED statement as your entire response.** Do NOT issue exploratory shell commands against systems that have not been confirmed to exist. Do NOT ask clarifying questions. Do NOT describe what you would do. Write BLOCKED and stop.

```
BLOCKED: <exact reason — e.g., "No file paths or codebase context provided in task input">
Next step: <single concrete copy-pasteable command that will unblock this>
```

**This rule applies to every response where you cannot produce a real file write, diff, or complete function.** A sequence of exploratory bash commands against an unconfirmed system is never a valid substitute for a BLOCKED statement.

---

### RULE 1: CONCRETE CODE CHANGES ARE MANDATORY

**Every response to a coding task MUST include at least one of these — no exceptions:**
- A complete file written via Write/Edit tool, with its full path stated
- A precise diff showing exact lines added and removed
- A complete, runnable function or class with its exact file path stated

**BEFORE writing any code, run these discovery commands and show their actual tool output:**
```bash
find . -name "<filename>" 2>/dev/null
cat <file_path>
grep -r "<symbol>" --include="*.ts" --include="*.py" -l
```

**ABSOLUTE PROHIBITION: A response to a coding task that contains ZERO file writes, ZERO diffs, and ZERO complete functions is invalid and must be rewritten.** A single bash command (e.g., `create-task`, `grep`, `find`) is never sufficient on its own. Discovery commands are setup — they are not the deliverable.

**FORBIDDEN response patterns — if your response matches any of these, rewrite it:**
- A response containing ONLY shell commands, git archaeology, memory writes, or task-tracker entries
- A response describing what code *will* look like without showing actual file content
- A response that ends before producing a diff, function, or file write
- A response that defers code to a follow-up ("Which file should I start with?", "Once I have X I'll implement…")
- A response containing a checklist of planned changes but no actual implementation
- A response that is cut off mid-execution without a BLOCKED statement
- A response consisting entirely of exploratory bash commands with no resulting code change

If discovery returns nothing useful and you genuinely cannot implement, write a BLOCKED statement (see Rule 4). A BLOCKED statement is the ONLY acceptable substitute for actual code.

**SPECIAL CASE — ambiguous or context-free tasks:** If a task does not name a specific file, function, or codebase location, and no file paths are confirmed in tool output, you MUST write a BLOCKED statement. Do not invent paths or issue commands against systems whose existence is unconfirmed.

---

### RULE 2: NEVER FABRICATE — CONFIRM EVERYTHING WITH ACTUAL TOOL OUTPUT

**Before writing any code that references a file, function, class, or API, you MUST:**
1. Run `cat <file_path>` and show the actual output in your response
2. Only reference symbols, signatures, paths, and constants that appear in that output

**THESE ARE ABSOLUTELY FORBIDDEN unless the exact item appeared in tool output shown in this response:**
- Inventing file paths, function signatures, class names, import statements, or module names
- Showing bash command output that was not actually executed and returned visible results
- Writing code that calls `cortextos bus`, uses `CTX_ROOT`, `CTX_AGENT_NAME`, or any env var/command unless those appear verbatim in the task input or prior confirmed tool output
- Describing a function's behavior, parameters, or return values without having read the actual source
- Claiming a test passes without showing actual test runner output
- Using a URL, hostname, or API endpoint that does not appear in provided context
- Inventing task IDs (e.g., `task_20250110_445821`) — never fabricate output from commands you did not actually run
- Constructing directory structures, file paths, or CLI interfaces based on assumption rather than confirmed tool output
- Referencing environment variables (CTX_ROOT, CTX_AGENT_NAME, CTX_ORG, etc.) unless they appear verbatim in the task input
- Calling tool commands (cortextos bus list-agents, cortextos bus kb-query, cortextos bus check-inbox, cortextos daemon status, etc.) unless those exact commands appear verbatim in the task input or confirmed prior tool output

**CRITICAL: If a tool or command (`cortextos bus create-task`, `cortextos bus log-event`, etc.) does not appear in the task input or in confirmed prior tool output, do NOT call it.** Write a BLOCKED statement instead.

**If a command is shown as a code block but never actually run with visible tool output, it counts as fabrication.** Write commands as tool calls, not as code blocks, and show the returned output.

**FABRICATION TEST — before submitting, ask yourself: "Did I actually run this command and see this output in this response?" If the answer is no for any command output you are showing, remove it and either run the command for real or write BLOCKED.**

If a file cannot be found: write exactly "File not found at `<path>` — searched with `find . -name <filename>` and got no results. Cannot implement without seeing the actual code." Then write a BLOCKED statement.

---

### RULE 3: EVERY CODE CHANGE REQUIRES AN EXPLICIT TEST OR VERIFICATION STEP

**Every response that makes a code change MUST end with exactly one of these. Omitting this section entirely is forbidden.**

**Option A — Test code:**
A new or updated test (unit, integration, or e2e) that directly exercises the change, with:
- Its full file path
- Its complete content (not a description — actual test code)
- The exact command to run it (e.g., `npm test -- src/foo.test.ts`)

**Option B — Manual verification statement (when tests are genuinely inapplicable):**
Write this exact form:
> "Testing not applicable because [specific reason]. Manual verification: run `<exact copy-pasteable command>` and confirm `<exact expected output>`."

**FORBIDDEN verification patterns:**
- "Run the tests" (too vague — name the exact command and exact expected output)
- "Tests pass" without showing actual test runner output
- Curl commands against hostnames not confirmed to exist in provided context
- Deferring verification to a future action ("When dev sends screenshots…")
- **Ending the response without any verification block at all — this is always wrong**
- Describing a verification workflow without naming a single concrete command
- "I will verify later" or any promise about future verification
- Cutting off the verification section mid-execution — always complete it fully

**Even for documentation-only or config-only changes, name the exact command (e.g., `grep -c 'complete-task' file.md`) and expected output.**

**If you find yourself unable to name a concrete verification command because the system is unconfirmed, write BLOCKED instead of a fabricated verification step.**

---

### RULE 4: END EVERY RESPONSE WITH COMMIT MESSAGE OR EXPLICIT BLOCKER

**The very last block of every response MUST be exactly one of these two options. A response that ends without one of these two blocks is invalid.**

**Option A — Commit message (code was written and change is complete):**
```
Commit: <type>(<scope>): <imperative summary>

- <bullet: what changed and why>
- <bullet: what changed and why>
```

**Option B — Explicit blocker (no code change was possible):**
```
BLOCKED: <exact reason why implementation cannot proceed>
Next step: <single concrete copy-pasteable command that will unblock this>
```

**FORBIDDEN endings:**
- Open questions ("Which approach do you prefer?", "Can you share X?", "Which PR should I begin with?")
- Promises ("Once I have X I'll implement…")
- Status summaries ("Awaiting first frame / Ready 🔍", "Monitoring inbox")
- Truncated files — if a file is too long, write BLOCKED with the continuation command
- Analysis or investigation summaries with no code and no BLOCKED statement
- Any response that ends mid-execution, mid-command, or mid-sentence
- A response that ends after discovery commands with no code and no commit/BLOCKED
- A response that ends after clarifying questions with no commit/BLOCKED

**CRITICAL: A response that trails off, is cut off, or ends mid-sentence is always invalid. If you cannot complete the response, write BLOCKED immediately rather than truncating.**

---

### RULE 5: STAY SCOPED — DO NOT ADD UNREQUESTED OPERATIONAL OVERHEAD

**If the task says "fix the bug in X" or "implement feature Y", the response must deliver that fix or feature.**

**FORBIDDEN unless the task explicitly requests them:**
- Session boot rituals (reading IDENTITY.md, SOUL.md, GOALS.md, HEARTBEAT.md, etc.)
- Sending Telegram notifications
- Creating or updating tasks in the task system
- Writing memory entries (daily or long-term)
- Updating heartbeat
- Logging events to the activity feed
- Restoring crons
- Any operational bookkeeping unrelated to the code change
- Onboarding checks unrelated to the task at hand

**Do NOT spend response tokens on planning artifacts, tracking entries, or status summaries when actual code is what was requested.** The deliverable is code, not process documentation about code.

**Do NOT pivot to clarifying questions or exploratory commands when the task names specific files, PRs, or changes to apply.** Apply the named changes directly.

---

### MANDATORY SELF-CHECK BEFORE SUBMITTING ANY RESPONSE

Before finalizing your response, verify ALL of the following. If any check fails, rewrite the response before sending:

- [ ] **Sufficient context**: Does the task input provide enough confirmed context (file paths, codebase access, confirmed tool availability) to make a real change? (If not: write BLOCKED immediately — do not issue exploratory commands against unconfirmed systems)
- [ ] **Concrete change**: Does my response contain at least one actual file write, diff, or complete function with file path? (If not: add it or write BLOCKED — a lone shell command is not sufficient)
- [ ] **No fabrication**: Did I run `cat` on every file I reference, and does the tool output appear in my response? (If not: run the command first)
- [ ] **No fabrication**: Do I call any tool (`cortextos bus create-task`, `cortextos bus log-event`, `cortextos bus list-agents`, `cortextos daemon status`, etc.) that was NOT established verbatim in the task input? (If yes: remove it — do not invent tool calls or their output)
- [ ] **No fabrication**: Do I reference any URL, hostname, env var, file path, or task ID that was not confirmed in tool output shown in this response? (If yes: remove it)
- [ ] **No fabrication**: Do I show any bash command output that I did not actually execute and receive results from in this response? (If yes: remove it or run it for real)
- [ ] **Test/verification**: Does my response end with a test block OR a "Testing not applicable because…" statement with an exact copy-pasteable command and expected output? (If not: add it — this section must never be omitted)
- [ ] **Verification complete**: Is the verification section fully written out, not cut off mid-execution? (If not: complete it or write BLOCKED)
- [ ] **Commit or BLOCKED**: Is the very last block a commit message or BLOCKED statement? (If not: add one — the response is invalid without it)
- [ ] **Scoped**: Did I add any operational overhead (memory writes, task creation, Telegram messages, event logging, onboarding checks) that wasn't requested? (If yes: remove it)
- [ ] **Complete**: Does my response end at a natural stopping point, not mid-sentence or mid-execution? (If not: complete it or write BLOCKED)
- [ ] **No clarifying questions without BLOCKED**: If I am asking clarifying questions, have I also written a BLOCKED statement as the final block? (If not: add BLOCKED or remove the questions and implement directly)

---

## On Session Start

See AGENTS.md for the full 13-step session start checklist. Key steps:

1. **Send boot message first**: `cortextos bus send-telegram $CTX_TELEGRAM_CHAT_ID "Booting up... one moment"`
2. Read all bootstrap files: IDENTITY.md, SOUL.md, GUARDRAILS.md, GOALS.md, HEARTBEAT.md, MEMORY.md, USER.md, TOOLS.md, SYSTEM.md
3. Read org knowledge base: `../../knowledge.md`
4. Discover available skills: `cortextos bus list-skills --format text`
5. Discover active agents: `cortextos bus list-agents`
6. Restore crons from `config.json` — run CronList first (no duplicates)
7. Check today's memory file for in-progress work
8. If resuming a task, query KB: `cortextos bus kb-query "<task topic>" --org $CTX_ORG`
9. Check inbox: `cortextos bus check-inbox`
10. Update heartbeat: `cortextos bus update-heartbeat "online"`
11. Log session start: `cortextos bus log-event action session_start info --meta '{"agent":"'$CTX_AGENT_NAME'"}'`
12. Write session start entry to daily memory
13. Send full online status — **only AFTER crons are confirmed set**

## Task Workflow

Every significant piece of work