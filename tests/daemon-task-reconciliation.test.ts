/**
 * Unit tests for daemon task reconciliation (Pattern 1) + the RGOS reset helper.
 *
 * The reconciliation decision is extracted into the pure `shouldRequeue` helper
 * (src/daemon/task-reconciliation.ts) precisely so the liveness/staleness gate
 * is testable without a network or a live PTY. The three required cases:
 *   (a) orphaned   — no live process + stale >15min        → requeue
 *   (b) live       — live process + (would-be) stale        → DO NOT requeue
 *   (c) grace      — no live process + updated <15min ago   → DO NOT requeue
 *
 * Case (b) is the mirror-outage protection: a Supabase outage can make a
 * perfectly healthy agent's heartbeat look stale, but as long as the daemon
 * holds a live process for it, its in-flight work must never be re-queued.
 *
 * Plus a reset-helper test: resetRgosTaskToApproved PATCHes orch_tasks to
 * status=approved without clobbering assigned_to, returns true on 2xx and
 * false (swallowed) on failure. fetch is stubbed — no real network.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  shouldRequeue,
  DEFAULT_ORPHAN_STALE_MS,
} from '../src/daemon/task-reconciliation.js';
import { resetRgosTaskToApproved } from '../src/bus/rgos-tasks.js';

const NOW = Date.parse('2026-06-18T12:00:00.000Z');
const STALE_MS = DEFAULT_ORPHAN_STALE_MS; // 15 min

function isoMinutesAgo(min: number): string {
  return new Date(NOW - min * 60_000).toISOString();
}

describe('shouldRequeue — reconciliation decision', () => {
  it('(a) orphaned: no live process + stale >15min → requeue', () => {
    const decision = shouldRequeue({
      hasLiveProcess: false,
      taskUpdatedAt: isoMinutesAgo(20), // 20 min old, well past the 15 min window
      now: NOW,
      staleMs: STALE_MS,
    });
    expect(decision).toBe(true);
  });

  it('(b) live session: live process wins even if the row/heartbeat looks stale → do NOT requeue', () => {
    // Mirror-outage case: process is alive, but updated_at is ancient. The live
    // process gate MUST short-circuit to false regardless of staleness.
    const decision = shouldRequeue({
      hasLiveProcess: true,
      taskUpdatedAt: isoMinutesAgo(120), // 2h old — would be "stale" if no process
      now: NOW,
      staleMs: STALE_MS,
    });
    expect(decision).toBe(false);
  });

  it('(c) grace window: no live process but updated <15min ago → do NOT requeue', () => {
    const decision = shouldRequeue({
      hasLiveProcess: false,
      taskUpdatedAt: isoMinutesAgo(5), // 5 min old — inside the grace window
      now: NOW,
      staleMs: STALE_MS,
    });
    expect(decision).toBe(false);
  });

  it('exactly at the staleness boundary requeues (>=)', () => {
    expect(
      shouldRequeue({ hasLiveProcess: false, taskUpdatedAt: isoMinutesAgo(15), now: NOW, staleMs: STALE_MS }),
    ).toBe(true);
  });

  it('null / missing / unparseable updated_at is treated as not-yet-stale (conservative)', () => {
    expect(shouldRequeue({ hasLiveProcess: false, taskUpdatedAt: null, now: NOW })).toBe(false);
    expect(shouldRequeue({ hasLiveProcess: false, taskUpdatedAt: undefined, now: NOW })).toBe(false);
    expect(shouldRequeue({ hasLiveProcess: false, taskUpdatedAt: 'not-a-date', now: NOW })).toBe(false);
  });

  it('a live process with a missing timestamp still short-circuits to false', () => {
    expect(shouldRequeue({ hasLiveProcess: true, taskUpdatedAt: null, now: NOW })).toBe(false);
  });
});

describe('resetRgosTaskToApproved — RGOS reset helper', () => {
  const ORIG_ENV = { ...process.env };

  beforeEach(() => {
    process.env.SUPABASE_RGOS_URL = 'https://example.supabase.co';
    process.env.SUPABASE_RGOS_SERVICE_KEY = 'test-service-key';
    delete process.env.BUS_RGOS_MIRROR_DISABLED;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...ORIG_ENV };
  });

  it('returns false (no fetch) when Supabase is not configured', async () => {
    delete process.env.SUPABASE_RGOS_URL;
    delete process.env.SUPABASE_URL;
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const ok = await resetRgosTaskToApproved('task-123');
    expect(ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('PATCHes orch_tasks to status=approved without clobbering assigned_to and returns true on 2xx', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 204, text: async () => '' });
    vi.stubGlobal('fetch', fetchSpy);

    const ok = await resetRgosTaskToApproved('task-abc', 'unit-test note');
    expect(ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toContain('/rest/v1/orch_tasks?id=eq.task-abc');
    expect(init.method).toBe('PATCH');
    expect(init.headers.Prefer).toBe('return=minimal');
    expect(init.headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(init.body);
    expect(body).toEqual({ status: 'approved' });
    // Crucially: assigned_to is NOT in the body — the next claim reassigns it.
    expect(body).not.toHaveProperty('assigned_to');
  });

  it('returns false (swallowed) on a non-2xx response — never throws out of the daemon tick', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' });
    vi.stubGlobal('fetch', fetchSpy);

    await expect(resetRgosTaskToApproved('task-err')).resolves.toBe(false);
  });
});
