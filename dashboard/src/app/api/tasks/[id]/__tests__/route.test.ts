/**
 * Regression test for PATCH /api/tasks/[id] status vocabulary.
 *
 * The dashboard accepts the local bus status vocabulary plus RGOS-native
 * proposed/approved statuses surfaced by Fleet.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('child_process', () => ({
  spawnSync: vi.fn(),
}));

vi.mock('fs', () => ({
  default: { existsSync: vi.fn(() => false) },
}));

vi.mock('fs/promises', () => ({
  default: {
    readFile: vi.fn(() => JSON.stringify({
      id: 'task_1',
      title: 't',
      status: 'proposed',
      org: 'revops-global',
    })),
    writeFile: vi.fn(),
    rename: vi.fn(),
  },
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

vi.mock('@/lib/db', () => ({
  db: {
    prepare: vi.fn(() => ({
      run: vi.fn(),
    })),
  },
}));

vi.mock('@/lib/data/tasks', () => ({
  getTaskById: vi.fn(() => ({
    id: 'task_1',
    title: 't',
    org: 'revops-global',
    status: 'pending',
    source_file: '/srv/ctx-root/orgs/revops-global/tasks/task_1.json',
  })),
}));

import { spawnSync } from 'child_process';
import fsPromises from 'fs/promises';
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
    'accepts bus status %s through bus scripts',
    async (status) => {
      const res = await patchRequest(status);
      expect(res.status).toBe(200);
      expect(spawnSync).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['proposed', 'approved'])(
    'accepts RGOS dashboard status %s by updating the task JSON directly',
    async (status) => {
      const res = await patchRequest(status);
      expect(res.status).toBe(200);
      expect(spawnSync).not.toHaveBeenCalled();
      expect(fsPromises.writeFile).toHaveBeenCalledTimes(1);
      const [, written] = vi.mocked(fsPromises.writeFile).mock.calls[0];
      expect(JSON.parse(String(written)).status).toBe(status);
    },
  );

  it('accepts proposed to approved lifecycle transition', async () => {
    vi.mocked(fsPromises.readFile).mockResolvedValueOnce(JSON.stringify({
      id: 'task_1',
      title: 't',
      status: 'proposed',
      org: 'revops-global',
    }));

    const res = await patchRequest('approved');

    expect(res.status).toBe(200);
    const [, written] = vi.mocked(fsPromises.writeFile).mock.calls[0];
    expect(JSON.parse(String(written)).status).toBe('approved');
  });

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
