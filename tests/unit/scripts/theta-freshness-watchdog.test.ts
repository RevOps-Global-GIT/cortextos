import { describe, expect, it } from 'vitest';
import {
  evaluateThetaFreshness,
  expectedFireAtForSession,
  expectedThetaSessionId,
} from '../../../scripts/theta-freshness-watchdog.js';

describe('theta-freshness-watchdog', () => {
  it('uses the current UTC date as the expected theta session id', () => {
    expect(expectedThetaSessionId(new Date('2026-05-26T11:40:00.000Z'))).toBe('theta-2026-05-26');
    expect(expectedFireAtForSession('theta-2026-05-26').toISOString()).toBe('2026-05-26T05:00:00.000Z');
  });

  it('reports fresh when the expected session has terminal complete status', () => {
    const result = evaluateThetaFreshness({
      now: new Date('2026-05-26T06:45:00.000Z'),
      expectedSessionId: 'theta-2026-05-26',
      expectedFireAt: new Date('2026-05-26T05:00:00.000Z'),
      graceMinutes: 90,
      latestCronFireAt: new Date('2026-05-26T05:00:14.000Z'),
      latestThetaRow: {
        session_id: 'theta-2026-05-26',
        ran_at: '2026-05-26T05:10:00+00:00',
        status: 'complete',
      },
    });

    expect(result.status).toBe('fresh');
    expect(result.reason).toContain('terminal status complete');
  });

  it('reports pending while the expected session is in progress', () => {
    const result = evaluateThetaFreshness({
      now: new Date('2026-05-26T05:30:00.000Z'),
      expectedSessionId: 'theta-2026-05-26',
      expectedFireAt: new Date('2026-05-26T05:00:00.000Z'),
      graceMinutes: 90,
      latestThetaRow: {
        session_id: 'theta-2026-05-26',
        ran_at: '2026-05-26T05:01:00+00:00',
        status: 'in_progress',
      },
    });

    expect(result.status).toBe('pending');
    expect(result.reason).toContain('status is in_progress');
  });

  it('reports pending inside the grace window before a row appears', () => {
    const result = evaluateThetaFreshness({
      now: new Date('2026-05-26T05:45:00.000Z'),
      expectedSessionId: 'theta-2026-05-26',
      expectedFireAt: new Date('2026-05-26T05:00:00.000Z'),
      graceMinutes: 90,
      latestThetaRow: {
        session_id: 'theta-2026-05-25',
        ran_at: '2026-05-25T05:00:00+00:00',
        status: 'complete',
      },
    });

    expect(result.status).toBe('pending');
    expect(result.reason).toContain('grace window');
  });

  it('reports stale after the grace window when latest row is older', () => {
    const result = evaluateThetaFreshness({
      now: new Date('2026-05-26T07:00:00.000Z'),
      expectedSessionId: 'theta-2026-05-26',
      expectedFireAt: new Date('2026-05-26T05:00:00.000Z'),
      graceMinutes: 90,
      latestCronFireAt: new Date('2026-05-26T05:00:14.000Z'),
      latestThetaRow: {
        session_id: 'theta-2026-05-24',
        ran_at: '2026-05-24T05:01:00+00:00',
        status: 'complete',
      },
    });

    expect(result.status).toBe('stale');
    expect(result.reason).toContain('latest theta_sessions row is theta-2026-05-24');
    expect(result.latest_cron_fire_at).toBe('2026-05-26T05:00:14.000Z');
  });
});
