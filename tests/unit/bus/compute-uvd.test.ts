/**
 * Unit tests for the compute-uvd bus module.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

const { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } = await import('fs');
const { computeUvd, writeUvdResult } = await import('../../../src/bus/compute-uvd.js');

const mockExistsSync = vi.mocked(existsSync);
const mockReaddirSync = vi.mocked(readdirSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockMkdirSync = vi.mocked(mkdirSync);

beforeEach(() => {
  vi.resetAllMocks();
  mockExistsSync.mockReturnValue(false);
  mockReaddirSync.mockReturnValue([]);
});

const now = Date.now();
const recentIso = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(); // 2 days ago
const oldIso = new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString();   // 10 days ago

function makeTask(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    id: `task_${Date.now()}`,
    title: 'Ship feature X',
    status: 'completed',
    assigned_to: 'analyst',
    created_by: 'analyst',
    org: 'revops-global',
    priority: 'medium',
    completed_at: recentIso,
    result: 'Feature X shipped to production',
    ...overrides,
  });
}

describe('computeUvd', () => {
  it('returns zero UVDs when no task dirs exist', () => {
    mockExistsSync.mockReturnValue(false);
    const result = computeUvd('/fake/tasks');
    expect(result.uvd_count).toBe(0);
    expect(result.tasks_evaluated).toBe(0);
  });

  it('counts a valid completed agent task as UVD', () => {
    mockExistsSync.mockImplementation(p => typeof p === 'string' && (p === '/tasks' || p === '/tasks/archive'));
    mockReaddirSync.mockImplementation((p) => {
      if (String(p) === '/tasks') return ['task_001.json'] as unknown as ReturnType<typeof readdirSync>;
      return [] as unknown as ReturnType<typeof readdirSync>;
    });
    mockReadFileSync.mockReturnValue(makeTask());

    const result = computeUvd('/tasks');
    expect(result.uvd_count).toBe(1);
    expect(result.uvd_tasks[0].title).toBe('Ship feature X');
  });

  it('excludes tasks outside the rolling window', () => {
    mockExistsSync.mockImplementation(p => String(p) === '/tasks');
    mockReaddirSync.mockImplementation((p) => {
      if (String(p) === '/tasks') return ['task_old.json'] as unknown as ReturnType<typeof readdirSync>;
      return [] as unknown as ReturnType<typeof readdirSync>;
    });
    mockReadFileSync.mockReturnValue(makeTask({ completed_at: oldIso }));

    const result = computeUvd('/tasks', { days: 7 });
    expect(result.uvd_count).toBe(0);
    expect(result.excluded_outside_window).toBe(1);
  });

  it('excludes tasks created by humans (greg)', () => {
    mockExistsSync.mockImplementation(p => String(p) === '/tasks');
    mockReaddirSync.mockImplementation((p) => {
      if (String(p) === '/tasks') return ['task_001.json'] as unknown as ReturnType<typeof readdirSync>;
      return [] as unknown as ReturnType<typeof readdirSync>;
    });
    mockReadFileSync.mockReturnValue(makeTask({ created_by: 'greg' }));

    const result = computeUvd('/tasks');
    expect(result.uvd_count).toBe(0);
    expect(result.excluded_human_created).toBe(1);
  });

  it('excludes tasks with no result', () => {
    mockExistsSync.mockImplementation(p => String(p) === '/tasks');
    mockReaddirSync.mockImplementation((p) => {
      if (String(p) === '/tasks') return ['task_001.json'] as unknown as ReturnType<typeof readdirSync>;
      return [] as unknown as ReturnType<typeof readdirSync>;
    });
    mockReadFileSync.mockReturnValue(makeTask({ result: '' }));

    const result = computeUvd('/tasks');
    expect(result.uvd_count).toBe(0);
    expect(result.excluded_no_result).toBe(1);
  });

  it('excludes housekeeping tasks (heartbeat)', () => {
    mockExistsSync.mockImplementation(p => String(p) === '/tasks');
    mockReaddirSync.mockImplementation((p) => {
      if (String(p) === '/tasks') return ['task_001.json'] as unknown as ReturnType<typeof readdirSync>;
      return [] as unknown as ReturnType<typeof readdirSync>;
    });
    mockReadFileSync.mockReturnValue(makeTask({ title: 'Agent heartbeat check' }));

    const result = computeUvd('/tasks');
    expect(result.uvd_count).toBe(0);
    expect(result.excluded_housekeeping).toBe(1);
  });

  it('excludes housekeeping tasks (memory sync)', () => {
    mockExistsSync.mockImplementation(p => String(p) === '/tasks');
    mockReaddirSync.mockImplementation((p) => {
      if (String(p) === '/tasks') return ['task_001.json'] as unknown as ReturnType<typeof readdirSync>;
      return [] as unknown as ReturnType<typeof readdirSync>;
    });
    mockReadFileSync.mockReturnValue(makeTask({ title: 'memory sync to supabase' }));

    const result = computeUvd('/tasks');
    expect(result.uvd_count).toBe(0);
    expect(result.excluded_housekeeping).toBe(1);
  });

  it('includes archived tasks in the count', () => {
    mockExistsSync.mockImplementation(p => {
      const s = String(p);
      return s === '/tasks' || s === '/tasks/archive';
    });
    mockReaddirSync.mockImplementation((p) => {
      if (String(p) === '/tasks') return [] as unknown as ReturnType<typeof readdirSync>;
      if (String(p) === '/tasks/archive') return ['task_old_but_recent.json'] as unknown as ReturnType<typeof readdirSync>;
      return [] as unknown as ReturnType<typeof readdirSync>;
    });
    mockReadFileSync.mockReturnValue(makeTask({ title: 'Deploy pipeline fix' }));

    const result = computeUvd('/tasks');
    expect(result.uvd_count).toBe(1);
  });

  it('computes correct uvd_per_day', () => {
    mockExistsSync.mockImplementation(p => String(p) === '/tasks');
    mockReaddirSync.mockImplementation((p) => {
      if (String(p) === '/tasks') return ['task_1.json', 'task_2.json', 'task_3.json'] as unknown as ReturnType<typeof readdirSync>;
      return [] as unknown as ReturnType<typeof readdirSync>;
    });
    mockReadFileSync.mockReturnValue(makeTask());

    const result = computeUvd('/tasks', { days: 7 });
    // 3 tasks / 7 days = 0.43
    expect(result.uvd_per_day).toBeCloseTo(0.43, 1);
    expect(result.uvd_count).toBe(3);
  });

  it('skips non-completed tasks', () => {
    mockExistsSync.mockImplementation(p => String(p) === '/tasks');
    mockReaddirSync.mockImplementation((p) => {
      if (String(p) === '/tasks') return ['task_001.json'] as unknown as ReturnType<typeof readdirSync>;
      return [] as unknown as ReturnType<typeof readdirSync>;
    });
    mockReadFileSync.mockReturnValue(makeTask({ status: 'in_progress', completed_at: null }));

    const result = computeUvd('/tasks');
    expect(result.uvd_count).toBe(0);
    expect(result.tasks_evaluated).toBe(0);
  });
});

describe('writeUvdResult', () => {
  it('writes JSON to the correct path and returns it', () => {
    mockMkdirSync.mockReturnValue(undefined);
    mockWriteFileSync.mockReturnValue(undefined);

    const result = {
      date: '2026-05-16',
      window_days: 7,
      uvd_count: 5,
      uvd_per_day: 0.71,
      tasks_evaluated: 20,
      excluded_human_created: 0,
      excluded_no_result: 2,
      excluded_housekeeping: 8,
      excluded_outside_window: 5,
      uvd_tasks: [],
    };

    const outPath = writeUvdResult('/metrics', result);
    expect(outPath).toBe('/metrics/uvd-2026-05-16.json');
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      '/metrics/uvd-2026-05-16.json',
      expect.stringContaining('"uvd_count": 5'),
      'utf-8',
    );
  });
});
