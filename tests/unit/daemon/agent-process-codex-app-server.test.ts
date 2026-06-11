import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let capturedOnExit: ((exitCode: number, signal?: number) => void) | null = null;
const TEST_PTY_PID = 424243;

const mockCodexAppServerPty = {
  spawn: vi.fn().mockResolvedValue(undefined),
  kill: vi.fn(),
  write: vi.fn(),
  getPid: vi.fn().mockReturnValue(TEST_PTY_PID), // LIVE fake pid so spawn-verify's isPidAlive() passes
  isAlive: vi.fn().mockReturnValue(true),
  onExit: vi.fn().mockImplementation((cb: (exitCode: number, signal?: number) => void) => {
    capturedOnExit = cb;
  }),
  getOutputBuffer: vi.fn().mockReturnValue({ isBootstrapped: vi.fn().mockReturnValue(true) }),
  setTelegramHandle: vi.fn(),
};

const mockAgentPty = {
  ...mockCodexAppServerPty,
  setTelegramHandle: undefined,
};

vi.mock('../../../src/pty/agent-pty.js', () => ({
  AgentPTY: function AgentPTY() { return mockAgentPty; },
}));

vi.mock('../../../src/pty/codex-app-server-pty.js', () => ({
  CodexAppServerPTY: function CodexAppServerPTY() { return mockCodexAppServerPty; },
}));

vi.mock('../../../src/pty/hermes-pty.js', () => ({
  HermesPTY: function HermesPTY() { return mockAgentPty; },
  hermesDbExists: vi.fn().mockReturnValue(false),
}));

const mockInjectMessage = vi.fn();
vi.mock('../../../src/pty/inject.js', () => ({
  injectMessage: mockInjectMessage,
  MessageDedup: class { isDuplicate() { return false; } },
}));

vi.mock('../../../src/utils/atomic.js', () => ({
  ensureDir: vi.fn(),
  atomicWriteSync: vi.fn(),
}));

vi.mock('../../../src/utils/env.js', () => ({
  writeCortextosEnv: vi.fn(),
  resolveEnv: vi.fn().mockReturnValue({ instanceId: 'test', ctxRoot: '/tmp/test' }),
}));

vi.mock('../../../src/bus/reminders.js', () => ({
  getOverdueReminders: vi.fn().mockReturnValue([]),
}));

vi.mock('../../../src/utils/paths.js', () => ({
  resolvePaths: vi.fn().mockReturnValue({}),
  resolveAgentCwd: vi.fn((agentDir, override) => (override?.trim() || agentDir || process.cwd())),
  isAgentDirScaffolded: vi.fn().mockReturnValue(true),
}));

const fsMocks = {
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  appendFileSync: vi.fn(),
  statSync: vi.fn(),
};

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    mkdirSync: vi.fn(),
    get existsSync() { return fsMocks.existsSync; },
    get readFileSync() { return fsMocks.readFileSync; },
    get writeFileSync() { return fsMocks.writeFileSync; },
    get appendFileSync() { return fsMocks.appendFileSync; },
    get statSync() { return fsMocks.statSync; },
  };
});
const { AgentProcess } = await import('../../../src/daemon/agent-process.js');

const mockEnv = {
  instanceId: 'test',
  ctxRoot: '/tmp/test-ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'codex-app-agent',
  agentDir: '/tmp/fw/orgs/acme/agents/codex-app-agent',
  org: 'acme',
  projectRoot: '/tmp/fw',
};

beforeEach(() => {
  vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | 0) => {
    if (signal === 0 && pid !== TEST_PTY_PID) {
      const err = new Error('no such process') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    }
    return true;
  }) as typeof process.kill);
  capturedOnExit = null;
  for (const pty of [mockCodexAppServerPty, mockAgentPty]) {
    pty.spawn.mockClear();
    pty.kill.mockClear();
    pty.write.mockClear();
    pty.getPid.mockClear();
    pty.isAlive.mockReset().mockReturnValue(true);
    pty.onExit.mockClear();
    pty.getOutputBuffer.mockClear();
  }
  mockCodexAppServerPty.setTelegramHandle.mockClear();
  mockInjectMessage.mockClear();
  fsMocks.existsSync.mockReset().mockReturnValue(false);
  fsMocks.readFileSync.mockReset();
  fsMocks.writeFileSync.mockReset();
  fsMocks.appendFileSync.mockReset();
  fsMocks.statSync.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AgentProcess codex-app-server runtime', () => {
  it('selects CodexAppServerPTY for runtime codex-app-server', async () => {
    const ap = new AgentProcess('codex-app-agent', mockEnv, { runtime: 'codex-app-server' });
    await ap.start();

    expect(mockCodexAppServerPty.spawn).toHaveBeenCalledWith('fresh', expect.any(String));
    expect(ap.getStatus().pid).toBe(TEST_PTY_PID); // mock getPid -> live fake pid (spawn-verify)
  });

  it('wires Telegram handle to CodexAppServerPTY before start', async () => {
    const ap = new AgentProcess('codex-app-agent', mockEnv, { runtime: 'codex-app-server' });
    const api = { sendChatAction: vi.fn().mockResolvedValue(undefined) };

    ap.setTelegramHandle(api as any, '12345');
    await ap.start();

    expect(mockCodexAppServerPty.setTelegramHandle).toHaveBeenCalledWith(api, '12345');
  });

  it('uses direct kill path on stop, not Claude /exit choreography', async () => {
    const ap = new AgentProcess('codex-app-agent', mockEnv, { runtime: 'codex-app-server' });
    await ap.start();
    expect(capturedOnExit).not.toBeNull();

    const stopPromise = ap.stop();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const writes = mockCodexAppServerPty.write.mock.calls.map((call: string[]) => call[0]);
    expect(writes).not.toContain('\x03');
    expect(writes).not.toContain('/exit\r\n');

    capturedOnExit!(0, 0);
    await stopPromise;
    expect(mockCodexAppServerPty.kill).toHaveBeenCalled();
  }, 10000);
});
