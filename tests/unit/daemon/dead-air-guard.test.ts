import { describe, it, expect } from 'vitest';
import {
  DeadAirGuard,
  HOLDING_REPLY_TEXT,
  matchesUsageLimitBounce,
} from '../../../src/daemon/dead-air-guard';

const BOUNCE = "You've hit your org's monthly usage limit. Your limit will reset on July 1.";

describe('matchesUsageLimitBounce', () => {
  it('matches the org monthly usage-limit bounce text', () => {
    expect(matchesUsageLimitBounce(BOUNCE)).toBe(true);
  });

  it('matches API error codes', () => {
    expect(matchesUsageLimitBounce('{"type":"error","error":{"type":"rate_limit_error"}}')).toBe(true);
    expect(matchesUsageLimitBounce('overloaded_error')).toBe(true);
  });

  it('matches with ANSI escape codes interleaved', () => {
    expect(matchesUsageLimitBounce("\x1b[31mYou've hit your org's monthly usage limit\x1b[0m")).toBe(true);
  });

  it('does NOT match the always-on status bar limit text', () => {
    expect(matchesUsageLimitBounce('used 3% of your weekly limit · resets 10pm')).toBe(false);
    expect(matchesUsageLimitBounce('used 12% of your 5-hour limit · resets 3am')).toBe(false);
  });

  it('does NOT match normal assistant output', () => {
    expect(matchesUsageLimitBounce('Sure — checking the deploy status now.')).toBe(false);
    expect(matchesUsageLimitBounce('')).toBe(false);
  });
});

describe('HOLDING_REPLY_TEXT phrasing constraint', () => {
  it('never mentions usage caps, credits, quotas, or limits', () => {
    expect(HOLDING_REPLY_TEXT).not.toMatch(/usage|credit|quota|limit|cap\b|billing/i);
  });

  it('frames the situation as throttling/queueing', () => {
    expect(HOLDING_REPLY_TEXT).toMatch(/throttl|queue/i);
  });
});

describe('DeadAirGuard', () => {
  const opts = { bounceWindowMs: 15_000, consecutiveThreshold: 2, cooldownMs: 20 * 60 * 1000 };

  it('does not fire on a single bounce below the threshold', () => {
    const g = new DeadAirGuard(opts);
    g.onInjection(0);
    expect(g.onOutput(BOUNCE, 1_000)).toBe(false);
    expect(g.getConsecutiveBounces()).toBe(1);
  });

  it('fires after N consecutive bounced injections within the window', () => {
    const g = new DeadAirGuard(opts);
    g.onInjection(0);
    expect(g.onOutput(BOUNCE, 1_000)).toBe(false);
    g.onInjection(60_000);
    expect(g.onOutput(BOUNCE, 61_000)).toBe(true);
  });

  it('ignores bounce text when no probe is armed', () => {
    const g = new DeadAirGuard(opts);
    expect(g.onOutput(BOUNCE, 1_000)).toBe(false);
    expect(g.getConsecutiveBounces()).toBe(0);
  });

  it('a bounce arriving after the window does not count and resets the streak', () => {
    const g = new DeadAirGuard(opts);
    g.onInjection(0);
    expect(g.onOutput(BOUNCE, 1_000)).toBe(false);
    g.onInjection(60_000);
    // Bounce text arrives 16s after injection — outside the 15s window.
    expect(g.onOutput(BOUNCE, 76_001)).toBe(false);
    expect(g.getConsecutiveBounces()).toBe(0);
  });

  it('a turn processed normally (window expiry without bounce) resets the streak', () => {
    const g = new DeadAirGuard(opts);
    g.onInjection(0);
    expect(g.onOutput(BOUNCE, 1_000)).toBe(false);
    g.onInjection(60_000);
    expect(g.onOutput('Working on it — one moment.', 61_000)).toBe(false);
    // Window expires with no bounce → streak broken.
    g.onInjection(120_000);
    expect(g.onOutput(BOUNCE, 121_000)).toBe(false);
    expect(g.getConsecutiveBounces()).toBe(1);
  });

  it('non-bounce output within the window keeps the probe armed', () => {
    const g = new DeadAirGuard(opts);
    g.onInjection(0);
    expect(g.onOutput('partial frame...', 500)).toBe(false);
    expect(g.isArmed()).toBe(true);
    expect(g.onOutput(BOUNCE, 1_500)).toBe(false);
    expect(g.getConsecutiveBounces()).toBe(1);
    expect(g.isArmed()).toBe(false);
  });

  it('fires at most once per cooldown, then again after cooldown elapses', () => {
    const g = new DeadAirGuard(opts);
    // First fire at the threshold.
    g.onInjection(0);
    g.onOutput(BOUNCE, 1_000);
    g.onInjection(60_000);
    expect(g.onOutput(BOUNCE, 61_000)).toBe(true);

    // Streak continues — still inside cooldown → suppressed.
    g.onInjection(120_000);
    expect(g.onOutput(BOUNCE, 121_000)).toBe(false);
    g.onInjection(180_000);
    expect(g.onOutput(BOUNCE, 181_000)).toBe(false);

    // Past the 20-min cooldown with the streak still going → fires again.
    const later = 61_000 + opts.cooldownMs;
    g.onInjection(later);
    expect(g.onOutput(BOUNCE, later + 1_000)).toBe(true);
  });

  it('threshold of 1 fires on the first bounce', () => {
    const g = new DeadAirGuard({ ...opts, consecutiveThreshold: 1 });
    g.onInjection(0);
    expect(g.onOutput(BOUNCE, 1_000)).toBe(true);
  });

  it('isArmed reflects probe lifecycle', () => {
    const g = new DeadAirGuard(opts);
    expect(g.isArmed()).toBe(false);
    g.onInjection(0);
    expect(g.isArmed()).toBe(true);
    g.onOutput('still thinking', 20_000); // past window → expired
    expect(g.isArmed()).toBe(false);
  });
});
