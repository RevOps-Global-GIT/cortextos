import { describe, expect, it } from 'vitest';
import {
  classifyCheck6PendingStatus,
  dedupeFleetTaskCountRows,
  filterFleetLiveSourceRows,
  isFleetTasksMirrorSource,
  mapsToFleetPendingLane,
  mapsToFleetProposalQueue,
  type Check6PendingClassifierInput,
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

describe('Hub QA Fleet Tasks CHECK 6 mirror-only severity classification', () => {
  const baseInput: Check6PendingClassifierInput = {
    failures: [],
    mirrorOnlyWarnings: [],
    liveConfirmedCorrect: false,
    deferred: [],
    evidence: [],
    tolerance: 1,
  };

  it('demotes a MIRROR-only delta to a warning (DEFERRED, not a page ERROR) when LIVE delta=0', () => {
    // LIVE rendered == bus pending-mapped (delta=0) => liveConfirmedCorrect=true, no live failure.
    // MIRROR (orch_tasks approved) drifted beyond tolerance. orch_tasks is a lagging mirror, so
    // this is NOT a page-correctness error and MUST NOT flip the page row to 'error'/reset.
    const result = classifyCheck6PendingStatus({
      ...baseInput,
      liveConfirmedCorrect: true,
      mirrorOnlyWarnings: ['mirror rendered=7 vs orch_tasks pending-equivalent(approved)=4'],
      evidence: [
        'mirror: rendered=7, orch_tasks pending-equivalent(approved)=4, proposed=0 ignored for Pending, delta=3, source rows 4->4',
        'live: rendered=7, bus pending-mapped=7, delta=0, source rows 12->7',
      ],
    });

    // DEFERRED => collectPageHealthIssues emits severity 'warning', not 'error' (no flip-clock/reset).
    expect(result.status).toBe('DEFERRED');
    expect(result.status).not.toBe('FAIL');
    expect(result.evidence).toContain('MIRROR-ONLY drift');
    expect(result.evidence).toContain('LIVE authoritative check passed');
  });

  it('keeps CHECK 6 an ERROR (FAIL) when the authoritative LIVE delta exceeds tolerance', () => {
    // Genuine board/source divergence on the authoritative LIVE sub-check => page ERROR preserved.
    const result = classifyCheck6PendingStatus({
      ...baseInput,
      liveConfirmedCorrect: false,
      failures: ['live rendered=2 vs bus pending-mapped=9'],
      evidence: ['live: rendered=2, bus pending-mapped=9, delta=7, source rows 14->9'],
    });

    // FAIL => collectPageHealthIssues emits kind 'check_failure', severity 'error' (reset gate).
    expect(result.status).toBe('FAIL');
    expect(result.evidence).toContain('live rendered=2 vs bus pending-mapped=9');
  });

  it('promotes a MIRROR-only delta back to an ERROR when LIVE did not confirm correctness (safety net)', () => {
    // If the LIVE sub-check never ran (e.g. bus query failed) we cannot trust the live board, so a
    // mirror delta must still surface as a failure — the demotion is gated on LIVE confirming.
    const result = classifyCheck6PendingStatus({
      ...baseInput,
      liveConfirmedCorrect: false,
      mirrorOnlyWarnings: ['mirror rendered=7 vs orch_tasks pending-equivalent(approved)=4'],
      deferred: ['live bus list-tasks failed: ENOENT'],
    });

    expect(result.status).toBe('FAIL');
  });
});

describe('Hub QA Fleet Tasks CHECK 6 #847 vocabulary preserved', () => {
  const now = Date.parse('2026-06-13T13:10:00Z');

  it('preserves #847: approved counts as Pending-equivalent, proposed ignored', () => {
    const approved: FleetTaskCountRow = {
      id: 'uuid-approved',
      title: 'Approved bus-mirrored task',
      status: 'approved',
      source: 'cortextos_bus_mirror',
      metadata: { bus_task_id: 'task_approved' },
      updated_at: '2026-06-13T12:50:01Z',
    };
    const proposed: FleetTaskCountRow = {
      id: 'uuid-proposed',
      title: 'Proposed user idea',
      status: 'proposed',
      source: 'cortextos_bus_mirror',
      metadata: { bus_task_id: 'task_proposed' },
      updated_at: '2026-06-13T12:48:57Z',
    };

    // approved => Pending-equivalent (counted); proposed => excluded from Pending (proposal queue).
    expect(mapsToFleetPendingLane(approved, 'mirror', now)).toBe(true);
    expect(mapsToFleetPendingLane(proposed, 'mirror', now)).toBe(false);
    expect(mapsToFleetProposalQueue(proposed, now)).toBe(true);
  });
});
