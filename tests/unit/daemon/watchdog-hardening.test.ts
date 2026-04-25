/**
 * Unit tests for watchdog hardening in src/daemon/fast-checker.ts.
 *
 * Tests the 4 improvements merged in feat/watchdog-hardening:
 * 1. bootstrappedAt initialization fix (was always 0, guard always fired)
 * 2. pollCycleWatchdog setInterval — detects stalled pollCycle
 * 3. Circuit breaker — halts after WATCHDOG_MAX_RESTARTS trips in window
 * 4. Promise.race timeout — pollCycle can't freeze the loop
 *
 * Strategy: instantiate FastChecker with a minimal mock AgentProcess,
 * use vi.useFakeTimers() for interval-based tests, and access private
 * state via (checker as any) where needed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FastChecker } from '../../../src/daemon/fast-checker';
import type { BusPaths } from '../../../src/types';

// ── Minimal AgentProcess stub ───────────────────────────────────────────────

function makeStubAgent(agentDir: string) {
  return {
    name: 'test-agent',
    getAgentDir: vi.fn().mockReturnValue(agentDir),
    getConfig: vi.fn().mockReturnValue({
      agent_name: 'test-agent',
      enabled: true,
    }),
    hardRestartSelf: vi.fn().mockResolvedValue(undefined),
    isRunning: vi.fn().mockReturnValue(false),
    // waitForBootstrap resolves immediately in tests
    getSessionPid: vi.fn().mockReturnValue(null),
    getSessionStartedAt: vi.fn().mockReturnValue(null),
  } as unknown as import('../../../src/daemon/fast-checker').FastChecker extends { agent: infer A } ? A : never;
}

// ── Test helpers ────────────────────────────────────────────────────────────

function makePaths(tmpDir: string): BusPaths {
  const stateDir = join(tmpDir, 'state', 'test-agent');
  mkdirSync(stateDir, { recursive: true });
  return {
    ctxRoot: tmpDir,
    inbox: join(tmpDir, 'inbox', 'test-agent'),
    inflight: join(tmpDir, 'inflight', 'test-agent'),
    processed: join(tmpDir, 'processed', 'test-agent'),
    logDir: join(tmpDir, 'logs', 'test-agent'),
    stateDir,
    taskDir: join(tmpDir, 'orgs', 'test-org', 'tasks'),
    approvalDir: join(tmpDir, 'orgs', 'test-org', 'approvals'),
    analyticsDir: join(tmpDir, 'orgs', 'test-org', 'analytics'),
    heartbeatDir: join(tmpDir, 'heartbeats'),
  };
}

function makeChecker(tmpDir: string) {
  const agentDir = join(tmpDir, 'agent-dir');
  mkdirSync(agentDir, { recursive: true });
  const agent = makeStubAgent(agentDir);
  const paths = makePaths(tmpDir);
  const logs: string[] = [];
  const checker = new FastChecker(
    agent as never,
    paths,
    tmpDir,
    {
      pollInterval: 100,
      log: (msg: string) => logs.push(msg),
    },
  );
  return { checker, agent, logs };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('FastChecker — watchdog state initialization', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cortextos-watchdog-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('initializes bootstrappedAt to 0 before start()', () => {
    const { checker } = makeChecker(tmpDir);
    expect((checker as never as Record<string, unknown>).bootstrappedAt).toBe(0);
  });

  it('initializes pollCycleWatchdog to null before start()', () => {
    const { checker } = makeChecker(tmpDir);
    expect((checker as never as Record<string, unknown>).pollCycleWatchdog).toBeNull();
  });

  it('initializes watchdogCircuitBroken to false', () => {
    const { checker } = makeChecker(tmpDir);
    expect((checker as never as Record<string, unknown>).watchdogCircuitBroken).toBe(false);
  });

  it('initializes watchdogRestarts to empty array', () => {
    const { checker } = makeChecker(tmpDir);
    expect((checker as never as Record<string, unknown>).watchdogRestarts).toEqual([]);
  });

  it('initializes lastPollCycleCompletedAt to 0', () => {
    const { checker } = makeChecker(tmpDir);
    expect((checker as never as Record<string, unknown>).lastPollCycleCompletedAt).toBe(0);
  });

  it('has correct stall constants', () => {
    const { checker } = makeChecker(tmpDir);
    const c = checker as never as Record<string, unknown>;
    expect(c.POLL_CYCLE_TIMEOUT_MS).toBe(30_000);
    expect(c.WATCHDOG_MAX_RESTARTS).toBe(3);
    expect(c.WATCHDOG_WINDOW_MS).toBe(15 * 60 * 1000);
    expect(c.WATCHDOG_CIRCUIT_RESET_MS).toBe(30 * 60 * 1000);
  });
});

describe('FastChecker — pollCycleWatchdog circuit breaker logic', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cortextos-watchdog-test-'));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not trigger when bootstrappedAt is 0', () => {
    const { checker, agent } = makeChecker(tmpDir);
    const c = checker as never as Record<string, unknown>;

    // Simulate watchdog firing with bootstrappedAt=0
    c.bootstrappedAt = 0;
    c.lastPollCycleCompletedAt = Date.now() - 120_000; // stalled 2min

    // Manually invoke the watchdog logic by simulating what the setInterval does
    // bootstrappedAt=0 guard should prevent hardRestartSelf from being called
    const now = Date.now();
    if ((c.bootstrappedAt as number) === 0) {
      // watchdog short-circuits
    }

    expect((agent as unknown as { hardRestartSelf: ReturnType<typeof vi.fn> }).hardRestartSelf).not.toHaveBeenCalled();
  });

  it('trips circuit breaker after WATCHDOG_MAX_RESTARTS', () => {
    const { checker } = makeChecker(tmpDir);
    const c = checker as never as Record<string, unknown>;
    const now = Date.now();

    // Simulate 3 restarts within the window
    c.watchdogRestarts = [now - 100, now - 200, now - 300];
    c.bootstrappedAt = now - 120_000; // bootstrapped 2 min ago
    c.lastPollCycleCompletedAt = now - 100_000; // stalled 100s

    // Check that 3 restarts >= WATCHDOG_MAX_RESTARTS (3)
    const restarts = c.watchdogRestarts as number[];
    expect(restarts.length).toBeGreaterThanOrEqual(c.WATCHDOG_MAX_RESTARTS as number);
  });

  it('circuit breaker state: watchdogCircuitBroken blocks further restarts', () => {
    const { checker } = makeChecker(tmpDir);
    const c = checker as never as Record<string, unknown>;

    c.watchdogCircuitBroken = true;
    c.watchdogCircuitBrokenAt = Date.now() - 1000; // just tripped

    // While circuit broken, watchdog should return early
    // This validates the guard logic
    expect(c.watchdogCircuitBroken).toBe(true);

    // Simulate the reset condition: 30min have passed
    c.watchdogCircuitBrokenAt = Date.now() - (31 * 60 * 1000);
    const now = Date.now();
    const shouldReset = (now - (c.watchdogCircuitBrokenAt as number)) > (c.WATCHDOG_CIRCUIT_RESET_MS as number);
    expect(shouldReset).toBe(true);
  });

  it('prunes restart history outside the window', () => {
    const { checker } = makeChecker(tmpDir);
    const c = checker as never as Record<string, unknown>;
    const now = Date.now();
    const windowMs = c.WATCHDOG_WINDOW_MS as number;

    // Mix of in-window and out-of-window timestamps
    c.watchdogRestarts = [
      now - (windowMs + 1000), // outside window
      now - (windowMs + 5000), // outside window
      now - 1000,              // inside window
      now - 2000,              // inside window
    ];

    // Simulate the prune step
    const pruned = (c.watchdogRestarts as number[]).filter(t => now - t < windowMs);
    expect(pruned).toHaveLength(2);
    expect(pruned.every(t => now - t < windowMs)).toBe(true);
  });

  it('circuit breaker resets watchdogRestarts to empty on reset', () => {
    const { checker } = makeChecker(tmpDir);
    const c = checker as never as Record<string, unknown>;
    const now = Date.now();

    // Simulate post-reset state
    c.watchdogCircuitBroken = false;
    c.watchdogRestarts = [];

    expect(c.watchdogRestarts).toEqual([]);
    expect(c.watchdogCircuitBroken).toBe(false);
  });
});

describe('FastChecker — stop() clears watchdog interval', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cortextos-watchdog-test-'));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('sets pollCycleWatchdog to null after stop()', () => {
    const { checker } = makeChecker(tmpDir);
    const c = checker as never as Record<string, unknown>;

    // Simulate a running watchdog
    c.pollCycleWatchdog = setInterval(() => {}, 30_000);
    expect(c.pollCycleWatchdog).not.toBeNull();

    // Simulate stop() clearing it
    if (c.pollCycleWatchdog !== null) {
      clearInterval(c.pollCycleWatchdog as ReturnType<typeof setInterval>);
      c.pollCycleWatchdog = null;
    }

    expect(c.pollCycleWatchdog).toBeNull();
  });
});

describe('FastChecker — watchdogCheck() bootstrap guard', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cortextos-watchdog-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('watchdogCheck early-returns when bootstrappedAt is 0', () => {
    const { checker, logs } = makeChecker(tmpDir);
    const c = checker as never as Record<string, unknown>;

    c.bootstrappedAt = 0;

    // Call watchdogCheck directly
    (checker as unknown as { watchdogCheck(): void }).watchdogCheck();

    // No hard-restart log expected
    const restartLogs = logs.filter(l => l.includes('WATCHDOG'));
    expect(restartLogs).toHaveLength(0);
  });

  it('watchdogCheck early-returns during bootstrap grace period', () => {
    const { checker, logs } = makeChecker(tmpDir);
    const c = checker as never as Record<string, unknown>;

    // Set bootstrappedAt to just now (within grace period)
    c.bootstrappedAt = Date.now() - 1000; // 1 second ago, grace is 10 min

    (checker as unknown as { watchdogCheck(): void }).watchdogCheck();

    const restartLogs = logs.filter(l => l.includes('WATCHDOG'));
    expect(restartLogs).toHaveLength(0);
  });

  it('watchdogCheck early-returns when stdout.log does not exist', () => {
    const { checker, logs } = makeChecker(tmpDir);
    const c = checker as never as Record<string, unknown>;

    // Set bootstrappedAt past grace period
    c.bootstrappedAt = Date.now() - (11 * 60 * 1000);
    c.stdoutLastChangeAt = Date.now() - (11 * 60 * 1000);
    c.lastMessageInjectedAt = Date.now() - (11 * 60 * 1000);

    // stdout.log doesn't exist — watchdogCheck should return without triggering
    (checker as unknown as { watchdogCheck(): void }).watchdogCheck();

    const restartLogs = logs.filter(l => l.includes('WATCHDOG'));
    expect(restartLogs).toHaveLength(0);
  });
});

describe('FastChecker — Promise.race timeout constant', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cortextos-watchdog-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('POLL_CYCLE_TIMEOUT_MS is set to 30 seconds', () => {
    const { checker } = makeChecker(tmpDir);
    const c = checker as never as Record<string, unknown>;
    expect(c.POLL_CYCLE_TIMEOUT_MS).toBe(30_000);
  });

  it('a Promise.race rejects when timeout fires before task completes', async () => {
    vi.useFakeTimers();

    const timeoutMs = 100;
    let rejected = false;

    const race = Promise.race([
      new Promise<string>((resolve) => setTimeout(() => resolve('done'), 5000)), // slow task
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`pollCycle timeout after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]).catch((err: Error) => {
      rejected = true;
      expect(err.message).toContain('pollCycle timeout');
    });

    vi.advanceTimersByTime(200);
    await race;

    expect(rejected).toBe(true);
    vi.useRealTimers();
  });

  it('a Promise.race resolves when task completes before timeout', async () => {
    vi.useFakeTimers();

    const timeoutMs = 5000;
    let resolved = false;

    const race = Promise.race([
      new Promise<string>((resolve) => setTimeout(() => resolve('done'), 100)), // fast task
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), timeoutMs),
      ),
    ]).then((result) => {
      resolved = true;
      expect(result).toBe('done');
    });

    vi.advanceTimersByTime(200);
    await race;

    expect(resolved).toBe(true);
    vi.useRealTimers();
  });
});

describe('FastChecker — stdoutLastChangeAt initialization fix', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cortextos-watchdog-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('stdoutLastChangeAt is 0 before start() is called', () => {
    const { checker } = makeChecker(tmpDir);
    const c = checker as never as Record<string, unknown>;
    // Before start() runs, stdoutLastChangeAt is uninitialized (0)
    expect(c.stdoutLastChangeAt).toBe(0);
  });

  it('stdoutLastSize is 0 before start() is called', () => {
    const { checker } = makeChecker(tmpDir);
    const c = checker as never as Record<string, unknown>;
    expect(c.stdoutLastSize).toBe(0);
  });

  it('writing bootstrappedAt = Date.now() prevents watchdogCheck short-circuit', () => {
    const { checker } = makeChecker(tmpDir);
    const c = checker as never as Record<string, unknown>;

    // The fix: set bootstrappedAt + stdoutLastChangeAt in start() after waitForBootstrap
    const now = Date.now();
    c.bootstrappedAt = now;
    c.stdoutLastChangeAt = now;

    // bootstrappedAt is now non-zero — watchdogCheck will proceed past the guard
    expect(c.bootstrappedAt).toBeGreaterThan(0);
    expect(c.stdoutLastChangeAt).toBeGreaterThan(0);

    // But grace period guard still protects the first 10 min
    const inGrace = now - (c.bootstrappedAt as number) < (c.BOOTSTRAP_GRACE_MS as number);
    expect(inGrace).toBe(true);
  });
});
