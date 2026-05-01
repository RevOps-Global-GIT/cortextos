import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  escalate,
  escalateCritical,
  escalateHigh,
  escalateMedium,
  initEscalate,
  _resetEscalate,
  type EscalateConfig,
  type TelegramLike,
} from '../../../src/utils/escalate';
import type { BusPaths } from '../../../src/types/index';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makePaths(): BusPaths {
  return {
    ctxRoot: '/tmp/test',
    inbox: '/tmp/test/inbox',
    inflight: '/tmp/test/inflight',
    processed: '/tmp/test/processed',
    logDir: '/tmp/test/logs',
    stateDir: '/tmp/test/state',
    taskDir: '/tmp/test/tasks',
    approvalDir: '/tmp/test/approvals',
    analyticsDir: '/tmp/test/analytics',
    deliverablesDir: '/tmp/test/deliverables',
  };
}

function makeTelegramMock(): TelegramLike & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    sendMessage: vi.fn(async (chatId: string, text: string) => {
      calls.push(text);
    }) as TelegramLike['sendMessage'],
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

// Mock logEvent so we can assert calls without touching the filesystem
vi.mock('../../../src/bus/event.js', () => ({
  logEvent: vi.fn(),
}));

import { logEvent } from '../../../src/bus/event.js';
const mockLogEvent = vi.mocked(logEvent);

beforeEach(() => {
  vi.clearAllMocks();
  _resetEscalate();
});

afterEach(() => {
  _resetEscalate();
});

// ---------------------------------------------------------------------------
// Before initEscalate
// ---------------------------------------------------------------------------

describe('before initEscalate()', () => {
  it('level=low calls console.warn, no logEvent', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    escalate({ context: 'test', err: new Error('oops'), level: 'low' });
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(mockLogEvent).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('level=medium calls console.error but not logEvent (pre-init)', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    escalate({ context: 'test', err: new Error('oops'), level: 'medium' });
    expect(errSpy).toHaveBeenCalledOnce();
    expect(mockLogEvent).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('does not throw when called before init', () => {
    expect(() => escalateCritical('boot error', new Error('too early'))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// After initEscalate
// ---------------------------------------------------------------------------

describe('after initEscalate()', () => {
  let tg: TelegramLike & { calls: string[] };
  let config: EscalateConfig;

  beforeEach(() => {
    tg = makeTelegramMock();
    config = {
      paths: makePaths(),
      agentName: 'dev',
      org: 'revops-global',
      telegramApi: tg,
      telegramChatId: '12345',
    };
    initEscalate(config);
  });

  // --- level=low ---

  it('level=low calls console.warn, no logEvent, no Telegram', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    escalate({ context: 'ctx', err: 'minor', level: 'low' });
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(mockLogEvent).not.toHaveBeenCalled();
    expect(tg.sendMessage).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  // --- level=medium ---

  it('level=medium calls logEvent with severity=warn', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    escalate({ context: 'db-write', err: new Error('timeout'), level: 'medium' });
    expect(mockLogEvent).toHaveBeenCalledOnce();
    const [, , , category, eventName, severity] = mockLogEvent.mock.calls[0];
    expect(category).toBe('error');
    expect(eventName).toBe('system_error');
    expect(severity).toBe('warn');
    expect(tg.sendMessage).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  // --- level=high ---

  it('level=high calls logEvent with severity=error, no Telegram', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    escalate({ context: 'ipc-start', err: new Error('fail'), level: 'high' });
    expect(mockLogEvent).toHaveBeenCalledOnce();
    const [, , , , , severity] = mockLogEvent.mock.calls[0];
    expect(severity).toBe('error');
    expect(tg.sendMessage).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  // --- level=critical ---

  it('level=critical calls logEvent + Telegram', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    escalate({ context: 'drain-loop', err: new Error('supabase down'), level: 'critical' });
    expect(mockLogEvent).toHaveBeenCalledOnce();
    // Telegram call is fire-and-forget — give microtask queue time to flush
    await vi.waitFor(() => expect(tg.sendMessage).toHaveBeenCalledOnce());
    const callArgs = vi.mocked(tg.sendMessage).mock.calls[0];
    expect(callArgs[0]).toBe('12345');
    expect(callArgs[1]).toContain('CRITICAL');
    expect(callArgs[1]).toContain('drain-loop');
    errSpy.mockRestore();
  });

  it('level=critical with telegramApi=null → no throw, no Telegram', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    initEscalate({ ...config, telegramApi: null });
    expect(() => escalateCritical('drain-loop', new Error('fail'))).not.toThrow();
    expect(mockLogEvent).toHaveBeenCalledOnce();
    errSpy.mockRestore();
  });

  it('Telegram sendMessage throws → escalate does not throw', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failingTg: TelegramLike = {
      sendMessage: vi.fn().mockRejectedValue(new Error('network error')),
    };
    initEscalate({ ...config, telegramApi: failingTg });
    expect(() => escalateCritical('drain', new Error('err'))).not.toThrow();
    // Let the rejected promise settle — should not produce unhandled rejection
    await new Promise(r => setTimeout(r, 10));
    errSpy.mockRestore();
  });

  // --- err type handling ---

  it('err as string → message extracted cleanly', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    escalate({ context: 'ctx', err: 'plain string error', level: 'medium' });
    const metadata = mockLogEvent.mock.calls[0][6] as Record<string, unknown>;
    expect(metadata.message).toBe('plain string error');
    errSpy.mockRestore();
  });

  it('err as Error → message extracted cleanly', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    escalate({ context: 'ctx', err: new Error('typed error'), level: 'medium' });
    const metadata = mockLogEvent.mock.calls[0][6] as Record<string, unknown>;
    expect(metadata.message).toBe('typed error');
    errSpy.mockRestore();
  });

  it('err as unknown object → message extracted without throw', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => escalate({ context: 'ctx', err: { code: 42 }, level: 'medium' })).not.toThrow();
    errSpy.mockRestore();
  });

  // --- meta forwarded ---

  it('meta is forwarded to logEvent metadata', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    escalate({ context: 'ctx', err: new Error('e'), level: 'high', meta: { queue: 'tasks', retry: 3 } });
    const metadata = mockLogEvent.mock.calls[0][6] as Record<string, unknown>;
    expect(metadata.queue).toBe('tasks');
    expect(metadata.retry).toBe(3);
    errSpy.mockRestore();
  });

  // --- convenience shorthands ---

  it('escalateCritical is a shorthand for level=critical', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    escalateCritical('ctx', new Error('e'), { source: 'test' });
    const [, , , , , severity, meta] = mockLogEvent.mock.calls[0];
    expect(severity).toBe('error');
    expect((meta as Record<string, unknown>).source).toBe('test');
    errSpy.mockRestore();
  });

  it('escalateHigh is a shorthand for level=high', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    escalateHigh('ctx', new Error('e'));
    const [, , , , , severity] = mockLogEvent.mock.calls[0];
    expect(severity).toBe('error');
    expect(tg.sendMessage).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('escalateMedium is a shorthand for level=medium', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    escalateMedium('ctx', new Error('e'));
    const [, , , , , severity] = mockLogEvent.mock.calls[0];
    expect(severity).toBe('warn');
    errSpy.mockRestore();
  });
});
