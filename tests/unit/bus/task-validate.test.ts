import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { BusPaths } from '../../../src/types';
import { makeTempDir, removeTempDir, makeBusPaths } from '../../setup';
import { validateTask } from '../../../src/bus/task-validate';
// Mock the Anthropic API — we only test prompt construction and auto-pass logic.;

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
  });

  it('auto-passes when task has no success_criteria', async () => {
    writeTask(paths, '001', { title: 'No criteria task', status: 'in_progress' });
    // ANTHROPIC_API_KEY must be set or it throws before auto-pass check
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
    const result = await validateTask(paths, '001');
    expect(result.verdict).toBe('pass');
    expect(result.score).toBe(7);
    expect(result.reasoning).toMatch(/auto-pass/i);
  });

  it('passes result override to buildPrompt — not stale on-disk value', async () => {
    // Task on disk has no result yet (pre-completeTask state)
    writeTask(paths, '002', {
      title: 'Ship fix',
      status: 'in_progress',
      success_criteria: 'PR merged to main',
      result: undefined,
    });
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');

    // Intercept the fetch to capture the prompt body
    let capturedPrompt = '';
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: '{"score":8,"verdict":"pass","reasoning":"criteria met"}' }],
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await validateTask(paths, '002', 'PR #42 merged to main');

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    capturedPrompt = callBody.messages[0].content as string;

    expect(capturedPrompt).toContain('PR #42 merged to main');
    expect(capturedPrompt).not.toContain('(no result provided)');
  });

  it('falls back to on-disk result when no override is given', async () => {
    writeTask(paths, '003', {
      title: 'Deploy app',
      status: 'completed',
      success_criteria: 'App live at production URL',
      result: 'Deployed to prod at 14:00 UTC',
    });
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');

    let capturedPrompt = '';
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: '{"score":9,"verdict":"pass","reasoning":"live"}' }],
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await validateTask(paths, '003');

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    capturedPrompt = callBody.messages[0].content as string;

    expect(capturedPrompt).toContain('Deployed to prod at 14:00 UTC');
    expect(capturedPrompt).not.toContain('(no result provided)');
  });

  it('shows (no result provided) when both override and on-disk result are absent', async () => {
    writeTask(paths, '004', {
      title: 'Fix bug',
      status: 'in_progress',
      success_criteria: 'Bug fixed and test passing',
    });
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');

    let capturedPrompt = '';
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: '{"score":3,"verdict":"fail","reasoning":"no evidence"}' }],
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await validateTask(paths, '004');

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    capturedPrompt = callBody.messages[0].content as string;

    expect(capturedPrompt).toContain('(no result provided)');
  });
});
