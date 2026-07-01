/**
 * Daily force-restart ceiling breaker in FastChecker.
 *
 * Regression coverage for task_1782877440426_47576300:
 *
 * The ctx-0%-handoff-not-completed force-restart path had only a
 * sliding-window rate limiter (3 restarts in 15min → pause 30min → reset).
 * With only that limiter, the orchestrator agent looped 135× across 11.5h
 * on 2026-06-30 before being manually stopped — the 30min pause absorbed
 * the burst but the counter reset and the loop re-tripped indefinitely.
 *
 * Fix: mirror the crash-path max_crashes_per_day pattern with a session-day
 * ceiling that HALTS after N (default 5) force-restarts today and logs
 * HALTED to logs/<agent>/restarts.log. Manual intervention required after
 * halt: delete the daily counter file or wait for UTC-day rollover.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock hardRestart so tests do not actually spawn subprocesses. Keep the rest
// of ../../../src/bus/system as-is.
vi.mock('../../../src/bus/system', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/bus/system')>();
  return { ...actual, hardRestart: vi.fn() };
});
vi.mock('child_process', () => ({ execFile: vi.fn(), execFileSync: vi.fn(), spawn: vi.fn() }));
vi.mock('../../../src/bus/task', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/bus/task')>();
  return { ...actual, listTasks: vi.fn().mockReturnValue([]) };
});
vi.mock('../../../src/bus/rgos-mirror', () => ({
  mirrorTaskToRgos: vi.fn().mockResolvedValue(undefined),
  mirrorApprovalToRgos: vi.fn().mockResolvedValue(undefined),
  drainRetryQueue: vi.fn().mockResolvedValue(undefined),
  isEnabled: vi.fn().mockReturnValue(false),
}));

import { mkdtempSync, rmSync, readFileSync, mkdirSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FastChecker } from '../../../src/daemon/fast-checker';
import { hardRestart } from '../../../src/bus/system';
import type { BusPaths } from '../../../src/types';

function makePaths(root: string): BusPaths {
  const paths: BusPaths = {
    ctxRoot: root,
    inbox: join(root, 'inbox'),
    inflight: join(root, 'inflight'),
    processed: join(root, 'processed'),
    logDir: join(root, 'logs'),
    stateDir: join(root, 'state'),
    taskDir: join(root, 'tasks'),
    approvalDir: join(root, 'approvals'),
    analyticsDir: join(root, 'analytics'),
    heartbeatDir: join(root, 'heartbeats'),
  };
  for (const dir of Object.values(paths)) {
    if (dir !== root) mkdirSync(dir, { recursive: true });
  }
  mkdirSync(join(root, 'logs', 'orchestrator'), { recursive: true });
  return paths;
}

/**
 * Build a mock AgentProcess sufficient to drive forceContextRestart.
 * `configOverride` lets a test set max_force_restarts_per_day.
 */
function makeAgent(name: string, configOverride: Record<string, unknown> = {}): any {
  return {
    name,
    isBootstrapped: vi.fn().mockReturnValue(true),
    isProcessAlive: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue({ status: 'running' }),
    markBootstrapped: vi.fn(),
    injectMessage: vi.fn().mockReturnValue(true),
    write: vi.fn(),
    getConfig: vi.fn().mockReturnValue(configOverride),
    getOutputBuffer: vi.fn().mockReturnValue({ getRecent: () => '' }),
    getAgentDir: vi.fn().mockReturnValue('/tmp/nonexistent-agent-dir'),
    sessionRefresh: vi.fn().mockResolvedValue(undefined),
  };
}

function readRestartsLog(root: string, name: string): string {
  const p = join(root, 'logs', name, 'restarts.log');
  return existsSync(p) ? readFileSync(p, 'utf-8') : '';
}

function invokeForceContextRestart(fc: FastChecker, reason: string): void {
  (fc as any).forceContextRestart(reason);
}

