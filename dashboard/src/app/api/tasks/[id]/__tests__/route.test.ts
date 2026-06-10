/**
 * Regression test for PATCH /api/tasks/[id] status vocabulary.
 *
 * VALID_STATUSES must mirror the bus TaskStatus enum. 'cancelled' is a valid
 * bus status but was missing, so reverse-sync callers (rgos hub→bus mirror)
 * got 400s when cancelling tasks.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('child_process', () => ({
  spawnSync: vi.fn(),
}));

vi.mock('fs', () => ({
  default: { existsSync: vi.fn(() => false) },
}));

vi.mock('@/lib/config', () => ({
  getFrameworkRoot: vi.fn(() => '/srv/cortextos'),
  getCTXRoot: vi.fn(() => '/srv/ctx-root'),
  CTX_INSTANCE_ID: 'test-instance',
  CTX_ROOT_REAL: '/srv/ctx-root',
}));

vi.mock('@/lib/sync', () => ({
  syncAll: vi.fn(),
}));

vi.mock('@/lib/data/tasks', () => ({
  getTaskById: vi.fn(() => ({ id: 'task_1', title: 't', org: 'revops-global' })),
}));

import { spawnSync } from 'child_process';
import { PATCH } from '../route';

function patchRequest(status: string) {
  const req = new NextRequest('http://localhost/api/tasks/task_1', {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
  return PATCH(req, { params: Promise.resolve({ id: 'task_1' }) });
}

describe('PATCH /api/tasks/[id] — status vocabulary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: 'ok',
      stderr: '',
    } as unknown as ReturnType<typeof spawnSync>);
  });

  it.each(['pending', 'in_progress', 'blocked', 'completed', 'cancelled'])(
    'accepts bus status %s',
    async (status) => {
      const res = await patchRequest(status);
      expect(res.status).toBe(200);
      expect(spawnSync).toHaveBeenCalledTimes(1);
    },
  );

  it('routes cancelled through update-task.sh, not complete-task.sh', async () => {
    await patchRequest('cancelled');
    const [, scriptArgs] = vi.mocked(spawnSync).mock.calls[0];
    expect(String(scriptArgs![0])).toContain('update-task.sh');
    expect(scriptArgs).toContain('cancelled');
  });

  it('still 400s on statuses outside the bus enum', async () => {
    for (const bad of ['scheduled', 'review', 'archived']) {
      const res = await patchRequest(bad);
      expect(res.status).toBe(400);
    }
    expect(spawnSync).not.toHaveBeenCalled();
  });
});
