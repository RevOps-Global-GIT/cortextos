/**
 * Usage-limit dead-air guard.
 *
 * Incident 2026-06-10 06:38-07:11Z: every inbound Telegram message injected
 * into the orchestrator session bounced with an immediate API-level usage-limit
 * error turn, so the user got 33 minutes of dead air. This module detects that
 * bounce pattern and tells the daemon to send ONE cooldown-guarded holding
 * reply so the user knows their messages are queued.
 *
 * Pure state machine — no I/O. The FastChecker feeds it injection timestamps
 * and new PTY output; when onOutput() returns true the caller sends the
 * holding Telegram reply and logs the bus event.
 */

// Deliberately phrased as brief throttling/queueing. Standing rule: never
// mention usage caps, credits, or quotas to the user.
export const HOLDING_REPLY_TEXT =
  'Briefly throttled — your messages are queued and will all be processed in a few minutes.';

// API-level turn-bounce error text. Deliberately narrower than
// OutputBuffer.hasRateLimitSignature(): the Claude Code status bar
// ("used 3% of your weekly limit · resets 10pm") is always on screen and must
// NOT count as a bounce — only the error text of a rejected turn does.
const BOUNCE_PATTERNS: RegExp[] = [
  /hit your (?:org(?:'s|anization'?s?)? )?(?:monthly |weekly )?usage limit/i,
  /monthly usage limit/i,
  /usage limit (?:reached|exceeded)/i,
  /rate_limit_error/i,
  /overloaded_error/i,
];

const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

export function matchesUsageLimitBounce(output: string): boolean {
  const text = output.replace(ANSI_RE, '');
  return BOUNCE_PATTERNS.some((re) => re.test(text));
}

export interface DeadAirGuardOptions {
  /** How long after an injection a bounce still counts as caused by it. */
  bounceWindowMs?: number;
  /** Consecutive bounced injections required before the holding reply fires. */
  consecutiveThreshold?: number;
  /** Minimum gap between holding replies — the guard fires at most once per cooldown. */
  cooldownMs?: number;
}

export class DeadAirGuard {
  private readonly bounceWindowMs: number;
  private readonly consecutiveThreshold: number;
  private readonly cooldownMs: number;

  private pendingInjectionAt: number | null = null;
  private consecutiveBounces = 0;
  private lastFiredAt: number | null = null;

  constructor(options: DeadAirGuardOptions = {}) {
    this.bounceWindowMs = options.bounceWindowMs ?? 15_000;
    this.consecutiveThreshold = options.consecutiveThreshold ?? 2;
    this.cooldownMs = options.cooldownMs ?? 20 * 60 * 1000;
  }

  /** A user message was injected into the agent PTY — arm a bounce probe. */
  onInjection(now: number): void {
    this.expireIfNeeded(now);
    this.pendingInjectionAt = now;
  }

  /**
   * Feed new PTY output produced since the last call. Returns true exactly
   * when the holding reply should be sent (threshold met + cooldown elapsed).
   */
  onOutput(newOutput: string, now: number): boolean {
    this.expireIfNeeded(now);
    if (this.pendingInjectionAt === null) return false;
    if (!matchesUsageLimitBounce(newOutput)) return false;

    this.pendingInjectionAt = null;
    this.consecutiveBounces++;

    if (this.consecutiveBounces < this.consecutiveThreshold) return false;
    if (this.lastFiredAt !== null && now - this.lastFiredAt < this.cooldownMs) return false;

    this.lastFiredAt = now;
    return true;
  }

  /** Whether a probe is currently armed (caller can stop tailing output when false). */
  isArmed(): boolean {
    return this.pendingInjectionAt !== null;
  }

  getConsecutiveBounces(): number {
    return this.consecutiveBounces;
  }

  /**
   * A probe that outlived the bounce window without matching means the turn
   * was processed normally — the streak is broken.
   */
  private expireIfNeeded(now: number): void {
    if (this.pendingInjectionAt !== null && now - this.pendingInjectionAt > this.bounceWindowMs) {
      this.pendingInjectionAt = null;
      this.consecutiveBounces = 0;
    }
  }
}
