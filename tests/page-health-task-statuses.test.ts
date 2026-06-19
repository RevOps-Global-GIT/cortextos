import { describe, it, expect } from 'vitest';
import { VALID_TASK_STATUSES, HUMAN_TASK_STATUSES } from '../scripts/page-health-task-statuses';

// Regression guard for the page-health hub-QA CHECK 5 ("Task status enum valid") on
// /app/fleet/tasks. The allow-set in page-health-task-statuses.ts must stay a SUPERSET
// of the live orch_tasks.status DB CHECK constraint (the true source of truth), so a
// too-narrow copy — CHECK 5's repeated false-positive failure mode (dropped needs_person
// + rejected on 2026-06-02 and 2026-06-17) — cannot silently return.

describe('page-health task status allow-set (CHECK 5)', () => {
  // ---- Offline guards (always run): the exact statuses the regression dropped ----
  describe('legitimate statuses the harness must always accept', () => {
    it('accepts needs_person (human-task workflow status)', () => {
      expect(VALID_TASK_STATUSES.has('needs_person')).toBe(true);
    });
    it('accepts rejected (declined proposal/review status)', () => {
      expect(VALID_TASK_STATUSES.has('rejected')).toBe(true);
    });
    it('accepts every declared HUMAN_TASK_STATUS', () => {
      for (const s of HUMAN_TASK_STATUSES) expect(VALID_TASK_STATUSES.has(s)).toBe(true);
    });
  });

  describe('still flags genuinely invalid statuses (correctness preserved)', () => {
    it.each(['', 'not_a_status', 'done', 'open', 'in-progress', 'pending '])('rejects %p', (s) => {
      expect(VALID_TASK_STATUSES.has(s)).toBe(false);
    });
    it('mirrors the harness filter (flags null + bogus, keeps valid)', () => {
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

  // ---- Integration guard (derives from the live DB constraint; skips without a key) ----
  // The authority for orch_tasks.status is the Postgres CHECK constraint
  // `orch_tasks_status_check`. We parse its allowed values and assert the allow-set is a
  // SUPERSET, so any status added to the DB enum auto-flags if this set falls out of sync.
  // Skips gracefully when SUPABASE_MANAGEMENT_KEY is absent (e.g. offline CI) — never fails CI.
  const MK = process.env.SUPABASE_MANAGEMENT_KEY;
  const REF = process.env.SUPABASE_PROJECT_REF || 'yyizocyaehmqrottmnaz';
  const runIntegration = MK ? it : it.skip;

  runIntegration(
    'is a superset of the live orch_tasks_status_check DB constraint',
    async () => {
      const sql =
        "select pg_get_constraintdef(con.oid) as def from pg_constraint con " +
        "join pg_class c on c.oid = con.conrelid " +
        "where c.relname = 'orch_tasks' and con.conname = 'orch_tasks_status_check'";
      const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${MK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: sql }),
      });
      expect(res.ok).toBe(true);
      const rows = (await res.json()) as Array<{ def: string }>;
      expect(Array.isArray(rows) && rows.length).toBeTruthy();
      const def = rows[0].def;
      // Extract the quoted values from: CHECK ((status = ANY (ARRAY['a'::text, 'b'::text, ...])))
      const dbStatuses = [...def.matchAll(/'([^']+)'::text/g)].map((m) => m[1]);
      expect(dbStatuses.length).toBeGreaterThan(0);
      const missing = dbStatuses.filter((s) => !VALID_TASK_STATUSES.has(s));
      expect(
        missing,
        `Allow-set is missing DB-valid status(es): ${missing.join(', ')}. ` +
          `Update scripts/page-health-task-statuses.ts to include every orch_tasks_status_check value.`,
      ).toEqual([]);
    },
    20000,
  );
});
