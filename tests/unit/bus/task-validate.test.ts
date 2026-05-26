import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { BusPaths } from '../../../src/types';
import { makeTempDir, removeTempDir, makeBusPaths } from '../../setup';
import { validateTask } from '../../../src/bus/task-validate';

function writeTask(paths: BusPaths, taskId: string, task: object) {
  mkdirSync(paths.taskDir, { recursive: true });
  writeFileSync(join(paths.taskDir, `${taskId}.json`), JSON.stringify(task));
}

describe('validateTask', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = makeTempDir('cortextos-task-validate-test-');
    paths = makeBusPaths(testDir, 'dev');
  });

  afterEach(() => {
    removeTempDir(testDir);
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('auto-passes when task has no success_criteria', async () => {
    writeTask(paths, '001', { title: 'No criteria task', status: 'in_progress' });
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
    const result = await validateTask(paths, '001');
    expect(result.verdict).toBe('pass');
    expect(result.score).toBe(7);
    expect(result.reasoning).toMatch(/auto-pass/i);
  });

  it('uses the result override instead of the stale on-disk value', async () => {
    writeTask(paths, '002', {
      title: 'Ship fix',
      status: 'in_progress',
      success_criteria: 'PR merged to main',
      result: undefined,
    });
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const result = await validateTask(paths, '002', 'PR #42 merged to main with tests green');
    expect(result.verdict).toBe('pass');
    expect(result.score).toBeGreaterThanOrEqual(7);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('falls back to on-disk result when no override is given', async () => {
    writeTask(paths, '003', {
      title: 'Deploy app',
      status: 'completed',
      success_criteria: 'App live at production URL',
      result: 'Deployed to prod at 14:00 UTC',
    });
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const result = await validateTask(paths, '003');
    expect(result.verdict).toBe('pass');
    expect(result.reasoning).toMatch(/proof|deliverable/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fails locally when both override and on-disk result are absent', async () => {
    writeTask(paths, '004', {
      title: 'Fix bug',
      status: 'in_progress',
      success_criteria: 'Bug fixed and test passing',
    });
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const result = await validateTask(paths, '004');
    expect(result.verdict).toBe('fail');
    expect(result.score).toBe(4);
    expect(result.reasoning).toMatch(/empty/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('passes exact blocker completions without provider calls', async () => {
    writeTask(paths, '005', {
      title: 'Diagnose provider lane',
      status: 'in_progress',
      success_criteria: 'Patch or exact blocker with owner next action',
    });
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const result = await validateTask(paths, '005', 'BLOCKED: exact blocker is provider approval; owner next action is approval for export.');
    expect(result.verdict).toBe('pass');
    expect(result.score).toBeGreaterThanOrEqual(7);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('marks vague completions as needs revision', async () => {
    writeTask(paths, '006', {
      title: 'Ship patch',
      status: 'in_progress',
      success_criteria: 'Patch with proof',
    });

    const result = await validateTask(paths, '006', 'done');
    expect(result.verdict).toBe('needs-revision');
    expect(result.score).toBe(5);
  });
});
