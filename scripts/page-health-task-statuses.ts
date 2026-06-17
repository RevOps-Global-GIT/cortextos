// Canonical allow-set for orch_tasks.status, used by the page-health hub-QA harness
// CHECK 5 ("Task status enum valid") on /app/fleet/tasks.
//
// This list is the single source of truth so the harness cannot silently regress:
// an inline copy of this set previously dropped `rejected` and `needs_person` during a
// refactor (2026-06-02 → 2026-06-17), producing a false CHECK 5 FAIL whenever a
// legitimate human-task ([HUMAN] …, status `needs_person`, assigned to a person) or a
// `rejected` task appeared in the most-recent rows. Pinning the set here + a unit test
// (tests/page-health-task-statuses.test.ts) prevents a third recurrence.
//
// `needs_person` and `rejected` are real, intentional orch_tasks statuses:
//   - needs_person — human-task workflow: task blocked on a human action (e.g. re-auth),
//     assigned_to a person. Created via the human-tasks flow.
//   - rejected     — a proposed/review task declined by the orchestrator/Greg.
export const VALID_TASK_STATUSES = new Set<string>([
  'pending',
  'in_progress',
  'review',
  'completed',
  'approved',
  'proposed',
  'cancelled',
  'failed',
  'blocked',
  'rejected',
  'needs_person',
]);

// Statuses that exist specifically because a task is parked on human action. These must
// always be present in VALID_TASK_STATUSES — the regression test asserts this explicitly.
export const HUMAN_TASK_STATUSES = ['needs_person'] as const;
