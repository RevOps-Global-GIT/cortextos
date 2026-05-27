import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { TelegramPoller } from '../../../src/telegram/poller.js';
import type { TelegramAPI } from '../../../src/telegram/api.js';

describe('TelegramPoller poison update handling', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'cortextos-telegram-poller-'));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('dead-letters an update after repeated handler failures and advances the offset', async () => {
    const update = {
      update_id: 100,
      message: { message_id: 10, chat: { id: 123 }, text: 'boom' },
    };
    const api = {
      getUpdates: vi.fn().mockResolvedValue({ result: [update] }),
    } as unknown as TelegramAPI;
    const poller = new TelegramPoller(api, stateDir, 1, undefined, 'test-poller');
    const handler = vi.fn(() => {
      throw new Error('handler exploded');
    });

    poller.onMessage(handler);

    await poller.pollOnce();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(() => readFileSync(join(stateDir, 'telegram-dead-letter.jsonl'), 'utf-8')).toThrow();

    await poller.pollOnce();
    expect(handler).toHaveBeenCalledTimes(2);

    await poller.pollOnce();
    expect(handler).toHaveBeenCalledTimes(3);
    expect(readFileSync(join(stateDir, '.telegram-offset'), 'utf-8').trim()).toBe('101');

    const deadLetter = readFileSync(join(stateDir, 'telegram-dead-letter.jsonl'), 'utf-8');
    expect(deadLetter).toContain('"update_id":100');
    expect(deadLetter).toContain('"attempts":3');
  });

  it('clears a retry count when a redelivered update succeeds', async () => {
    const update = {
      update_id: 200,
      message: { message_id: 20, chat: { id: 123 }, text: 'retry then ok' },
    };
    const api = {
      getUpdates: vi.fn().mockResolvedValue({ result: [update] }),
    } as unknown as TelegramAPI;
    const poller = new TelegramPoller(api, stateDir, 1, undefined, 'test-poller');
    let shouldThrow = true;

    poller.onMessage(() => {
      if (shouldThrow) {
        shouldThrow = false;
        throw new Error('first try only');
      }
    });

    await poller.pollOnce();
    await poller.pollOnce();

    expect(readFileSync(join(stateDir, '.telegram-offset'), 'utf-8').trim()).toBe('201');
    expect(() => readFileSync(join(stateDir, 'telegram-dead-letter.jsonl'), 'utf-8')).toThrow();
  });

  it('waits for asynchronous message handlers before advancing the offset', async () => {
    const update = {
      update_id: 300,
      message: { message_id: 30, chat: { id: 123 }, text: 'ack first' },
    };
    const api = {
      getUpdates: vi.fn().mockResolvedValue({ result: [update] }),
    } as unknown as TelegramAPI;
    const poller = new TelegramPoller(api, stateDir, 1, undefined, 'test-poller');
    const events: string[] = [];

    poller.onMessage(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      events.push('handler-done');
    });

    await poller.pollOnce();

    expect(events).toEqual(['handler-done']);
    expect(readFileSync(join(stateDir, '.telegram-offset'), 'utf-8').trim()).toBe('301');
  });
});
