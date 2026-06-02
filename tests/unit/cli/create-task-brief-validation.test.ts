/**
 * P2 enforcement: `bus create-task` must reject creation when any of the 8
 * brief contract fields is missing or empty.
 *
 * The 8 required fields are:
 *   1. --success-criteria       -- machine-checkable completion condition
 *   2. --out-of-scope           -- what the task explicitly will NOT do
 *   3. --escalation-triggers    -- conditions that should escalate to a human
 *   4. --source-hierarchy       -- who assigned this task
 *   5. --required-capabilities  -- tools/access/permissions needed
 *   6. --fallback-proof         -- how to verify if primary artifact unavailable
 *   7. --artifact-expectations  -- what output/file/PR/result is expected
 *   8. --goal-ancestry          -- which org goal this task traces back to
 *
 * A hidden --skip-brief-validation flag allows existing bus scripts and tests
 * that were written before this enforcement to bypass the check.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readdirSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';

vi.mock('../../../src/daemon/ipc-server.js', () => {
  class MockIPCClient {
    send = vi.fn().mockResolvedValue({ success: true });
    isDaemonRunning = vi.fn().mockResolvedValue(false);
  }
  return { IPCClient: MockIPCClient };
});

let tmpRoot: string;
let frameworkRoot: string;
const savedEnv: Record<string, string | undefined> = {};
const envKeys = [
  'CTX_ROOT', 'CTX_FRAMEWORK_ROOT', 'CTX_AGENT_NAME',
  'CTX_INSTANCE_ID', 'CTX_AGENT_DIR', 'CTX_PROJECT_ROOT', 'CTX_ORG',
];
const TEST_AGENT = 'test-agent';
const TEST_ORG = 'acme';
const createdTaskIds: string[] = [];

function taskDir(): string {
  const root = tmpRoot || process.env.CTX_ROOT || join(homedir(), '.cortextos', 'default');
  return join(root, 'orgs', TEST_ORG, 'tasks');
}

beforeEach(() => {
  for (const k of envKeys) savedEnv[k] = process.env[k];
  tmpRoot = mkdtempSync(join(tmpdir(), 'brief-val-test-'));
  frameworkRoot = mkdtempSync(join(tmpdir(), 'brief-val-fw-'));
  mkdirSync(join(frameworkRoot, 'orgs', TEST_ORG, 'agents', TEST_AGENT), { recursive: true });
  process.env.CTX_ROOT = tmpRoot;
  process.env.CTX_FRAMEWORK_ROOT = frameworkRoot;
  process.env.CTX_AGENT_NAME = TEST_AGENT;
  process.env.CTX_INSTANCE_ID = 'default';
  process.env.CTX_AGENT_DIR = join(frameworkRoot, 'orgs', TEST_ORG, 'agents', TEST_AGENT);
  process.env.CTX_PROJECT_ROOT = frameworkRoot;
  process.env.CTX_ORG = TEST_ORG;
});

afterEach(() => {
  for (const k of envKeys) {
    if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k];
    else delete process.env[k];
  }
  for (const id of createdTaskIds) {
    try { if (existsSync(join(taskDir(), `${id}.json`))) unlinkSync(join(taskDir(), `${id}.json`)); } catch { /* */ }
  }
  createdTaskIds.length = 0;
  try { rmSync(tmpRoot, { recursive: true }); } catch { /* */ }
  try { rmSync(frameworkRoot, { recursive: true }); } catch { /* */ }
  vi.restoreAllMocks();
});

import { busCommand } from '../../../src/cli/bus';

function mockExit() {
  return vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`__PROCESS_EXIT_${code}__`);
  }) as never);
}

function taskCount(): number {
  try { return readdirSync(taskDir()).filter(f => createdTaskIds.some(id => f.startsWith(id))).length; }
  catch { return 0; }
}

function captureTaskId(logSpy: ReturnType<typeof vi.spyOn>): string | undefined {
  for (const call of logSpy.mock.calls) {
    const m = String(call[0] ?? '').match(/task_\d+_\d+/);
    if (m) return m[0];
  }
}

// All 8 valid brief fields
const FULL_BRIEF = [
  '--success-criteria', 'PR is merged and CI is green',
  '--out-of-scope', 'No deployment or rollback',
  '--escalation-triggers', 'CI fails 3 times in a row',
  '--source-hierarchy', 'orchestrator',
  '--required-capabilities', 'git, gh CLI, CI access',
  '--fallback-proof', 'Check git log for merge commit',
  '--artifact-expectations', 'Merged PR link and CI run URL',
  '--goal-ancestry', 'G1: ship v2 release',
];

