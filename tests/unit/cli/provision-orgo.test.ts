/**
 * Unit tests for `cortextos provision-orgo`.
 *
 * All HTTP calls are mocked via vi.stubGlobal('fetch', ...).
 * No real Orgo API calls are made.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { provisionOrgoCommand } from '../../../src/cli/provision-orgo';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockFetch(responses: Array<{ ok: boolean; status?: number; json?: unknown; text?: string }>) {
  let callIndex = 0;
  return vi.fn().mockImplementation(async () => {
    const resp = responses[callIndex] ?? responses[responses.length - 1];
    callIndex++;
    return {
      ok: resp.ok,
      status: resp.status ?? (resp.ok ? 200 : 500),
      json: async () => resp.json ?? {},
      text: async () => resp.text ?? JSON.stringify(resp.json ?? {}),
    };
  });
}

// Capture process.exit without actually exiting
function mockExit() {
  return vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`__EXIT_${code}__`);
  }) as never);
}

// Silence console output during tests
function silenceConsole() {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
}

// Minimal exec response: Python script printed a valid JSON line
function execSuccess(exitCode = 0, stdoutTail = '[provision] Install complete.') {
  return {
    ok: true,
    json: {
      success: true,
      output: JSON.stringify({ exit_code: exitCode, stdout_tail: stdoutTail, stderr_tail: '' }),
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('provision-orgo — option validation', () => {
  let exitSpy: ReturnType<typeof mockExit>;

  beforeEach(() => {
    exitSpy = mockExit();
    silenceConsole();
    vi.stubGlobal('fetch', mockFetch([]));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('exits 1 when neither --computer nor --create is provided', async () => {
    await expect(
      provisionOrgoCommand.parseAsync(['node', 'cli', '--api-key', 'test-key'])
    ).rejects.toThrow('__EXIT_1__');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits 1 when --create is used without --workspace', async () => {
    await expect(
      provisionOrgoCommand.parseAsync(['node', 'cli', '--api-key', 'test-key', '--create'])
    ).rejects.toThrow('__EXIT_1__');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits 1 when --computer and --create are both provided', async () => {
    await expect(
      provisionOrgoCommand.parseAsync([
        'node', 'cli',
        '--api-key', 'test-key',
        '--computer', 'vm-abc',
        '--create',
        '--workspace', 'ws-1',
      ])
    ).rejects.toThrow('__EXIT_1__');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('provision-orgo — existing computer path (--computer)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let exitSpy: ReturnType<typeof mockExit>;

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('runs the installer and exits 0 on success', async () => {
    exitSpy = mockExit();
    silenceConsole();

    fetchMock = mockFetch([execSuccess()]);
    vi.stubGlobal('fetch', fetchMock);

    await provisionOrgoCommand.parseAsync([
      'node', 'cli',
      '--api-key', 'orgo-key-abc',
      '--computer', 'vm-xyz',
      '--agent-name', 'dev',
    ]);

    // fetch called once: POST computers/vm-xyz/exec
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('computers/vm-xyz/exec');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer orgo-key-abc');

    // no exit called (success path)
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('exits 1 when the installer exits non-zero', async () => {
    exitSpy = mockExit();
    silenceConsole();

    fetchMock = mockFetch([execSuccess(1, '')]);
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      provisionOrgoCommand.parseAsync([
        'node', 'cli',
        '--api-key', 'orgo-key-abc',
        '--computer', 'vm-xyz',
      ])
    ).rejects.toThrow('__EXIT_1__');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits 1 on Orgo API HTTP error', async () => {
    exitSpy = mockExit();
    silenceConsole();

    fetchMock = mockFetch([{ ok: false, status: 401, text: 'Unauthorized' }]);
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      provisionOrgoCommand.parseAsync([
        'node', 'cli',
        '--api-key', 'bad-key',
        '--computer', 'vm-xyz',
      ])
    ).rejects.toThrow('__EXIT_1__');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('provision-orgo — create new computer path (--create)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let exitSpy: ReturnType<typeof mockExit>;

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('resolves workspace by name and creates computer, then installs', async () => {
    exitSpy = mockExit();
    silenceConsole();

    // Stub setTimeout so the 15s wait is instant
    vi.useFakeTimers();

    fetchMock = mockFetch([
      // GET /api/projects
      {
        ok: true,
        json: {
          projects: [
            { id: 'ws-001', name: 'RevOps Global', desktops: [] },
          ],
        },
      },
      // POST /api/computers
      {
        ok: true,
        json: { id: 'vm-new-001', name: 'dev-agent-vm', status: 'creating' },
      },
      // POST /api/computers/vm-new-001/exec
      execSuccess().json,
    ]);
    // The third call returns execSuccess directly — fix:
    fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          projects: [{ id: 'ws-001', name: 'RevOps Global', desktops: [] }],
        }),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'vm-new-001', name: 'dev-agent-vm', status: 'creating' }),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          output: JSON.stringify({ exit_code: 0, stdout_tail: '[provision] Install complete.', stderr_tail: '' }),
        }),
        text: async () => '',
      });
    vi.stubGlobal('fetch', fetchMock);

    const parsePromise = provisionOrgoCommand.parseAsync([
      'node', 'cli',
      '--api-key', 'orgo-key',
      '--workspace', 'RevOps Global',
      '--create', 'dev-agent-vm',
      '--agent-name', 'dev',
    ]);

    // Fast-forward the 15s VM boot wait
    await vi.runAllTimersAsync();
    await parsePromise;

    vi.useRealTimers();

    // 3 fetch calls: projects, create computer, exec
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const [projectsUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(projectsUrl).toContain('projects');

    const [computersUrl, computersInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(computersUrl).toContain('computers');
    const createBody = JSON.parse(computersInit.body as string);
    expect(createBody.workspace_id).toBe('ws-001');
    expect(createBody.name).toBe('dev-agent-vm');

    const [execUrl] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(execUrl).toContain('computers/vm-new-001/exec');

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('exits 1 when workspace is not found', async () => {
    exitSpy = mockExit();
    silenceConsole();

    fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ projects: [{ id: 'ws-001', name: 'Other Workspace', desktops: [] }] }),
      text: async () => '',
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      provisionOrgoCommand.parseAsync([
        'node', 'cli',
        '--api-key', 'orgo-key',
        '--workspace', 'Nonexistent Workspace',
        '--create',
        '--agent-name', 'dev',
      ])
    ).rejects.toThrow('__EXIT_1__');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('provision-orgo — Python exec payload structure', () => {
  it('embeds base64-encoded bash source in the Python code', async () => {
    // Access the internal builder via a light integration: parse the exec
    // body from the fetch call and verify the Python structure.
    const exitSpy = mockExit();
    silenceConsole();

    let capturedBody: { code: string; timeout: number } | null = null;
    const fetchMock = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string) as { code: string; timeout: number };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          output: JSON.stringify({ exit_code: 0, stdout_tail: 'ok', stderr_tail: '' }),
        }),
        text: async () => '',
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    await provisionOrgoCommand.parseAsync([
      'node', 'cli',
      '--api-key', 'key',
      '--computer', 'vm-1',
    ]);

    expect(capturedBody).not.toBeNull();
    expect(capturedBody!.code).toContain('import base64');
    expect(capturedBody!.code).toContain('import subprocess');
    expect(capturedBody!.code).toContain('json.dumps');
    // Python timeout is less than client-side (265 vs 270s)
    expect(capturedBody!.timeout).toBe(265);

    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    void exitSpy;
  });
});
