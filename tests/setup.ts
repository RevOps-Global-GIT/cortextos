/**
 * Shared test setup utilities — temp-dir lifecycle and BusPaths factory.
 *
 * Import from individual test files as needed:
 *   import { makeTempDir, removeTempDir, makeBusPaths } from '../../setup';
 *
 * These helpers eliminate the mkdtempSync / rmSync / BusPaths boilerplate
 * that was duplicated across every bus unit test (task, message, approval,
 * agents, …).  Each test file still owns its own beforeEach/afterEach so
 * that per-test isolation is explicit and easy to follow.
 */

import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { BusPaths } from '../../src/types';

/**
 * Create a fresh temporary directory and return its absolute path.
 * Guaranteed to be unique per call.
 *
 * @param prefix  Directory name prefix (default: 'cortextos-test-')
 */
export function makeTempDir(prefix = 'cortextos-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Delete a temporary directory created by makeTempDir.
 * Safe to call even if the directory was already removed.
 */
export function removeTempDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Build a BusPaths object rooted at testDir for a single agent.
 *
 * All paths use the standard cortextOS layout:
 *   <testDir>/inbox/<agentName>
 *   <testDir>/inflight/<agentName>
 *   …
 *
 * @param testDir    Root temp directory (from makeTempDir)
 * @param agentName  Agent identifier used for per-agent sub-paths (default: 'agent')
 */
export function makeBusPaths(testDir: string, agentName = 'agent'): BusPaths {
  return {
    ctxRoot: testDir,
    inbox: join(testDir, 'inbox', agentName),
    inflight: join(testDir, 'inflight', agentName),
    processed: join(testDir, 'processed', agentName),
    logDir: join(testDir, 'logs', agentName),
    stateDir: join(testDir, 'state', agentName),
    taskDir: join(testDir, 'tasks'),
    approvalDir: join(testDir, 'approvals'),
    analyticsDir: join(testDir, 'analytics'),
    heartbeatDir: join(testDir, 'heartbeats'),
  };
}
