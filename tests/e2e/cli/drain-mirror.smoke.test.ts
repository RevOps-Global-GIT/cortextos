/**
 * drain-mirror CLI smoke tests — subprocess invocation harness.
 *
 * Tests the `cortextos bus drain-mirror [--json]` subcommand by spawning it
 * as a subprocess (matching production invocation). Covers 5 distinct CLI
 * code paths without requiring a live PostgREST/Supabase connection:
 *
 *   1. Mirror disabled (no SUPABASE env vars) → exit 0, prose message
 *   2. Mirror disabled + --json             → exit 0, {ok:true,skipped:true}
 *   3. No CTX_ROOT env var                  → exit 1 (or JSON error)
 *   4. Empty queue                          → exit 0, "nothing to drain"
 *   5. Empty queue + --json                 → exit 0, {ok:true,before:0,after:0,drained:0}
 *
 * Paths 4–5 (drain succeeds / partial fail) require a live PostgREST endpoint
 * and are deferred to integration tests.
 *
 * Each test gets an isolated temp dir; no state bleeds between runs.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const CLI_PATH = resolve(fileURLToPath(import.meta.url), '../../../../dist/cli.js');

interface DrainResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  json: Record<string, unknown> | null;
}

function runDrainMirror(
  args: string[] = [],
  env: Record<string, string | undefined> = {},
): DrainResult {
  const result = spawnSync(process.execPath, [CLI_PATH, 'bus', 'drain-mirror', ...args], {
    encoding: 'utf-8',
    env: {
      // Start clean — strip Supabase credentials so mirror is disabled by default
      ...process.env,
      SUPABASE_RGOS_URL: undefined,
      SUPABASE_RGOS_SERVICE_KEY: undefined,
      BUS_RGOS_MIRROR_DISABLED: undefined,
      CTX_ROOT: undefined,
      CTX_AGENT_NAME: undefined,
      ...env,
    },
    timeout: 15_000,
  });

  let json: Record<string, unknown> | null = null;
  const trimmed = result.stdout?.trim();
  if (trimmed?.startsWith('{')) {
    try {
      json = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // Not JSON — leave null
    }
  }

  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? -1,
    json,
  };
}

function makeTempRetryQueueDir(): { ctxRoot: string; agentName: string; queuePath: string; cleanup: () => void } {
  const ctxRoot = mkdtempSync(join(tmpdir(), 'drain-mirror-smoke-'));
  const agentName = 'test-agent';
  const stateDir = join(ctxRoot, 'state', agentName);
  mkdirSync(stateDir, { recursive: true });
  const queuePath = join(stateDir, 'mirror-retry.jsonl');
  return {
    ctxRoot,
    agentName,
    queuePath,
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
// Tests
// ---------------------------------------------------------------------------

describe('drain-mirror CLI smoke', () => {
  // -------------------------------------------------------------------------
  // Path 1: Mirror disabled (no SUPABASE env vars)
  // -------------------------------------------------------------------------

  it('exits 0 with disabled message when mirror env vars are absent', () => {
    // Default env in runDrainMirror strips SUPABASE_RGOS_URL + SUPABASE_RGOS_SERVICE_KEY
    const result = runDrainMirror();

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/disabled/i);
  });

  // -------------------------------------------------------------------------
  // Path 2: Mirror disabled + --json → structured output
  // -------------------------------------------------------------------------

  it('exits 0 with {ok:true,skipped:true} when --json and mirror is disabled', () => {
    const result = runDrainMirror(['--json']);

    expect(result.exitCode).toBe(0);
    expect(result.json).not.toBeNull();
    expect(result.json?.ok).toBe(true);
    expect(result.json?.skipped).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Path 3: Mirror enabled but CTX_ROOT not set → cannot locate queue → exit 1
  // -------------------------------------------------------------------------

  it('exits 1 when mirror is enabled but CTX_ROOT is not set', () => {
    const result = runDrainMirror([], {
      SUPABASE_RGOS_URL: 'https://example.supabase.co',
      SUPABASE_RGOS_SERVICE_KEY: 'fake-key',
      CTX_ROOT: undefined,
      CTX_AGENT_NAME: undefined,
    });

    // Cannot locate retry queue → error path
    expect(result.exitCode).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Path 4: Mirror enabled, CTX_ROOT set, queue file absent → empty queue
  // -------------------------------------------------------------------------

  it('exits 0 with "nothing to drain" when queue file does not exist', () => {
    const { ctxRoot, agentName, cleanup } = makeTempRetryQueueDir();
    try {
      const result = runDrainMirror([], {
        SUPABASE_RGOS_URL: 'https://example.supabase.co',
        SUPABASE_RGOS_SERVICE_KEY: 'fake-key',
        CTX_ROOT: ctxRoot,
        CTX_AGENT_NAME: agentName,
      });

      // Empty queue (no file) → "nothing to drain", exit 0
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/nothing to drain|empty/i);
    } finally {
      cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // Path 5: Mirror enabled, CTX_ROOT set, empty queue file → --json shape
  // -------------------------------------------------------------------------

  it('exits 0 with {ok:true,before:0,after:0,drained:0} when --json and queue is empty', () => {
    const { ctxRoot, agentName, queuePath, cleanup } = makeTempRetryQueueDir();
    try {
      // Write an empty (zero-entry) queue file — readRetryQueue returns [] for empty content
      writeFileSync(queuePath, '', { encoding: 'utf-8', mode: 0o600 });

      const result = runDrainMirror(['--json'], {
        SUPABASE_RGOS_URL: 'https://example.supabase.co',
        SUPABASE_RGOS_SERVICE_KEY: 'fake-key',
        CTX_ROOT: ctxRoot,
        CTX_AGENT_NAME: agentName,
      });

      expect(result.exitCode).toBe(0);
      expect(result.json).not.toBeNull();
      expect(result.json?.ok).toBe(true);
      expect(result.json?.before).toBe(0);
      expect(result.json?.after).toBe(0);
      expect(result.json?.drained).toBe(0);
    } finally {
      cleanup();
    }
  });
});
