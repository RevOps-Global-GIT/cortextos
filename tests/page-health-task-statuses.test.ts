import { describe, it, expect } from 'vitest';
import { VALID_TASK_STATUSES, HUMAN_TASK_STATUSES } from '../scripts/page-health-task-statuses';

// Regression guard for page-health hub-QA CHECK 5 ("Task status enum valid") on
// /app/fleet/tasks. An inline copy of this allow-set previously dropped `needs_person`
// and `rejected` during a refactor (false-FAIL on 2026-06-02 and again 2026-06-17),
// flagging the surface non-green whenever a legitimate human task or a rejected task
// appeared. These tests pin the legitimate statuses so the gap cannot return.
describe('page-health task status enum (CHECK 5)', () => {
  // ---- The regression that bit us twice: human-task + rejected statuses ----
  describe('legitimate statuses the harness must accept', () => {
    it('accepts needs_person (human-task workflow status)', () => {
      expect(VALID_TASK_STATUSES.has('needs_person')).toBe(true);
    });

    it('accepts rejected (declined proposal/review status)', () => {
      expect(VALID_TASK_STATUSES.has('rejected')).toBe(true);
    });

    it('accepts every declared HUMAN_TASK_STATUS', () => {
      for (const s of HUMAN_TASK_STATUSES) {
        expect(VALID_TASK_STATUSES.has(s)).toBe(true);
      }
    });

    it.each([
      'pending', 'in_progress', 'review', 'completed', 'approved',
      'proposed', 'cancelled', 'failed', 'blocked', 'rejected', 'needs_person',
    ])('accepts the live orch_tasks status %s', (status) => {
      expect(VALID_TASK_STATUSES.has(status)).toBe(true);
    });
  });

  // ---- Negative direction: genuinely invalid statuses must still be flagged ----
  describe('still rejects genuinely invalid statuses (correctness preserved)', () => {
    it.each(['', 'not_a_status', 'done', 'open', 'in-progress', 'pending '])(
      'rejects %p',
      (status) => {
        expect(VALID_TASK_STATUSES.has(status)).toBe(false);
      },
    );

    it('flags a null/empty status the way the harness filter does', () => {
      const rows: Array<{ id: string; status: string | null }> = [
        { id: 'a', status: 'needs_person' },
        { id: 'b', status: 'rejected' },
        { id: 'c', status: null },
        { id: 'd', status: 'bogus' },
      ];
      const invalid = rows.filter((r) => !r.status || !VALID_TASK_STATUSES.has(r.status));
      expect(invalid.map((r) => r.id)).toEqual(['c', 'd']);
    });
  });
});
