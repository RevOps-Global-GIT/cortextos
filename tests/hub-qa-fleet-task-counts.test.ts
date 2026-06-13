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
});
