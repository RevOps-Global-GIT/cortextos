import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createTask, updateTask, recoverStaleInProgressTasks } from '../../../src/bus/task';
import type { BusPaths } from '../../../src/types';
import { makeTempDir, removeTempDir, makeBusPaths } from '../../setup';

function backdateTask(paths: BusPaths, taskId: string, hoursAgo: number): void {
  const file = join(paths.taskDir, `${taskId}.json`);
  const task = JSON.parse(readFileSync(file, 'utf-8'));
  task.updated_at = new Date(Date.now() - hoursAgo * 3_600_000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');
  writeFileSync(file, JSON.stringify(task));
}

describe('recoverStaleInProgressTasks', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = makeTempDir('cortextos-stale-recovery-test-');
    paths = makeBusPaths(testDir, 'paul');
  });

  afterEach(() => {
    removeTempDir(testDir);
  });

  it('blocks an in_progress task untouched past the threshold, with blocker context', () => {
    const taskId = createTask(paths, 'paul', 'acme', 'Stale task', { skipBriefValidation: true });
    updateTask(paths, taskId, 'in_progress');
    backdateTask(paths, taskId, 30);

    const report = recoverStaleInProgressTasks(paths, { maxAgeHours: 24 });

    expect(report.recovered).toEqual([taskId]);
    expect(report.errors).toEqual([]);
    const task = JSON.parse(readFileSync(join(paths.taskDir, `${taskId}.json`), 'utf-8'));
    expect(task.status).toBe('blocked');
    expect(task.meta.blocker.blocker_reason).toContain('Auto-recovered');
    expect(task.meta.blocker.next_proof_required).toBeTruthy();
    expect(task.meta.auto_blocked_by).toBe('stale-task-recovery');
  });

  it('leaves fresh in_progress tasks and non-in_progress tasks alone', () => {
    const fresh = createTask(paths, 'paul', 'acme', 'Fresh task', { skipBriefValidation: true });
    updateTask(paths, fresh, 'in_progress');

    const pending = createTask(paths, 'paul', 'acme', 'Old pending task', { skipBriefValidation: true });
    backdateTask(paths, pending, 100);

    const report = recoverStaleInProgressTasks(paths, { maxAgeHours: 24 });

    expect(report.recovered).toEqual([]);
    expect(JSON.parse(readFileSync(join(paths.taskDir, `${fresh}.json`), 'utf-8')).status).toBe('in_progress');
    expect(JSON.parse(readFileSync(join(paths.taskDir, `${pending}.json`), 'utf-8')).status).toBe('pending');
  });

  it('returns an empty report when the task directory does not exist', () => {
    const ghostPaths: BusPaths = { ...paths, taskDir: join(testDir, 'does-not-exist') };
    const report = recoverStaleInProgressTasks(ghostPaths);
    expect(report).toEqual({ scanned: 0, recovered: [], errors: [] });
  });
});
