/**
 * Hook smoke-test harness.
 *
 * Provides `invokeHook(scriptPath, stdinPayload, env?)` — runs the compiled
 * hook as a child process with JSON piped on stdin, and returns the exit code,
 * parsed stdout JSON (or raw string if not JSON), and stderr text.
 *
 * Hooks are invoked as `node <scriptPath>` so the harness is independent of
 * the `cortextos bus hook-*` CLI wiring and works against the compiled dist/
 * files directly.
 */

import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

export interface HookResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Parsed stdout as JSON, or null if stdout is empty or not valid JSON. */
  json: Record<string, unknown> | null;
}

/**
 * Invoke a compiled hook script and return its outputs.
 *
 * @param scriptPath  Absolute path to the compiled .js hook file.
 * @param stdinPayload  Object serialised as JSON and piped to the hook's stdin.
 * @param env  Additional environment variables merged with a clean baseline env.
 */
export function invokeHook(
  scriptPath: string,
  stdinPayload: Record<string, unknown>,
  env: Record<string, string> = {},
): HookResult {
  const result = spawnSync('node', [scriptPath], {
    input: JSON.stringify(stdinPayload),
    encoding: 'utf-8',
    timeout: 10_000,
    env: {
      // Minimal baseline — hooks must not depend on the ambient process env
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: process.env.HOME ?? '/tmp',
      ...env,
    },
  });

  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const exitCode = result.status ?? 1;

  let json: Record<string, unknown> | null = null;
  const trimmed = stdout.trim();
  if (trimmed) {
    try {
      json = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // Not JSON — caller can inspect raw stdout
    }
  }

  return { exitCode, stdout, stderr, json };
}

/**
 * Create a throwaway temp directory for per-test CTX_ROOT state.
 * Returns the path. Callers are responsible for cleanup via `cleanupSandbox`.
 */
export function makeSandbox(): string {
  return mkdtempSync(join(tmpdir(), 'hook-smoke-'));
}

/**
 * Remove a sandbox directory created by `makeSandbox`.
 */
export function cleanupSandbox(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort
  }
}

/** Resolved path to the compiled hooks directory. */
export const HOOKS_DIR = join(__dirname, '..', '..', '..', 'dist', 'hooks');

/** Helper: build the full path to a hook script by base name. */
export function hookPath(name: string): string {
  return join(HOOKS_DIR, `${name}.js`);
}
