import { describe, expect, it } from 'vitest';
import { dedupeFleetTaskCountRows, type FleetTaskCountRow } from '../scripts/hub-qa-playwright';

// Regression guard for the CHECK 6 false-FAIL fixed 2026-06-19. The Fleet Tasks
// pending-count dedup (fleetTaskCountIdentity) must collapse ONLY bus<->cortex
// twin pairs (a bus task + its RGOS mirror, linked by bus_task_id/cortex_task_id),
// NEVER two distinct bus ids. The previous logical fallback keyed on
// title|status|created_at[:19] (creation *second*), so burst-created rows like
// "Queued scheduled task" were wrongly merged — the kanban correctly rendered 18
// pending while the harness deduped to 15, producing a false CHECK 6 failure.
describe('Fleet Tasks dedup — twin-pair-only (CHECK 6 false-FAIL fix 2026-06-19)', () => {
  // BLOCK: distinct bus tasks sharing title + status + creation-second must NOT merge.
  it('does NOT merge two distinct bus ids sharing title + status + same created-second', () => {
    const rows: FleetTaskCountRow[] = [
      { id: 'task_1781882150057_2', title: 'Queued scheduled task', status: 'pending', created_at: '2026-06-19T16:09:10.057Z' },
      { id: 'task_1781882150668_5', title: 'Queued scheduled task', status: 'pending', created_at: '2026-06-19T16:09:10.668Z' },
    ];
    expect(dedupeFleetTaskCountRows(rows)).toHaveLength(2);
  });

  it('keeps a burst of 6 distinct "Queued scheduled task" rows as 6 (the live-repro)', () => {
    const rows: FleetTaskCountRow[] = [
      'task_1781881975033_3', 'task_1781882076300_8', 'task_1781882076906_7',
      'task_1781882150057_2', 'task_1781882150668_5', 'task_1781882151200_9',
    ].map((id, i) => ({ id, title: 'Queued scheduled task', status: 'pending', created_at: `2026-06-19T16:09:1${i}.000Z` }));
    expect(dedupeFleetTaskCountRows(rows)).toHaveLength(6);
  });

  // PASS: a properly-linked bus<->mirror twin pair MUST still collapse to one
  // (no double-count regression — this is the legitimate dedup we must preserve).
  it('DOES merge a bus<->mirror twin pair linked by bus_task_id', () => {
    const rows: FleetTaskCountRow[] = [
      { id: 'orch_mirror_row', title: 'Revenue review', status: 'approved', created_at: '2026-06-19T12:48:55Z', source: 'cortextos_bus_mirror', metadata: { bus_task_id: 'task_1781350000000_rev' } },
      { id: 'task_1781350000000_rev', title: 'Revenue review', status: 'pending', created_at: '2026-06-19T12:48:55Z', metadata: { bus_task_id: 'task_1781350000000_rev' } },
    ];
    expect(dedupeFleetTaskCountRows(rows)).toHaveLength(1);
  });

  it('DOES merge a twin pair linked by cortex_task_id (even with differing title/status/time)', () => {
    const rows: FleetTaskCountRow[] = [
      { id: 'a', title: 'Warden check', status: 'approved', created_at: '2026-06-19T12:51:00Z', metadata: { cortex_task_id: 'cortex_warden_1' } },
      { id: 'b', title: 'Warden recheck', status: 'in_progress', created_at: '2026-06-19T12:52:30Z', metadata: { cortex_task_id: 'cortex_warden_1' } },
    ];
    expect(dedupeFleetTaskCountRows(rows)).toHaveLength(1);
  });
});