describe('bus create-task brief contract validation', () => {
  it.each([
    ['--success-criteria', FULL_BRIEF.slice(2)],
    ['--out-of-scope', [...FULL_BRIEF.slice(0, 2), ...FULL_BRIEF.slice(4)]],
    ['--escalation-triggers', [...FULL_BRIEF.slice(0, 4), ...FULL_BRIEF.slice(6)]],
    ['--source-hierarchy', [...FULL_BRIEF.slice(0, 6), ...FULL_BRIEF.slice(8)]],
    ['--required-capabilities', [...FULL_BRIEF.slice(0, 8), ...FULL_BRIEF.slice(10)]],
    ['--fallback-proof', [...FULL_BRIEF.slice(0, 10), ...FULL_BRIEF.slice(12)]],
    ['--artifact-expectations', [...FULL_BRIEF.slice(0, 12), ...FULL_BRIEF.slice(14)]],
    ['--goal-ancestry', FULL_BRIEF.slice(0, 14)],
  ])('rejects when %s is missing', async (flag, presentFields) => {
    const exitSpy = mockExit();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      busCommand.parseAsync(['node', 'bus', 'create-task', 'My task', ...presentFields])
    ).rejects.toThrow(/__PROCESS_EXIT_1__/);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy.mock.calls.flat().join(' ')).toContain(`${flag} is required`);
    expect(taskCount()).toBe(0);
  });

  it('rejects when ALL eight brief fields are missing', async () => {
    const exitSpy = mockExit();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      busCommand.parseAsync(['node', 'bus', 'create-task', 'No brief'])
    ).rejects.toThrow(/__PROCESS_EXIT_1__/);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy.mock.calls.flat().join(' ')).toContain('--success-criteria is required');
    expect(taskCount()).toBe(0);
  });

  it('accepts creation when all eight brief fields are provided', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      if (code !== 0) throw new Error(`__PROCESS_EXIT_${code}__`);
    }) as never);

    await busCommand.parseAsync(['node', 'bus', 'create-task', 'Full brief task', ...FULL_BRIEF]);

    expect(exitSpy).toHaveBeenCalledWith(0);
    const taskId = captureTaskId(logSpy);
    expect(taskId).toMatch(/^task_\d+_\d+$/);
    if (taskId) createdTaskIds.push(taskId);
  });

  it('--skip-brief-validation bypasses all eight field checks', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      if (code !== 0) throw new Error(`__PROCESS_EXIT_${code}__`);
    }) as never);

    await busCommand.parseAsync(['node', 'bus', 'create-task', 'Legacy task', '--skip-brief-validation']);

    expect(exitSpy).toHaveBeenCalledWith(0);
    const taskId = captureTaskId(logSpy);
    expect(taskId).toMatch(/^task_\d+_\d+$/);
    if (taskId) createdTaskIds.push(taskId);
  });

  it('stores all eight brief fields on the task JSON when provided', async () => {
    const { readFileSync } = await import('fs');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      if (code !== 0) throw new Error(`__PROCESS_EXIT_${code}__`);
    }) as never);

    await busCommand.parseAsync(['node', 'bus', 'create-task', 'Stored brief task', ...FULL_BRIEF]);

    const taskId = captureTaskId(logSpy);
    expect(taskId).toMatch(/^task_\d+_\d+$/);
    if (!taskId) return;
    createdTaskIds.push(taskId);

    const task = JSON.parse(readFileSync(join(taskDir(), `${taskId}.json`), 'utf-8'));
    expect(task.success_criteria).toBe('PR is merged and CI is green');
    expect(task.out_of_scope).toBe('No deployment or rollback');
    expect(task.escalation_triggers).toBe('CI fails 3 times in a row');
    expect(task.source_hierarchy).toBe('orchestrator');
    expect(task.required_capabilities).toBe('git, gh CLI, CI access');
    expect(task.fallback_proof).toBe('Check git log for merge commit');
    expect(task.artifact_expectations).toBe('Merged PR link and CI run URL');
    expect(task.goal_ancestry).toBe('G1: ship v2 release');
  });
});
