import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { TelegramPoller } from '../../../src/telegram/poller';
import type { TelegramAPI } from '../../../src/telegram/api';
import type { TelegramUpdate } from '../../../src/types/index';

function makeMessageUpdate(updateId: number, text: string): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: 1, type: 'private' },
      text,
    },
  };
}

function makeCallbackUpdate(updateId: number, data: string): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: String(updateId),
      from: { id: 1, is_bot: false, first_name: 'test' },
      data,
    } as any,
  };
}

function makeStubApi(updates: TelegramUpdate[]): { api: TelegramAPI; calls: number[] } {
  const calls: number[] = [];
  const api = {
    getUpdates: vi.fn(async (offset: number) => {
      calls.push(offset);
      const remaining = updates.filter((u) => u.update_id >= offset);
      return { result: remaining };
    }),
  } as unknown as TelegramAPI;
  return { api, calls };
}

describe('TelegramPoller — offset-after-handler', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'cortextos-poller-'));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('advances offset only after message handler succeeds', async () => {
    const { api } = makeStubApi([makeMessageUpdate(100, 'hello')]);
    const poller = new TelegramPoller(api, stateDir);

    const received: string[] = [];
    poller.onMessage((msg) => {
      received.push(msg.text ?? '');
    });

    await poller.pollOnce();

    expect(received).toEqual(['hello']);
    const persisted = readFileSync(join(stateDir, '.telegram-offset'), 'utf-8').trim();
    expect(persisted).toBe('101');
  });

  it('does NOT advance offset if a message handler throws', async () => {
    const { api } = makeStubApi([makeMessageUpdate(200, 'boom')]);
    const poller = new TelegramPoller(api, stateDir);

    poller.onMessage(() => {
      throw new Error('inject failed');
    });

    // Handler errors are caught internally — pollOnce should not throw.
    await expect(poller.pollOnce()).resolves.toBeUndefined();

    // Offset file must not exist (or must still be 0) — update should redeliver.
    const offsetFile = join(stateDir, '.telegram-offset');
    if (existsSync(offsetFile)) {
      const persisted = readFileSync(offsetFile, 'utf-8').trim();
      expect(persisted).toBe('0');
    }
  });

  it('halts the batch on failure to preserve ordering', async () => {
    const { api } = makeStubApi([
      makeMessageUpdate(10, 'first'),
      makeMessageUpdate(11, 'second-will-fail'),
      makeMessageUpdate(12, 'third'),
    ]);
    const poller = new TelegramPoller(api, stateDir);

    const received: string[] = [];
    poller.onMessage((msg) => {
      received.push(msg.text ?? '');
      if (msg.text === 'second-will-fail') {
        throw new Error('inject failed');
      }
    });

    await poller.pollOnce();

    // First succeeded, second threw, third MUST NOT have run.
    expect(received).toEqual(['first', 'second-will-fail']);

    // Offset should be advanced past the first (11) but not past the second.
    const persisted = readFileSync(join(stateDir, '.telegram-offset'), 'utf-8').trim();
    expect(persisted).toBe('11');
  });

  it('persists offset per-update so a mid-batch crash preserves confirmed state', async () => {
    const { api } = makeStubApi([
      makeMessageUpdate(50, 'a'),
      makeMessageUpdate(51, 'b'),
      makeMessageUpdate(52, 'c'),
    ]);
    const poller = new TelegramPoller(api, stateDir);

    const offsetsSeenDuringHandling: string[] = [];
    poller.onMessage(() => {
      // Read the persisted file mid-batch to prove per-update persistence.
      const f = join(stateDir, '.telegram-offset');
      offsetsSeenDuringHandling.push(existsSync(f) ? readFileSync(f, 'utf-8').trim() : 'none');
    });

    await poller.pollOnce();

    // Before processing 50, nothing persisted. Before 51, 51 persisted. Before 52, 52 persisted.
    expect(offsetsSeenDuringHandling).toEqual(['none', '51', '52']);

    const persisted = readFileSync(join(stateDir, '.telegram-offset'), 'utf-8').trim();
    expect(persisted).toBe('53');
  });

  it('advances offset only after callback handler succeeds', async () => {
    const { api } = makeStubApi([makeCallbackUpdate(300, 'approve')]);
    const poller = new TelegramPoller(api, stateDir);

    const received: string[] = [];
    poller.onCallback((cb) => {
      received.push(cb.data ?? '');
    });

    await poller.pollOnce();

    expect(received).toEqual(['approve']);
    const persisted = readFileSync(join(stateDir, '.telegram-offset'), 'utf-8').trim();
    expect(persisted).toBe('301');
  });

  it('does NOT advance offset if a callback handler throws', async () => {
    const { api } = makeStubApi([makeCallbackUpdate(400, 'deny')]);
    const poller = new TelegramPoller(api, stateDir);

    poller.onCallback(() => {
      throw new Error('callback broke');
    });

    await poller.pollOnce();

    const offsetFile = join(stateDir, '.telegram-offset');
    if (existsSync(offsetFile)) {
      const persisted = readFileSync(offsetFile, 'utf-8').trim();
      expect(persisted).toBe('0');
    }
  });

  it('routes message_reaction updates to registered reaction handlers and advances offset', async () => {
    const reactionUpdate: TelegramUpdate = {
      update_id: 500,
      message_reaction: {
        chat: { id: 42, type: 'private' },
        user: { id: 7, first_name: 'alice' },
        message_id: 123,
        date: 1700000000,
        old_reaction: [],
        new_reaction: [{ type: 'emoji', emoji: '👍' }],
      },
    };
    const { api } = makeStubApi([reactionUpdate]);
    const poller = new TelegramPoller(api, stateDir);

    const received: Array<{ msgId: number; emoji: string }> = [];
    poller.onReaction((r) => {
      const emoji = r.new_reaction[0]?.type === 'emoji' ? r.new_reaction[0].emoji : '?';
      received.push({ msgId: r.message_id, emoji });
    });

    await poller.pollOnce();

    expect(received).toEqual([{ msgId: 123, emoji: '👍' }]);
    const persisted = readFileSync(join(stateDir, '.telegram-offset'), 'utf-8').trim();
    expect(persisted).toBe('501');
  });

  it('does NOT advance offset if a reaction handler throws', async () => {
    const reactionUpdate: TelegramUpdate = {
      update_id: 600,
      message_reaction: {
        chat: { id: 42, type: 'private' },
        user: { id: 7, first_name: 'alice' },
        message_id: 999,
        date: 1700000000,
        old_reaction: [],
        new_reaction: [{ type: 'emoji', emoji: '🔥' }],
      },
    };
    const { api } = makeStubApi([reactionUpdate]);
    const poller = new TelegramPoller(api, stateDir);

    poller.onReaction(() => { throw new Error('reaction broke'); });

    await poller.pollOnce();

    const offsetFile = join(stateDir, '.telegram-offset');
    if (existsSync(offsetFile)) {
      const persisted = readFileSync(offsetFile, 'utf-8').trim();
      expect(persisted).toBe('0');
    }
  });
});

