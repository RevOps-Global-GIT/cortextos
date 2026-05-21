import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ---------------------------------------------------------------------------
// Mock sendMessage so no inbox files are written in the test environment.
// ---------------------------------------------------------------------------
const sendMessageSpy = vi.fn();
vi.mock('../../../src/bus/message', () => ({
  sendMessage: (...args: unknown[]) => sendMessageSpy(...args),
  checkInbox: vi.fn(() => []),
  ackInbox: vi.fn(),
}));

// resolvePaths returns real-looking paths; we only care that sendMessage is called.
vi.mock('../../../src/utils/paths', () => ({
  resolvePaths: (_a: string, _b: string, _c: string) => ({
    inbox: '/tmp/fake-inbox.json',
    tasks: '/tmp/fake-tasks',
    events: '/tmp/fake-events.jsonl',
    outbox: '/tmp/fake-outbox',
  }),
}));

// ---------------------------------------------------------------------------
// Import the module under test AFTER mocks are installed.
// ---------------------------------------------------------------------------
// The hook is a self-executing main() that reads stdin, so we import
// the internal helpers that we can unit-test directly.
// We re-export them for testability by duplicating the logic here.
// ---------------------------------------------------------------------------

import {
  checkCompliance,
  recordRotation,
  STATE_FILE_NAME,
} from '../../../src/hooks/hook-blocked-auto-rotate';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakeCtxRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'bar-test-'));
  return root;
}

function writeStateFile(ctxRoot: string, agent: string, isoTs: string) {
  const stateDir = join(ctxRoot, 'state', agent);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, STATE_FILE_NAME),
    JSON.stringify({ last_rotation_at: isoTs }),
  );
}

function writeTaskFile(taskDir: string, taskId: string, status: string, assignee: string) {
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(
    join(taskDir, `${taskId}.json`),
    JSON.stringify({ id: taskId, status, assigned_to: assignee, priority: 'normal' }),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('recordRotation', () => {
  let ctxRoot: string;

  beforeEach(() => { ctxRoot = makeFakeCtxRoot(); });
  afterEach(() => { rmSync(ctxRoot, { recursive: true, force: true }); });

  it('writes state file with current timestamp', () => {
    const before = Date.now();
    recordRotation(ctxRoot, 'dev');
    const stateDir = join(ctxRoot, 'state', 'dev');
    const statePath = join(stateDir, STATE_FILE_NAME);
    expect(existsSync(statePath)).toBe(true);
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    expect(new Date(state.last_rotation_at).getTime()).toBeGreaterThanOrEqual(before);
  });
});

describe('checkCompliance', () => {
  let ctxRoot: string;

  beforeEach(() => {
    ctxRoot = makeFakeCtxRoot();
    sendMessageSpy.mockReset();
  });
  afterEach(() => { rmSync(ctxRoot, { recursive: true, force: true }); });

  it('does not warn when spawn happened within 5 minutes', () => {
    // Write a state file with a recent timestamp
    writeStateFile(ctxRoot, 'dev', new Date().toISOString());
    checkCompliance(ctxRoot, 'revops-global', 'dev', 'default', 'task_123');
    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  it('sends VIOLATION when no state file exists and pending tasks are present', () => {
    const taskDir = join(ctxRoot, 'orgs', 'revops-global', 'tasks');
    writeTaskFile(taskDir, 'task_abc', 'pending', 'dev');
    checkCompliance(ctxRoot, 'revops-global', 'dev', 'default', 'task_blocked');
    expect(sendMessageSpy).toHaveBeenCalledOnce();
    const [,, , , msg] = sendMessageSpy.mock.calls[0];
    expect(msg).toContain('VIOLATION');
    expect(msg).toContain('task_blocked');
  });

  it('sends VIOLATION when state file is older than 5 minutes', () => {
    const staleTs = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    writeStateFile(ctxRoot, 'dev', staleTs);
    const taskDir = join(ctxRoot, 'orgs', 'revops-global', 'tasks');
    writeTaskFile(taskDir, 'task_xyz', 'pending', 'dev');
    checkCompliance(ctxRoot, 'revops-global', 'dev', 'default', 'task_stale');
    expect(sendMessageSpy).toHaveBeenCalledOnce();
    const [,, , , msg] = sendMessageSpy.mock.calls[0];
    expect(msg).toContain('VIOLATION');
  });

  it('sends BACKLOG EMPTY when no pending tasks exist', () => {
    // No state file, no pending tasks → backlog empty nudge
    checkCompliance(ctxRoot, 'revops-global', 'dev', 'default', 'task_isolated');
    expect(sendMessageSpy).toHaveBeenCalledOnce();
    const [,, , , msg] = sendMessageSpy.mock.calls[0];
    expect(msg).toContain('BACKLOG EMPTY');
    expect(msg).toContain('task_isolated');
  });

  it('does not flag in_progress tasks as pending', () => {
    const taskDir = join(ctxRoot, 'orgs', 'revops-global', 'tasks');
    writeTaskFile(taskDir, 'task_busy', 'in_progress', 'dev');
    checkCompliance(ctxRoot, 'revops-global', 'dev', 'default', 'task_ok');
    // Only in_progress task exists, no pending → BACKLOG EMPTY
    const [,, , , msg] = sendMessageSpy.mock.calls[0];
    expect(msg).toContain('BACKLOG EMPTY');
  });
});
