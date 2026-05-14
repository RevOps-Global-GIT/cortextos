/**
 * Unit tests for the bus watchdog module.
 *
 * Tests cover:
 * - checkWatchdog marks agents as expired/ok based on heartbeat age vs lease
 * - Per-agent lease is read from config.json watchdog.lease_seconds
 * - pollWatchdog emits error events for expired agents only
 * - Missing/malformed config falls back to default lease
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BusPaths } from '../../../src/types/index.js';

// Mock fs before importing modules under test
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    readdirSync: vi.fn(),
    readFileSync: vi.fn(),
    existsSync: vi.fn(),
    appendFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

const { readdirSync, readFileSync, existsSync, appendFileSync } = await import('fs');
const { checkWatchdog, pollWatchdog, DEFAULT_LEASE_SECONDS } = await import('../../../src/bus/watchdog.js');

const mockReaddirSync = vi.mocked(readdirSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockExistsSync = vi.mocked(existsSync);
const mockAppendFileSync = vi.mocked(appendFileSync);

const FAKE_PATHS: BusPaths = {
  ctxRoot: '/fake/ctx',
  inbox: '/fake/ctx/inbox',
  inflight: '/fake/ctx/inflight',
  processed: '/fake/ctx/processed',
  logDir: '/fake/ctx/logs',
  stateDir: '/fake/ctx/state/dev',
  taskDir: '/fake/ctx/tasks',
  approvalDir: '/fake/ctx/approvals',
  analyticsDir: '/fake/ctx/analytics',
  deliverablesDir: '/fake/ctx/deliverables',
};

/** Build a heartbeat JSON string with a timestamp offset by `ageSeconds` ago */
function makeHeartbeat(agent: string, org: string, ageSeconds: number): string {
  const ts = new Date(Date.now() - ageSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return JSON.stringify({ agent, org, status: 'online', current_task: '', mode: 'day', loop_interval: '', last_heartbeat: ts });
}

beforeEach(() => {
  vi.resetAllMocks();

  // Default: state dir has two agents
  mockReaddirSync.mockImplementation((p, opts) => {
    const path = p.toString();
    if (path === '/fake/ctx/state') {
      if (opts && typeof opts === 'object' && 'withFileTypes' in opts) {
        return [
          { name: 'alpha', isDirectory: () => true },
          { name: 'beta', isDirectory: () => true },
        ] as ReturnType<typeof readdirSync>;
      }
      return ['alpha', 'beta'] as ReturnType<typeof readdirSync>;
    }
    return [] as ReturnType<typeof readdirSync>;
  });

  // Default: no per-agent config, heartbeat files present
  mockExistsSync.mockReturnValue(false);
  mockReadFileSync.mockImplementation((p: unknown) => {
    const path = p!.toString();
    if (path.includes('/state/alpha/heartbeat.json')) return makeHeartbeat('alpha', 'test-org', 1800); // 30m old
    if (path.includes('/state/beta/heartbeat.json')) return makeHeartbeat('beta', 'test-org', 18000); // 5h old
    return '';
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('checkWatchdog', () => {
  it('returns one result per agent', () => {
    const results = checkWatchdog(FAKE_PATHS);
    expect(results).toHaveLength(2);
    expect(results.map(r => r.agent).sort()).toEqual(['alpha', 'beta']);
  });

  it('marks agent as ok when age < lease', () => {
    // alpha is 30m old, default lease 4h = 14400s
    const results = checkWatchdog(FAKE_PATHS);
    const alpha = results.find(r => r.agent === 'alpha')!;
    expect(alpha.expired).toBe(false);
    expect(alpha.lease_seconds).toBe(DEFAULT_LEASE_SECONDS);
  });

  it('marks agent as expired when age > lease', () => {
    // beta is 5h old, default lease 4h
    const results = checkWatchdog(FAKE_PATHS);
    const beta = results.find(r => r.agent === 'beta')!;
    expect(beta.expired).toBe(true);
  });

  it('uses per-agent lease from config.json when projectRoot is provided', () => {
    // beta's config has a short 1h lease → still expired (5h > 1h)
    // alpha's config has a 6h lease → not expired (30m < 6h)
    mockExistsSync.mockImplementation((p: unknown) => {
      const path = p!.toString();
      return path.includes('config.json');
    });
    mockReadFileSync.mockImplementation((p: unknown) => {
      const path = p!.toString();
      if (path.includes('/state/alpha/heartbeat.json')) return makeHeartbeat('alpha', 'test-org', 1800);
      if (path.includes('/state/beta/heartbeat.json')) return makeHeartbeat('beta', 'test-org', 18000);
      if (path.includes('agents/alpha/config.json')) return JSON.stringify({ watchdog: { lease_seconds: 21600 } }); // 6h
      if (path.includes('agents/beta/config.json')) return JSON.stringify({ watchdog: { lease_seconds: 3600 } }); // 1h
      return '';
    });

    const results = checkWatchdog(FAKE_PATHS, { projectRoot: '/fake/project' });
    const alpha = results.find(r => r.agent === 'alpha')!;
    const beta = results.find(r => r.agent === 'beta')!;

    expect(alpha.lease_seconds).toBe(21600);
    expect(alpha.expired).toBe(false);
    expect(beta.lease_seconds).toBe(3600);
    expect(beta.expired).toBe(true);
  });

  it('falls back to defaultLeaseSeconds when config.json is missing', () => {
    const results = checkWatchdog(FAKE_PATHS, { projectRoot: '/fake/project', defaultLeaseSeconds: 7200 });
    for (const r of results) {
      expect(r.lease_seconds).toBe(7200);
    }
  });

  it('falls back to default when config.json has no watchdog field', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation((p: unknown) => {
      const path = p!.toString();
      if (path.includes('/state/alpha/heartbeat.json')) return makeHeartbeat('alpha', 'test-org', 1800);
      if (path.includes('/state/beta/heartbeat.json')) return makeHeartbeat('beta', 'test-org', 18000);
      // config.json exists but has no watchdog key
      if (path.includes('config.json')) return JSON.stringify({ agent_name: 'test' });
      return '';
    });

    const results = checkWatchdog(FAKE_PATHS, { projectRoot: '/fake/project' });
    for (const r of results) {
      expect(r.lease_seconds).toBe(DEFAULT_LEASE_SECONDS);
    }
  });
});

describe('pollWatchdog', () => {
  it('returns results identical to checkWatchdog', () => {
    const check = checkWatchdog(FAKE_PATHS);
    const poll = pollWatchdog(FAKE_PATHS, 'orchestrator', 'test-org');
    expect(poll.map(r => r.agent)).toEqual(check.map(r => r.agent));
    expect(poll.map(r => r.expired)).toEqual(check.map(r => r.expired));
  });

  it('emits an event only for expired agents', () => {
    mockExistsSync.mockReturnValue(true);

    pollWatchdog(FAKE_PATHS, 'orchestrator', 'test-org');

    // beta is expired → one agent_lease_expired event appended
    const calls = mockAppendFileSync.mock.calls;
    const expiredEvents = calls.filter(([, data]) =>
      typeof data === 'string' && data.includes('agent_lease_expired'),
    );
    expect(expiredEvents).toHaveLength(1);
    expect(expiredEvents[0][1]).toContain('"expired_agent":"beta"');
  });
});
