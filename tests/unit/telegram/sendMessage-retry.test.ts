/**
 * sendMessage retry integration test.
 *
 * Verifies that TelegramAPI.sendMessage (via sendChunk → withRetry) actually
 * retries on transient failures and surfaces the last error after exhaustion.
 *
 * Coverage gap identified in:
 *   dev/output/2026-04-25-recent-merges-coverage-audit.md (retry-utility section)
 *
 * Strategy: mock globalThis.fetch so tests are fast and deterministic.
 * sendChunk calls withRetry({ maxAttempts: 3, isRetryable: isTransientError }).
 * We simulate transient failures via ECONNRESET-shaped responses and verify:
 *   1. Retries on transient error, succeeds on later attempt.
 *   2. Throws last error after all attempts exhausted.
 *   3. Does NOT retry on non-retryable errors (400 Bad Request).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { TelegramAPI } from '../../../src/telegram/api';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a successful Telegram sendMessage fetch response. */
function okResponse(messageId = 1): Response {
  return new Response(
    JSON.stringify({ ok: true, result: { message_id: messageId, date: 0, chat: { id: 1, type: 'private' } } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

/** Build a fetch response that Telegram rejects with a non-retryable error. */
function badRequestResponse(description = 'Bad Request: message text is empty'): Response {
  return new Response(
    JSON.stringify({ ok: false, error_code: 400, description }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

/** A fetch mock that throws a transient network error. */
function transientFetchError(): Promise<never> {
  const err = new Error('ECONNRESET');
  return Promise.reject(err);
}

// sendChunk uses withRetry({ baseDelayMs: 1000 }) — patch sleep to run fast.
vi.mock('../../../src/utils/retry', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/utils/retry')>();
  return {
    ...original,
    // Replace withRetry with a version that uses baseDelayMs: 0 to skip waits
    withRetry: (fn: Parameters<typeof original.withRetry>[0], opts?: Parameters<typeof original.withRetry>[1]) =>
      original.withRetry(fn, { ...opts, baseDelayMs: 0, maxDelayMs: 0 }),
  };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TelegramAPI.sendMessage — retry behaviour (withRetry integration)', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it('retries on transient network error and succeeds on a later attempt', async () => {
    let call = 0;
    globalThis.fetch = vi.fn(async (..._args: Parameters<typeof fetch>) => {
      call++;
      if (call < 3) return transientFetchError();
      return okResponse();
    }) as typeof fetch;

    const api = new TelegramAPI('123:TEST_TOKEN');
    const result = await api.sendMessage(42, 'hello');

    // Should have taken exactly 3 fetch calls (2 failures + 1 success)
    expect(call).toBe(3);
    expect(result.ok).toBe(true);
    expect(result.result.message_id).toBe(1);
  });

  it('throws the last transient error after exhausting all attempts', async () => {
    let call = 0;
    globalThis.fetch = vi.fn(async (..._args: Parameters<typeof fetch>) => {
      call++;
      return transientFetchError();
    }) as typeof fetch;

    const api = new TelegramAPI('123:TEST_TOKEN');
    await expect(api.sendMessage(42, 'hello')).rejects.toThrow('ECONNRESET');

    // maxAttempts = 3 → exactly 3 fetch calls before throwing
    expect(call).toBe(3);
  });

  it('does NOT retry on non-retryable Telegram API errors (400 Bad Request)', async () => {
    let call = 0;
    globalThis.fetch = vi.fn(async (..._args: Parameters<typeof fetch>) => {
      call++;
      return badRequestResponse();
    }) as typeof fetch;

    const api = new TelegramAPI('123:TEST_TOKEN');
    await expect(api.sendMessage(42, 'hello')).rejects.toThrow(/400|Bad Request/);

    // isRetryable returns false for 400 → only 1 attempt, no retries
    expect(call).toBe(1);
  });

  it('succeeds on the first attempt without retrying when fetch succeeds immediately', async () => {
    let call = 0;
    globalThis.fetch = vi.fn(async (..._args: Parameters<typeof fetch>) => {
      call++;
      return okResponse(99);
    }) as typeof fetch;

    const api = new TelegramAPI('123:TEST_TOKEN');
    const result = await api.sendMessage(42, 'hello world');

    expect(call).toBe(1);
    expect(result.ok).toBe(true);
    expect(result.result.message_id).toBe(99);
  });
});
