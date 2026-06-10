/**
 * Unit tests for scripts/theta-restamp-on-exit.js
 * Tests the running-row restamp logic with a mocked fetch — no Supabase calls.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { parseArgs, buildRestampSummary, restampRunningRows } =
  require('../../../scripts/theta-restamp-on-exit.js');

const BASE = { url: 'https://example.supabase.co', key: 'svc-key', worker: 'cron:analyst:theta-wave', exitCode: 1 };

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe('parseArgs', () => {
  it('parses worker and exit code', () => {
    expect(parseArgs(['--worker', 'cron:analyst:theta-wave', '--exit-code', '137'])).toEqual({
      worker: 'cron:analyst:theta-wave',
      exitCode: 137,
    });
  });

  it('defaults when args missing or malformed', () => {
    expect(parseArgs([])).toEqual({ worker: 'unknown', exitCode: null });
    expect(parseArgs(['--exit-code', 'oops'])).toEqual({ worker: 'unknown', exitCode: null });
  });
});

describe('buildRestampSummary', () => {
  it('is a truthful error summary with worker + exit code', () => {
    const s = buildRestampSummary('cron:analyst:theta-wave', 1, '2026-06-10T08:00:00.000Z');
    expect(s).toMatch(/^error: /);
    expect(s).toContain('cron:analyst:theta-wave');
    expect(s).toContain('code 1');
    expect(s).toContain('auto-restamped');
  });

  it('handles unknown exit code', () => {
    expect(buildRestampSummary('w', null, '2026-06-10T08:00:00.000Z')).toContain('code unknown');
  });
});

describe('restampRunningRows', () => {
  it('does nothing when no rows are running', async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string) => {
      calls.push(url);
      return jsonResponse([]);
    };
    const result = await restampRunningRows({ ...BASE, fetchImpl });
    expect(result.restamped).toEqual([]);
    expect(result.skipped).toBe('no rows in status=running');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('status=eq.running');
  });

  it('patches a running row to error, guarded by status=eq.running', async () => {
    const patches: Array<{ url: string; body: any }> = [];
    const fetchImpl = async (url: string, init?: any) => {
      if (!init || !init.method) {
        return jsonResponse([{ id: 'row-1', session_id: 'theta-2026-06-10', ran_at: '2026-06-10T05:00:00Z' }]);
      }
      patches.push({ url, body: JSON.parse(init.body) });
      return jsonResponse([{ id: 'row-1' }]);
    };
    const result = await restampRunningRows({ ...BASE, fetchImpl });
    expect(result.restamped).toEqual(['theta-2026-06-10']);
    expect(patches).toHaveLength(1);
    expect(patches[0].url).toContain('id=eq.row-1');
    expect(patches[0].url).toContain('status=eq.running');
    expect(patches[0].body.status).toBe('error');
    expect(patches[0].body.synthesis_summary).toContain('auto-restamped');
  });

  it('reports nothing restamped when the PATCH races a terminal write (0 rows matched)', async () => {
    const fetchImpl = async (url: string, init?: any) => {
      if (!init || !init.method) {
        return jsonResponse([{ id: 'row-1', session_id: 'theta-2026-06-10', ran_at: '2026-06-10T05:00:00Z' }]);
      }
      return jsonResponse([]); // PATCH matched 0 rows — worker's own write landed first
    };
    const result = await restampRunningRows({ ...BASE, fetchImpl });
    expect(result.restamped).toEqual([]);
  });

  it('throws on a failed list request', async () => {
    const fetchImpl = async () => jsonResponse({ message: 'denied' }, false, 401);
    await expect(restampRunningRows({ ...BASE, fetchImpl })).rejects.toThrow(/list running rows failed: 401/);
  });
});
