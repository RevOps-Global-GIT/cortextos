// Canonical allow-set for orch_tasks.status, used by the page-health hub-QA harness
// CHECK 5 ("Task status enum valid") on /app/fleet/tasks.
//
// Single source of truth so the harness can't silently regress. CHECK 5's entire
// failure history is FALSE POSITIVES caused by a too-NARROW inline copy of this set
// (it dropped `rejected` + `needs_person` during a refactor, 2026-06-02 and again
// 2026-06-17, flagging the surface non-green whenever a legitimate human task or a
// rejected task appeared in the most-recent rows).
//
// The real authority for orch_tasks.status is the RGOS Postgres CHECK constraint
// `orch_tasks_status_check` (12 values as of 2026-06-19). This set is a SUPERSET of
// that constraint: it MUST contain every DB-valid status (so a too-narrow regression
// can't return), plus it tolerates a couple of harmless bus-local mirror values
// (`pending`, `failed`) that the DB CHECK actually forbids from ever appearing as
// orch_tasks rows. The companion test (tests/page-health-task-statuses.test.ts)
// asserts the superset relationship against the live constraint so any future status
// added to the DB auto-flags if this set falls out of sync.
export const VALID_TASK_STATUSES = new Set<string>([
  // --- the 12 statuses allowed by orch_tasks_status_check (DB source of truth) ---
  'proposed',
  'awaiting_approval',
  'approved',
  'in_progress',
  'review',
  'completed',
  'rejected',
  'cancelled',
  'blocked',
  'needs_person',
  'waiting_approval',
  'scheduled',
  // --- lenient bus-local mirror values (forbidden by the DB CHECK, harmless extras) ---
  'pending',
  'failed',
]);

// Statuses that exist specifically because a task is parked on human action. CHECK 5's
// regression dropped this one twice; the test pins it explicitly.
export const HUMAN_TASK_STATUSES = ['needs_person'] as const;