describe('TelegramPoller — atomic offset persistence', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'cortextos-poller-atomic-'));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('offset file is never empty or corrupt after a successful poll', async () => {
    // Simulates a restart mid-poll: after pollOnce() completes, a new poller
    // instance reads the persisted offset file and must see a valid integer.
    // A non-atomic writeFileSync can leave a zero-byte file if the process
    // dies between open() and write(), causing the restarted poller to read
    // '' → NaN → reset to 0 and re-deliver already-processed messages.
    const { api } = makeStubApi([makeMessageUpdate(700, 'atomic-test')]);
    const poller = new TelegramPoller(api, stateDir);
    poller.onMessage(() => { /* no-op */ });
    await poller.pollOnce();

    const offsetFile = join(stateDir, '.telegram-offset');
    expect(existsSync(offsetFile)).toBe(true);
    const raw = readFileSync(offsetFile, 'utf-8').trim();
    const parsed = parseInt(raw, 10);
    expect(isNaN(parsed)).toBe(false);
    expect(parsed).toBe(701);

    // A fresh poller instance loading the persisted offset must resume at 701,
    // not at 0, proving restart-safe recovery.
    const { api: api2, calls: calls2 } = makeStubApi([]);
    const poller2 = new TelegramPoller(api2, stateDir);
    await poller2.pollOnce();
    expect(calls2[0]).toBe(701);
  });

  it('uses per-suffix offset files so two pollers in the same stateDir do not collide', async () => {
    // If two bots share a stateDir (e.g. agent bot + activity-channel bot),
    // they must persist offsets to distinct files. Without the suffix, both
    // pollers write to .telegram-offset and clobber each other's position.
    const { api: api1 } = makeStubApi([makeMessageUpdate(800, 'bot1')]);
    const { api: api2 } = makeStubApi([makeMessageUpdate(900, 'bot2')]);

    const poller1 = new TelegramPoller(api1, stateDir, 1000, 'bot1');
    const poller2 = new TelegramPoller(api2, stateDir, 1000, 'bot2');

    poller1.onMessage(() => { /* no-op */ });
    poller2.onMessage(() => { /* no-op */ });

    await poller1.pollOnce();
    await poller2.pollOnce();

    const offset1 = readFileSync(join(stateDir, '.telegram-offset-bot1'), 'utf-8').trim();
    const offset2 = readFileSync(join(stateDir, '.telegram-offset-bot2'), 'utf-8').trim();

    expect(offset1).toBe('801');
    expect(offset2).toBe('901');
  });
});

