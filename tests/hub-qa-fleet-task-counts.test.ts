import { describe, expect, it } from 'vitest';
import {
  dedupeFleetTaskCountRows,
  filterFleetLiveSourceRows,
  isFleetTasksMirrorSource,
  mapsToFleetPendingLane,
  mapsToFleetProposalQueue,
  type FleetTaskCountRow,
} from '../scripts/hub-qa-playwright';

describe('Hub QA Fleet Tasks CHECK 6 source counts', () => {
  const now = Date.parse('2026-06-13T13:10:00Z');

  it('keeps proposed mirror proposals out of the Pending expectation and dedupes twins', () => {
    const rows: FleetTaskCountRow[] = [
      {
        id: 'task_1781350000000_revenue',
        title: 'Revenue attribution & Salesforce integration focus',
        status: 'proposed',
        source: 'hub_ui',
        metadata: { bus_task_id: 'task_1781350000000_revenue' },
        created_at: '2026-06-13T12:48:55Z',
        updated_at: '2026-06-13T12:48:56Z',
      },
      {
        id: '3a0bcc8c-8683-443b-85a6-e405dacd6ec2',
        title: 'Revenue attribution & Salesforce integration focus',
        status: 'proposed',
        source: 'cortextos_bus_mirror',
        metadata: { bus_task_id: 'task_1781350000000_revenue' },
        created_at: '2026-06-13T12:48:55Z',
        updated_at: '2026-06-13T12:48:57Z',
      },
    ];

    const mirrorRows = dedupeFleetTaskCountRows(rows.filter(isFleetTasksMirrorSource));

    expect(mirrorRows).toHaveLength(1);
    expect(mirrorRows.filter((task) => mapsToFleetPendingLane(task, 'mirror', now))).toHaveLength(0);
    expect(mirrorRows.filter((task) => mapsToFleetProposalQueue(task, now))).toHaveLength(1);
  });

  it('still counts true live bus pending rows after removing Supabase mirror twins', () => {
    const rows: FleetTaskCountRow[] = [
      {
        id: 'task_live_pending',
        title: 'Live pending task',
        status: 'pending',
        updated_at: '2026-06-13T12:58:00Z',
      },
      {
        id: 'uuid-mirror',
        title: 'Live pending task',
        status: 'proposed',
        meta: { rgos: { source: 'supabase_orch_tasks' } },
        updated_at: '2026-06-13T12:58:00Z',
      },
    ];

    const liveRows = dedupeFleetTaskCountRows(filterFleetLiveSourceRows(rows));

    expect(liveRows).toHaveLength(1);
    expect(liveRows.filter((task) => mapsToFleetPendingLane(task, 'live', now))).toHaveLength(1);
  });

  it('ignores orch_tasks proposed rows for the mirror Pending-equivalent count', () => {
    const rows: FleetTaskCountRow[] = [
      {
        id: 'uuid-proposed-1',
        title: 'Proposed user idea',
        status: 'proposed',
        source: 'cortextos_bus_mirror',
        metadata: { bus_task_id: 'task_proposed_1' },
        created_at: '2026-06-13T12:48:55Z',
        updated_at: '2026-06-13T12:48:57Z',
      },
    ];

    const mirrorRows = dedupeFleetTaskCountRows(rows.filter(isFleetTasksMirrorSource));

    expect(mirrorRows).toHaveLength(1);
    // proposed stays out of Pending (preserves PR #835) and belongs to the proposal queue.
    expect(mirrorRows.filter((task) => mapsToFleetPendingLane(task, 'mirror', now))).toHaveLength(0);
    expect(mirrorRows.filter((task) => mapsToFleetProposalQueue(task, now))).toHaveLength(1);
  });

  it('counts orch_tasks approved rows as the mirror Pending-equivalent (core fix)', () => {
    const rows: FleetTaskCountRow[] = [
      {
        id: 'uuid-approved-1',
        title: 'Review and clean up open GitHub PRs',
        status: 'approved',
        source: 'cortextos_bus_mirror',
        metadata: { bus_task_id: 'task_approved_1' },
        created_at: '2026-06-13T12:50:00Z',
        updated_at: '2026-06-13T12:50:01Z',
      },
      {
        id: 'uuid-approved-2',
        title: 'AgentOps Warden: daily fleet digest',
        status: 'approved',
        source: null,
        metadata: { source: 'cortex', cortex_task_id: 'cortex_warden_1' },
        created_at: '2026-06-13T12:51:00Z',
        updated_at: '2026-06-13T12:51:01Z',
      },
    ];

    const mirrorRows = dedupeFleetTaskCountRows(rows.filter(isFleetTasksMirrorSource));

    expect(mirrorRows).toHaveLength(2);
    // Bus "pending" tasks mirror into orch_tasks as 'approved'; both must count as Pending-equivalent.
    expect(mirrorRows.filter((task) => mapsToFleetPendingLane(task, 'mirror', now))).toHaveLength(2);
    expect(mirrorRows.filter((task) => mapsToFleetProposalQueue(task, now))).toHaveLength(0);
  });

  it('leaves the authoritative LIVE sub-check unaffected when rendered == bus pending-mapped (delta=0, no reset)', () => {
    // LIVE source is the authoritative reset gate (rendered vs bus pending-mapped).
    // The mirror vocabulary remap must not change LIVE behavior: a live 'pending' bus
    // row still maps to the Pending lane, so a rendered count equal to it = delta 0 = no page-error.
    const busRows: FleetTaskCountRow[] = [
      {
        id: 'task_live_pending_1',
        title: 'Live pending task A',
        status: 'pending',
        updated_at: '2026-06-13T12:58:00Z',
      },
    ];

    const liveRows = dedupeFleetTaskCountRows(filterFleetLiveSourceRows(busRows));
    const liveExpected = liveRows.filter((task) => mapsToFleetPendingLane(task, 'live', now)).length;
    const renderedCount = 1; // page renders exactly the live pending-mapped count

    expect(liveExpected).toBe(1);
    const delta = Math.abs(renderedCount - liveExpected);
    expect(delta).toBe(0); // delta=0 => NO-RESET / not a page-error from the LIVE authoritative path

    // And an 'approved' row must NOT count toward the LIVE lane (mirror-only vocabulary).
    expect(mapsToFleetPendingLane({ id: 'x', status: 'approved', updated_at: '2026-06-13T12:58:00Z' }, 'live', now)).toBe(false);
  });
});