describe('FastChecker — daily force-restart ceiling (task_1782877440426_47576300)', () => {
  let root: string;
  let paths: BusPaths;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ctx-force-restart-breaker-'));
    paths = makePaths(root);
    vi.mocked(hardRestart).mockClear();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('allows force-restarts up to max_force_restarts_per_day (default 5) then HALTS', () => {
    const agent = makeAgent('orchestrator', {}); // default cap = 5
    const fc = new FastChecker(agent, paths, '/tmp/framework');

    // Serially drive 5 successful force-restarts. The private sessionRefreshInProgress
    // guard is reset each call because our mocked sessionRefresh resolves immediately
    // and its .finally handler flips the flag back off (fire-and-forget in the impl).
    for (let i = 1; i <= 5; i++) {
      (fc as any).sessionRefreshInProgress = false;   // simulate the finally reset between calls
      (fc as any).ctxCircuitRestarts = [];             // prevent the 3-in-15min secondary breaker from tripping
      (fc as any).ctxCircuitBrokenAt = null;
      invokeForceContextRestart(fc, `attempt ${i}`);
    }

    // 5 restarts triggered hardRestart. The counter file records 5 today.
    expect(vi.mocked(hardRestart)).toHaveBeenCalledTimes(5);
    const counterFile = join(paths.stateDir, '.force-restart-count-today');
    expect(existsSync(counterFile)).toBe(true);
    expect(readFileSync(counterFile, 'utf-8')).toMatch(/^\d{4}-\d{2}-\d{2}:5$/);

    // 6th attempt HALTS — no additional hardRestart call, HALTED line in restarts.log.
    (fc as any).sessionRefreshInProgress = false;
    (fc as any).ctxCircuitRestarts = [];
    invokeForceContextRestart(fc, 'attempt 6 — over cap');
    expect(vi.mocked(hardRestart)).toHaveBeenCalledTimes(5); // unchanged
    const log = readRestartsLog(root, 'orchestrator');
    expect(log).toMatch(/HALTED: force_restart_count=5 max=5 reason="attempt 6/);
  });

  it('respects a custom max_force_restarts_per_day config', () => {
    const agent = makeAgent('orchestrator', { max_force_restarts_per_day: 2 });
    const fc = new FastChecker(agent, paths, '/tmp/framework');

    for (let i = 1; i <= 2; i++) {
      (fc as any).sessionRefreshInProgress = false;
      (fc as any).ctxCircuitRestarts = [];
      invokeForceContextRestart(fc, `attempt ${i}`);
    }
    expect(vi.mocked(hardRestart)).toHaveBeenCalledTimes(2);

    (fc as any).sessionRefreshInProgress = false;
    (fc as any).ctxCircuitRestarts = [];
    invokeForceContextRestart(fc, 'attempt 3 — over custom cap');
    expect(vi.mocked(hardRestart)).toHaveBeenCalledTimes(2);
    expect(readRestartsLog(root, 'orchestrator')).toMatch(/HALTED: force_restart_count=2 max=2/);
  });

  it('logs HALTED only ONCE per day even if repeatedly re-tripped', () => {
    const agent = makeAgent('orchestrator', { max_force_restarts_per_day: 1 });
    const fc = new FastChecker(agent, paths, '/tmp/framework');

    (fc as any).sessionRefreshInProgress = false;
    (fc as any).ctxCircuitRestarts = [];
    invokeForceContextRestart(fc, 'first');
    for (let i = 0; i < 5; i++) {
      (fc as any).sessionRefreshInProgress = false;
      (fc as any).ctxCircuitRestarts = [];
      invokeForceContextRestart(fc, `over-cap ${i}`);
    }
    const log = readRestartsLog(root, 'orchestrator');
    const haltedLines = log.split('\n').filter(l => l.includes('HALTED:'));
    expect(haltedLines).toHaveLength(1);
  });

  it('persists the counter across FastChecker instances (mirrors --continue restart)', () => {
    const agent1 = makeAgent('orchestrator', { max_force_restarts_per_day: 3 });
    const fc1 = new FastChecker(agent1, paths, '/tmp/framework');
    for (let i = 1; i <= 2; i++) {
      (fc1 as any).sessionRefreshInProgress = false;
      (fc1 as any).ctxCircuitRestarts = [];
      invokeForceContextRestart(fc1, `pre-restart ${i}`);
    }
    expect(vi.mocked(hardRestart)).toHaveBeenCalledTimes(2);

    // Simulate daemon restart — a NEW FastChecker sees the persisted counter=2.
    const agent2 = makeAgent('orchestrator', { max_force_restarts_per_day: 3 });
    const fc2 = new FastChecker(agent2, paths, '/tmp/framework');

    (fc2 as any).sessionRefreshInProgress = false;
    (fc2 as any).ctxCircuitRestarts = [];
    invokeForceContextRestart(fc2, 'post-restart-3-of-3');
    expect(vi.mocked(hardRestart)).toHaveBeenCalledTimes(3);

    // 4th attempt from the fresh instance must HALT because counter is now 3.
    (fc2 as any).sessionRefreshInProgress = false;
    (fc2 as any).ctxCircuitRestarts = [];
    invokeForceContextRestart(fc2, 'post-restart-4-over-cap');
    expect(vi.mocked(hardRestart)).toHaveBeenCalledTimes(3); // unchanged
    expect(readRestartsLog(root, 'orchestrator')).toMatch(/HALTED: force_restart_count=3 max=3/);
  });

  it('rolls over the counter when a new UTC day is stored on disk', () => {
    // Pre-seed the daily file with a STALE date and a count already at the cap.
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    writeFileSync(join(paths.stateDir, '.force-restart-count-today'), `${yesterday}:5`, 'utf-8');

    const agent = makeAgent('orchestrator', { max_force_restarts_per_day: 5 });
    const fc = new FastChecker(agent, paths, '/tmp/framework');
    (fc as any).sessionRefreshInProgress = false;
    (fc as any).ctxCircuitRestarts = [];
    // The rollover on read (loadForceRestartDaily) already zeroed the counter,
    // so the first attempt today succeeds and hardRestart fires.
    invokeForceContextRestart(fc, 'first attempt on new day');
    expect(vi.mocked(hardRestart)).toHaveBeenCalledTimes(1);
    const counter = readFileSync(join(paths.stateDir, '.force-restart-count-today'), 'utf-8');
    expect(counter).toMatch(/^\d{4}-\d{2}-\d{2}:1$/);
    // Today's date is on the file, not yesterday's.
    expect(counter.startsWith(yesterday)).toBe(false);
  });

  it('max_force_restarts_per_day=0 disables the ceiling (rate limiter only, not recommended)', () => {
    const agent = makeAgent('orchestrator', { max_force_restarts_per_day: 0 });
    const fc = new FastChecker(agent, paths, '/tmp/framework');

    // Bypass the 3-in-15min secondary breaker each iteration and drive many attempts.
    for (let i = 1; i <= 8; i++) {
      (fc as any).sessionRefreshInProgress = false;
      (fc as any).ctxCircuitRestarts = [];
      invokeForceContextRestart(fc, `unbounded ${i}`);
    }
    // With ceiling disabled all 8 attempts go through — the sliding window breaker
    // is the only pacing (we cleared its state each iteration above).
    expect(vi.mocked(hardRestart)).toHaveBeenCalledTimes(8);
    expect(readRestartsLog(root, 'orchestrator')).not.toMatch(/HALTED:/);
  });
});
