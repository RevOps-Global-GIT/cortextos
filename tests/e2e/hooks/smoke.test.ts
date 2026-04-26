/**
 * Hook smoke tests — E2E subprocess invocation harness.
 *
 * Each hook is spawned as a subprocess via spawnSync, matching the invocation
 * model Claude Code uses in production (subprocess + JSON via stdin + stdout).
 *
 * Three baseline tests:
 *   1. hook-loop-detector — allow first call; detect loop after 15 identical calls
 *   2. hook-policy-check  — allow safe Bash; block P2/P4 policy violations
 *   3. hook-context-status — write context_status.json on valid input
 *
 * Tests are intentionally independent: each gets a fresh CTX_ROOT via
 * makeTempRoot() so state never bleeds between runs.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { resolve } from 'path';

// ---------------------------------------------------------------------------
// Harness helpers
// ---------------------------------------------------------------------------

const HOOKS_DIR = resolve(fileURLToPath(import.meta.url), '../../../../dist/hooks');

interface HookResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  output: Record<string, unknown> | null;
}

function runHook(
  hookName: string,
  input: Record<string, unknown>,
  env: Record<string, string> = {},
): HookResult {
  const hookPath = join(HOOKS_DIR, `${hookName}.js`);
  const result = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(input),
    encoding: 'utf-8',
    env: {
      ...process.env,
      CTX_AGENT_NAME: 'test-agent',
      CTX_ORG: 'test-org',
      // No BOT_TOKEN / CHAT_ID → Telegram hooks no-op safely
      ...env,
    },
    timeout: 10_000,
  });

  let output: Record<string, unknown> | null = null;
  const trimmed = result.stdout?.trim();
  if (trimmed) {
    try {
      output = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // Non-JSON stdout — leave output null
    }
  }

  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? -1,
    output,
  };
}

function makeTempRoot(): { ctxRoot: string; stateDir: string; cleanup: () => void } {
  const ctxRoot = mkdtempSync(join(tmpdir(), 'ctx-smoke-'));
  const agentName = 'test-agent';
  const stateDir = join(ctxRoot, 'state', agentName);
  mkdirSync(stateDir, { recursive: true });

  return {
    ctxRoot,
    stateDir,
    cleanup: () => {
      try {
        rmSync(ctxRoot, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Test 1: hook-loop-detector
// ---------------------------------------------------------------------------

describe('hook-loop-detector smoke', () => {
  it('allows first occurrence of a tool call (no loop)', () => {
    const { ctxRoot, stateDir, cleanup } = makeTempRoot();
    try {
      const result = runHook(
        'hook-loop-detector',
        { tool_name: 'Read', tool_input: { file_path: '/tmp/test.txt' } },
        { CTX_ROOT: ctxRoot, CTX_AGENT_NAME: 'test-agent' },
      );

      // Hook always exits 0
      expect(result.exitCode).toBe(0);

      // No block decision on first call
      expect(result.output?.decision).not.toBe('block');

      // State file should be written after first call
      const stateFile = join(stateDir, 'loop-detector.json');
      expect(existsSync(stateFile)).toBe(true);
      const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
      expect(Array.isArray(state.history)).toBe(true);
      expect(state.history.length).toBe(1);
    } finally {
      cleanup();
    }
  });

  it('detects a loop after REPETITION_BLOCK identical calls', () => {
    const { ctxRoot, cleanup } = makeTempRoot();
    try {
      const payload = {
        tool_name: 'Read',
        tool_input: { file_path: '/tmp/identical.txt' },
      };
      const env = { CTX_ROOT: ctxRoot, CTX_AGENT_NAME: 'test-agent' };

      // REPETITION_BLOCK = 15; call 15 times with identical args to trigger
      let lastResult!: HookResult;
      for (let i = 0; i < 15; i++) {
        lastResult = runHook('hook-loop-detector', payload, env);
      }

      // 15th call should emit a block decision
      expect(lastResult.output).not.toBeNull();
      expect(lastResult.output?.decision).toBe('block');
      expect(typeof lastResult.output?.reason).toBe('string');
      expect(lastResult.output?.reason as string).toMatch(/loop/i);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Test 2: hook-policy-check
// ---------------------------------------------------------------------------

describe('hook-policy-check smoke', () => {
  it('allows a safe Bash command (ls -la /tmp)', () => {
    const { ctxRoot, cleanup } = makeTempRoot();
    try {
      const result = runHook(
        'hook-policy-check',
        { tool_name: 'Bash', tool_input: { command: 'ls -la /tmp' } },
        { CTX_ROOT: ctxRoot, CTX_AGENT_NAME: 'test-agent' },
      );

      expect(result.exitCode).toBe(0);
      // Safe command — no block decision in output
      if (result.output) {
        expect(result.output.decision).not.toBe('block');
      }
    } finally {
      cleanup();
    }
  });

  it('blocks git push to origin (P2 violation)', () => {
    const { ctxRoot, cleanup } = makeTempRoot();
    try {
      const result = runHook(
        'hook-policy-check',
        { tool_name: 'Bash', tool_input: { command: 'git push origin main' } },
        { CTX_ROOT: ctxRoot, CTX_AGENT_NAME: 'test-agent' },
      );

      expect(result.exitCode).toBe(0);
      expect(result.output?.decision).toBe('block');
      expect(result.output?.reason as string).toMatch(/fork/i);
    } finally {
      cleanup();
    }
  });

  it('blocks git add -A (P4 violation)', () => {
    const { ctxRoot, cleanup } = makeTempRoot();
    try {
      const result = runHook(
        'hook-policy-check',
        { tool_name: 'Bash', tool_input: { command: 'git add -A && git commit -m "msg"' } },
        { CTX_ROOT: ctxRoot, CTX_AGENT_NAME: 'test-agent' },
      );

      expect(result.exitCode).toBe(0);
      expect(result.output?.decision).toBe('block');
      expect(result.output?.reason as string).toMatch(/specific paths/i);
    } finally {
      cleanup();
    }
  });

  it('allows non-Bash tool calls (policy only applies to Bash)', () => {
    const { ctxRoot, cleanup } = makeTempRoot();
    try {
      const result = runHook(
        'hook-policy-check',
        { tool_name: 'Read', tool_input: { file_path: '/etc/passwd' } },
        { CTX_ROOT: ctxRoot, CTX_AGENT_NAME: 'test-agent' },
      );

      expect(result.exitCode).toBe(0);
      // Non-Bash tools are always allowed by this hook
      if (result.output) {
        expect(result.output.decision).not.toBe('block');
      }
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Test 3: hook-context-status
// ---------------------------------------------------------------------------

describe('hook-context-status smoke', () => {
  it('writes context_status.json when given valid context_window input', () => {
    const { ctxRoot, stateDir, cleanup } = makeTempRoot();
    try {
      const result = runHook(
        'hook-context-status',
        {
          context_window: {
            used_percentage: 42,
            context_window_size: 200000,
            exceeds_200k_tokens: false,
            current_usage: { input_tokens: 84000, output_tokens: 0 },
          },
          session_id: 'smoke-test-session',
        },
        { CTX_ROOT: ctxRoot, CTX_AGENT_NAME: 'test-agent' },
      );

      expect(result.exitCode).toBe(0);

      const statusFile = join(stateDir, 'context_status.json');
      expect(existsSync(statusFile)).toBe(true);

      const status = JSON.parse(readFileSync(statusFile, 'utf-8'));
      expect(status.used_percentage).toBe(42);
      expect(status.context_window_size).toBe(200000);
      expect(status.exceeds_200k_tokens).toBe(false);
      expect(typeof status.written_at).toBe('string');
    } finally {
      cleanup();
    }
  });

  it('exits 0 and writes nothing when no context_window in input', () => {
    const { ctxRoot, stateDir, cleanup } = makeTempRoot();
    try {
      const result = runHook(
        'hook-context-status',
        { tool_name: 'Bash', tool_input: { command: 'ls' } },
        { CTX_ROOT: ctxRoot, CTX_AGENT_NAME: 'test-agent' },
      );

      expect(result.exitCode).toBe(0);
      // No context_window → no file written
      const statusFile = join(stateDir, 'context_status.json');
      expect(existsSync(statusFile)).toBe(false);
    } finally {
      cleanup();
    }
  });
});
