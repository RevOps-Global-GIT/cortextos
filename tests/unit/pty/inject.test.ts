import { describe, it, expect, vi, afterEach } from 'vitest';
import { MessageDedup, KEYS } from '../../../src/pty/inject';

describe('MessageDedup', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('detects duplicate content within the TTL window', () => {
    const dedup = new MessageDedup();
    expect(dedup.isDuplicate('hello world')).toBe(false);
    expect(dedup.isDuplicate('hello world')).toBe(true);
  });

  it('allows different content', () => {
    const dedup = new MessageDedup();
    expect(dedup.isDuplicate('message 1')).toBe(false);
    expect(dedup.isDuplicate('message 2')).toBe(false);
  });

  it('evicts old entries when size cap is reached', () => {
    const dedup = new MessageDedup(3);
    dedup.isDuplicate('msg1');
    dedup.isDuplicate('msg2');
    dedup.isDuplicate('msg3');
    dedup.isDuplicate('msg4'); // evicts msg1 (oldest)
    expect(dedup.isDuplicate('msg1')).toBe(false); // no longer in cache
    expect(dedup.isDuplicate('msg4')).toBe(true); // still in cache
  });

  it('expires entries after the TTL — cron fix', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-22T00:00:00Z'));

    // Short TTL so the test runs fast
    const dedup = new MessageDedup(100, 1_000);

    // First fire of a cron-scheduled prompt
    expect(dedup.isDuplicate('rgos-task-poll prompt')).toBe(false);

    // 500ms later — still inside the dedup window (crash-recovery replay)
    vi.advanceTimersByTime(500);
    expect(dedup.isDuplicate('rgos-task-poll prompt')).toBe(true);

    // 2s after the initial fire — well past the 1s TTL. Cron fires the same
    // prompt again; must be allowed through, not silently dropped.
    vi.advanceTimersByTime(1_600);
    expect(dedup.isDuplicate('rgos-task-poll prompt')).toBe(false);
  });

  it('refreshes timestamps on in-window hits so bursts stay suppressed', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-22T00:00:00Z'));

    const dedup = new MessageDedup(100, 1_000);
    expect(dedup.isDuplicate('burst')).toBe(false);

    // Three replays, each 400ms apart — each one refreshes the timestamp,
    // so even though the total elapsed time (1.2s) exceeds the 1s TTL,
    // the entry keeps getting extended and stays flagged.
    vi.advanceTimersByTime(400);
    expect(dedup.isDuplicate('burst')).toBe(true);
    vi.advanceTimersByTime(400);
    expect(dedup.isDuplicate('burst')).toBe(true);
    vi.advanceTimersByTime(400);
    expect(dedup.isDuplicate('burst')).toBe(true);

    // After the bursts stop, a 1.1s gap lets the entry expire.
    vi.advanceTimersByTime(1_100);
    expect(dedup.isDuplicate('burst')).toBe(false);
  });
});

describe('KEYS', () => {
  it('has correct escape sequences', () => {
    expect(KEYS.ENTER).toBe('\r');
    expect(KEYS.CTRL_C).toBe('\x03');
    expect(KEYS.DOWN).toBe('\x1b[B');
    expect(KEYS.UP).toBe('\x1b[A');
    expect(KEYS.SPACE).toBe(' ');
  });
});