describe('TelegramPoller — stop-before-start race', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'cortextos-poller-stopstart-'));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('stop() called before start() prevents the poll loop from running', async () => {
    // This is the race that used to leak orphaned pollers inside the daemon:
    // agent-manager scheduled poller.start() via setTimeout, and if stopAgent
    // ran during the stagger window, poller.stop() set running=false on a
    // poller whose while-loop had not yet started. The deferred start() then
    // unconditionally set running=true and ran forever, with no agent-manager
    // entry holding a reference — producing a phantom getUpdates caller that
    // raced the real poller on the same bot token.
    const { api, calls } = makeStubApi([makeMessageUpdate(10, 'should-never-be-seen')]);
    const poller = new TelegramPoller(api, stateDir);

    poller.stop();
    await poller.start();

    expect(calls).toEqual([]);
    expect(api.getUpdates).not.toHaveBeenCalled();
  });

  it('stop() during the initial stagger delay prevents the poll loop', async () => {
    // agent-manager passes a non-zero initialDelayMs so multiple agents
    // stagger their first getUpdates calls. A stop() issued during that
    // pre-loop sleep must be honored — the re-check after the sleep is
    // what catches it.
    const { api, calls } = makeStubApi([makeMessageUpdate(20, 'also-never')]);
    const poller = new TelegramPoller(api, stateDir);

    const startPromise = poller.start(100);
    // Give start() a microtask to enter its initial sleep, then stop.
    await new Promise((resolve) => setTimeout(resolve, 10));
    poller.stop();
    await startPromise;

    expect(calls).toEqual([]);
    expect(api.getUpdates).not.toHaveBeenCalled();
  });

  it('start() is idempotent — a second call is a no-op', async () => {
    // Defense-in-depth: if start() is accidentally called twice on the same
    // instance, the second call must not spin up a second concurrent poll
    // loop. The `started` flag guards this.
    const { api } = makeStubApi([makeMessageUpdate(30, 'only-once')]);
    const poller = new TelegramPoller(api, stateDir);

    // Fire start() with a long initial delay so the first call is still
    // sleeping when the second arrives. Calling stop() then await resolves
    // both — but getUpdates must not have been called more than zero times
    // (both starts were cut short by stop).
    const firstStart = poller.start(500);
    const secondStart = poller.start(500);
    poller.stop();
    await Promise.all([firstStart, secondStart]);

    expect(api.getUpdates).not.toHaveBeenCalled();
  });
});
