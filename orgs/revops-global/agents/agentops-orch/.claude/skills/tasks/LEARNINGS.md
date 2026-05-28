# Task System — Learnings

## Always use skip_review=true for routine tasks

**What:** `mcp__rgos__cortex_complete_task` defaults to status='review'. For routine dev work (retries, bug fixes, migrations, audits, automated tasks), always pass `skip_review: true` to go straight to 'completed'. Only use review status for tasks that need Greg's explicit sign-off (e.g. merging to main, production deploys).

**Why:** Without skip_review=true, routine tasks pile up in the review queue and make the dashboard noisy. Orchestrator confirmed: max 3s/4s on autonomy matrix — routine tasks should never require human touch.

**How to apply:** When calling `mcp__rgos__cortex_complete_task`, default to `skip_review: true` unless the work specifically requires Greg's approval.

---

## Dual-complete: local + RGOS

**What:** When a task is tracked in both the local filesystem (task_XXXXX_YYY format) AND in RGOS Cortex (UUID format), run both completions in the same response:
1. `cortextos bus complete-task <local_id> --result "<summary>"`
2. `mcp__rgos__cortex_complete_task` with task_id (UUID), result, skip_review=true

**Why:** Local and RGOS systems don't sync automatically. Leaving one incomplete causes dashboard drift — task shows completed locally but still in_progress in RGOS (or vice versa).

**How to apply:** Check whether the task originated from `mcp__rgos__cortex_create_task` (UUID) or `cortextos bus create-task` (task_XXXXX format). UUID tasks need both; local-only tasks need only the bus command.

---

## RGOS-only tasks (from cortex_list_tasks / cortex_claim_task)

**What:** Tasks claimed via `mcp__rgos__cortex_claim_task` are RGOS-only (no local file). Complete them only via `mcp__rgos__cortex_complete_task`.

**How to apply:** After claiming and working a cortex task, call `mcp__rgos__cortex_complete_task` with `skip_review: true` (unless it's a task needing Greg's review), then log the event with `cortextos bus log-event`.
