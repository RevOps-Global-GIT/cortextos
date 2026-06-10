/**
 * Regression test for POST /api/tasks brief-contract bypass.
 *
 * Since CLI PR #363 `bus create-task` enforces an 8-field brief contract,
 * which UI-originated creates cannot satisfy — every dashboard POST exited
 * non-zero and surfaced as a 500. The route must pass
 * --skip-brief-validation to the CLI.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('@/lib/config', () => ({
  getFrameworkRoot: vi.fn(() => '/srv/cortextos'),
  getCTXRoot: vi.fn(() => '/srv/ctx-root'),
  getOrgs: vi.fn(() => ['revops-global']),
  CTX_INSTANCE_ID: 'test-instance',
  CTX_ROOT_REAL: '/srv/ctx-root',
}));

vi.mock('@/lib/sync', () => ({
  syncAll: vi.fn(),
}));

vi.mock('@/lib/data/tasks', () => ({
  getTasks: vi.fn(() => []),
}));

import { execFileSync } from 'child_process';
import { POST } from '../route';

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/tasks', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

describe('POST /api/tasks — CLI brief-contract bypass', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(execFileSync).mockReturnValue('task_123\n');
  });

  it('passes --skip-brief-validation to the create-task CLI call', async () => {
    const res = await POST(makeRequest({ title: 'qa probe' }));

    expect(res.status).toBe(201);
    expect(execFileSync).toHaveBeenCalledTimes(1);
    const [, argv] = vi.mocked(execFileSync).mock.calls[0];
    expect(argv).toContain('--skip-brief-validation');
    expect(argv).toContain('create-task');
    expect(argv).toContain('qa probe');
  });

  it('keeps the flag when optional fields are present', async () => {
    const res = await POST(
      makeRequest({ title: 'qa probe', priority: 'normal', description: 'd' }),
    );

    expect(res.status).toBe(201);
    const [, argv] = vi.mocked(execFileSync).mock.calls[0];
    expect(argv).toContain('--skip-brief-validation');
    expect(argv).toContain('--priority');
    expect(argv).toContain('normal');
  });

  it('still 400s on invalid priority before reaching the CLI', async () => {
    const res = await POST(makeRequest({ title: 'x', priority: 'critical' }));

    expect(res.status).toBe(400);
    expect(execFileSync).not.toHaveBeenCalled();
  });
});
