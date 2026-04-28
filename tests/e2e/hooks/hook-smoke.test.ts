/**
 * A4 Phase 3 hook smoke tests.
 *
 * Verifies the three core hooks deployed to analyst/codex/orchestrator agents:
 *   1. hook-loop-detector  (PreToolUse)
 *   2. hook-policy-check   (PreToolUse — Bash only)
 *   3. hook-session-restore (SessionStart)
 *
 * Each test:
 *   - Invokes the compiled hook via `node dist/hooks/<hook>.js`
 *   - Pipes a representative JSON payload on stdin
 *   - Asserts exit code 0 (hooks must never exit non-zero on expected inputs)
 *   - Asserts no EBADF or spawn errors in stderr
 *   - Asserts the expected stdout shape (allow=empty, block=JSON decision)
 *
 * Run: npm run test:e2e:hooks
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { invokeHook, makeSandbox, cleanupSandbox, hookPath } from './harness.js';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Hook 1 — loop-detector
// ---------------------------------------------------------------------------

describe('hook-loop-detector', () => {
  let sandbox: string;
  let env: Record<string, string>;

  beforeEach(() => {
    sandbox = makeSandbox();
    env = {
      CTX_ROOT: sandbox,
      CTX_AGENT_NAME: 'test-agent',
    };
  });

  afterEach(() => {
    cleanupSandbox(sandbox);
  });

  it('exits 0 and produces no output for a normal (non-looping) tool call', () => {
    const payload = {
      tool_name: 'Read',
      tool_input: { file_path: '/some/file.ts' },
    };
    const result = invokeHook(hookPath('hook-loop-detector'), payload, env);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toMatch(/EBADF|spawn error/i);
    expect(result.stdout.trim()).toBe('');
  });

  it('exits 0 and allows essential bus commands even when called repeatedly', () => {
    // Essential commands (check-inbox, update-heartbeat, etc.) must never be blocked
    const payload = {
      tool_name: 'Bash',
      tool_input: { command: 'cortextos bus check-inbox' },
    };

    // Fire 20 times — well above REPETITION_BLOCK (15)
    for (let i = 0; i < 20; i++) {
      const result = invokeHook(hookPath('hook-loop-detector'), payload, env);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).not.toMatch(/EBADF|spawn error/i);
      // Essential commands must NOT be blocked
      if (result.stdout.trim()) {
        const json = result.json;
        expect(json?.['decision']).not.toBe('block');
      }
    }
  });

  it('blocks a non-essential tool call after REPETITION_BLOCK identical calls', () => {
    const payload = {
      tool_name: 'Bash',
      tool_input: { command: 'echo "hello world"' },
    };

    let blocked = false;
    for (let i = 0; i < 20; i++) {
      const result = invokeHook(hookPath('hook-loop-detector'), payload, env);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).not.toMatch(/EBADF|spawn error/i);
      if (result.json?.['decision'] === 'block') {
        blocked = true;
        expect(typeof result.json['reason']).toBe('string');
        expect(result.json['reason'] as string).toMatch(/loop detected/i);
        break;
      }
    }

    expect(blocked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Hook 2 — policy-check
// ---------------------------------------------------------------------------

describe('hook-policy-check', () => {
  const env: Record<string, string> = {
    CTX_ROOT: '/tmp/policy-check-sandbox',
    CTX_AGENT_NAME: 'analyst',
  };

  it('exits 0 and produces no output for a safe Bash command', () => {
    const payload = {
      tool_name: 'Bash',
      tool_input: { command: 'ls -la /tmp' },
    };
    const result = invokeHook(hookPath('hook-policy-check'), payload, env);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toMatch(/EBADF|spawn error/i);
    expect(result.stdout.trim()).toBe('');
  });

  it('exits 0 and produces no output for non-Bash tool calls (hook is Bash-only)', () => {
    const payload = {
      tool_name: 'Read',
      tool_input: { file_path: '/etc/hostname' },
    };
    const result = invokeHook(hookPath('hook-policy-check'), payload, env);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  it('blocks P2: git push to origin by a non-orchestrator agent', () => {
    const payload = {
      tool_name: 'Bash',
      tool_input: { command: 'git push origin main' },
    };
    const result = invokeHook(hookPath('hook-policy-check'), payload, env);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toMatch(/EBADF|spawn error/i);
    expect(result.json?.['decision']).toBe('block');
    expect(result.json?.['reason'] as string).toMatch(/fork/i);
  });

  it('blocks P4: git add -A', () => {
    const payload = {
      tool_name: 'Bash',
      tool_input: { command: 'git add -A && git commit -m "wip"' },
    };
    const result = invokeHook(hookPath('hook-policy-check'), payload, env);

    expect(result.exitCode).toBe(0);
    expect(result.json?.['decision']).toBe('block');
    expect(result.json?.['reason'] as string).toMatch(/specific paths/i);
  });

  it('blocks P4: git add .', () => {
    const payload = {
      tool_name: 'Bash',
      tool_input: { command: 'git add .' },
    };
    const result = invokeHook(hookPath('hook-policy-check'), payload, env);

    expect(result.exitCode).toBe(0);
    expect(result.json?.['decision']).toBe('block');
  });

  it('allows git push fork (correct remote)', () => {
    const payload = {
      tool_name: 'Bash',
      tool_input: { command: 'git push fork feat/my-branch' },
    };
    const result = invokeHook(hookPath('hook-policy-check'), payload, env);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(''); // no block
  });

  it('allows git add with specific file paths', () => {
    const payload = {
      tool_name: 'Bash',
      tool_input: { command: 'git add src/bus/rgos-mirror.ts tests/unit/bus/rgos-mirror.test.ts' },
    };
    const result = invokeHook(hookPath('hook-policy-check'), payload, env);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Hook 3 — session-restore
// ---------------------------------------------------------------------------

describe('hook-session-restore', () => {
  let sandbox: string;
  let env: Record<string, string>;

  beforeEach(() => {
    sandbox = makeSandbox();
    env = {
      CTX_ROOT: sandbox,
      CTX_AGENT_NAME: 'test-agent',
    };
  });

  afterEach(() => {
    cleanupSandbox(sandbox);
  });

  it('exits 0 silently for non-compact sources (startup)', () => {
    const payload = { session_id: 'sess-001', source: 'startup' };
    const result = invokeHook(hookPath('hook-session-restore'), payload, env);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toMatch(/EBADF|spawn error/i);
    expect(result.stdout.trim()).toBe('');
  });

  it('exits 0 silently for compact source when no facts file exists', () => {
    const payload = { session_id: 'sess-002', source: 'compact' };
    const result = invokeHook(hookPath('hook-session-restore'), payload, env);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  it('returns additionalContext for compact source with a recent facts file', () => {
    // Write a synthetic facts file in the expected location
    const factsDir = join(sandbox, 'state', 'test-agent', 'memory', 'facts');
    mkdirSync(factsDir, { recursive: true });

    const today = new Date().toISOString().slice(0, 10);
    const factsFile = join(factsDir, `${today}.jsonl`);
    const factEntry = {
      ts: new Date().toISOString(),
      session_id: 'sess-003',
      agent: 'test-agent',
      org: 'revops-global',
      source: 'precompact',
      summary: 'Working on the reply_to_id fix. PR #17 is on fork. 80/80 tests pass.',
      keywords: ['reply_to_id', 'uuidv5', 'mirror', 'retry-queue'],
    };
    writeFileSync(factsFile, JSON.stringify(factEntry) + '\n', 'utf-8');

    const payload = { session_id: 'sess-003', source: 'compact' };
    const result = invokeHook(hookPath('hook-session-restore'), payload, env);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toMatch(/EBADF|spawn error/i);
    expect(result.json).not.toBeNull();

    const hookOutput = result.json?.['hookSpecificOutput'] as Record<string, unknown> | undefined;
    expect(hookOutput?.['hookEventName']).toBe('SessionStart');
    const additionalContext = hookOutput?.['additionalContext'] as string;
    expect(typeof additionalContext).toBe('string');
    expect(additionalContext).toMatch(/Previous Session/);
    expect(additionalContext).toMatch(/reply_to_id fix/);
  });

  it('exits 0 silently for compact source with an expired (>6h old) facts entry', () => {
    const factsDir = join(sandbox, 'state', 'test-agent', 'memory', 'facts');
    mkdirSync(factsDir, { recursive: true });

    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const factsFile = join(factsDir, `${yesterday}.jsonl`);
    const oldTs = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString(); // 8h ago > MAX_AGE_HOURS (6)
    const factEntry = {
      ts: oldTs,
      session_id: 'sess-old',
      agent: 'test-agent',
      org: 'revops-global',
      source: 'precompact',
      summary: 'Stale context that should not be injected.',
      keywords: ['stale'],
    };
    writeFileSync(factsFile, JSON.stringify(factEntry) + '\n', 'utf-8');

    const payload = { session_id: 'sess-004', source: 'compact' };
    const result = invokeHook(hookPath('hook-session-restore'), payload, env);

    expect(result.exitCode).toBe(0);
    // Stale entry — no additionalContext injected
    expect(result.stdout.trim()).toBe('');
  });
});
