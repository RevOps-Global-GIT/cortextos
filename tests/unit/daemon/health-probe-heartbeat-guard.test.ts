import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock the PTY layer so we don't load native bindings or spawn real processes.
vi.mock('../../../src/daemon/agent-process.js', () => ({
  AgentProcess: class {
    name: string;
    dir: string;
    constructor(name: string, dir: string) {
      this.name = name;
      this.dir = dir;
    }
    async start() { /* no-op */ }
    async stop() { /* no-op */ }
    getStatus() { return { name: this.name, status: 'running' }; }
    onExit() { /* no-op */ }
  },
}));

vi.mock('../../../src/daemon/fast-checker.js', () => ({
  FastChecker: class {
    start() { /* no-op */ }
    stop() { /* no-op */ }
    wake() { /* no-op */ }
  },
}));

vi.mock('../../../src/telegram/api.js', () => ({
  TelegramAPI: class {
    constructor() { /* no-op */ }
  },
}));

vi.mock('../../../src/telegram/poller.js', () => ({
  TelegramPoller: class {
    start() { /* no-op */ }
    stop() { /* no-op */ }
  },
}));

const { AgentManager } = await import('../../../src/daemon/agent-manager.js');

describe('checkProbeAck heartbeat-freshness guard', () => {
  let testDir: string;
  let ctxRoot: string;
  let frameworkRoot: string;
  let am: InstanceType<typeof AgentManager>;
  let restartSpy: ReturnType<typeof vi.spyOn>;

  const AGENT = 'alice';
  const PROBE_ID = 'health-probe-alice-1234567890';
  let stateDir: string;
  let probeFile: string;

  function writeProbePending(): void {
    writeFileSync(
      probeFile,
      JSON.stringify({ probe_id: PROBE_ID, sent_at: new Date().toISOString(), status: 'pending' }),
    );
  }

  function writeHeartbeat(ageMs: number): void {
    writeFileSync(
      join(stateDir, 'heartbeat.json'),
      JSON.stringify({ last_heartbeat: new Date(Date.now() - ageMs).toISOString() }),
    );
  }

  async function runCheck(): Promise<void> {
    // checkProbeAck is private — invoked directly to test the guard in isolation.
    await (am as unknown as {
      checkProbeAck(agentName: string, probeId: string, probeFile: string): Promise<void>;
    }).checkProbeAck(AGENT, PROBE_ID, probeFile);
  }

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-probe-guard-test-'));
    ctxRoot = join(testDir, 'instance');
    frameworkRoot = join(testDir, 'framework');
    stateDir = join(ctxRoot, 'state', AGENT);
    probeFile = join(stateDir, 'health-probe.json');
    mkdirSync(stateDir, { recursive: true });

    am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
    // Register a fake running agent so checkProbeAck doesn't early-return.
    (am as unknown as { agents: Map<string, unknown> }).agents.set(AGENT, {
      process: { getStatus: () => ({ name: AGENT, status: 'running' }) },
    });
    restartSpy = vi.spyOn(am as unknown as { restartAgent(name: string): Promise<void> }, 'restartAgent')
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('skips restart and writes missed_busy when heartbeat is fresh', async () => {
    writeProbePending();
    writeHeartbeat(2 * 60 * 1000); // 2 minutes old — fresh

    await runCheck();

    expect(restartSpy).not.toHaveBeenCalled();
    const probe = JSON.parse(readFileSync(probeFile, 'utf-8'));
    expect(probe.status).toBe('missed_busy');
    expect(probe.probe_id).toBe(PROBE_ID);
    expect(probe.failed_at).toBeTruthy();
  });

  it('restarts when heartbeat is stale (older than 10 min)', async () => {
    writeProbePending();
    writeHeartbeat(15 * 60 * 1000); // 15 minutes old — stale

    await runCheck();

    expect(restartSpy).toHaveBeenCalledTimes(1);
    expect(restartSpy).toHaveBeenCalledWith(AGENT);
    const probe = JSON.parse(readFileSync(probeFile, 'utf-8'));
    expect(probe.status).toBe('degraded');
  });

  it('restarts when heartbeat.json is absent', async () => {
    writeProbePending();
    // no heartbeat.json written

    await runCheck();

    expect(restartSpy).toHaveBeenCalledTimes(1);
    const probe = JSON.parse(readFileSync(probeFile, 'utf-8'));
    expect(probe.status).toBe('degraded');
  });

  it('restarts when heartbeat.json is malformed', async () => {
    writeProbePending();
    writeFileSync(join(stateDir, 'heartbeat.json'), 'not-json{{{');

    await runCheck();

    expect(restartSpy).toHaveBeenCalledTimes(1);
    const probe = JSON.parse(readFileSync(probeFile, 'utf-8'));
    expect(probe.status).toBe('degraded');
  });

  it('does not restart when the probe was acked, regardless of heartbeat', async () => {
    writeFileSync(
      probeFile,
      JSON.stringify({ probe_id: PROBE_ID, status: 'acked', acked_at: new Date().toISOString() }),
    );
    writeHeartbeat(15 * 60 * 1000);

    await runCheck();

    expect(restartSpy).not.toHaveBeenCalled();
  });
});
