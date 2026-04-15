import { appendFileSync } from 'fs';
import { redactSecrets } from './redact.js';

// Dynamic import for strip-ansi (ESM module)
let stripAnsi: (text: string) => string;
async function loadStripAnsi() {
  if (!stripAnsi) {
    const mod = await import('strip-ansi');
    stripAnsi = mod.default;
  }
  return stripAnsi;
}

/**
 * Ring buffer for PTY output. Replaces tmux capture-pane.
 * Stores raw output chunks and provides search/retrieval with ANSI stripping.
 */
export class OutputBuffer {
  private chunks: string[] = [];
  private maxChunks: number;
  private logPath: string | null;

  constructor(maxChunks: number = 1000, logPath?: string) {
    this.maxChunks = maxChunks;
    this.logPath = logPath || null;
  }

  /**
   * Push new output data into the buffer.
   * Also streams to log file if configured.
   *
   * Secret redaction runs once at the top via `redactSecrets` and the
   * scrubbed string is used for BOTH the in-memory ring buffer AND the
   * disk log. Without this, any JWT or session cookie an agent's shell
   * happens to print (e.g. curl -v against an authenticated endpoint)
   * would end up persisted to stdout.log verbatim. See src/pty/redact.ts
   * for the rationale + the known chunk-boundary limitation.
   */
  push(data: string): void {
    const safe = redactSecrets(data);

    this.chunks.push(safe);
    if (this.chunks.length > this.maxChunks) {
      this.chunks.shift();
    }

    // Stream to log file (replaces tmux pipe-pane)
    if (this.logPath) {
      try {
        appendFileSync(this.logPath, safe, 'utf-8');
      } catch {
        // Ignore log write errors
      }
    }
  }

  /**
   * Get the last N chunks of output joined together.
   */
  getRecent(n?: number): string {
    const count = n || this.chunks.length;
    return this.chunks.slice(-count).join('');
  }

  /**
   * Search for a pattern in recent output (ANSI codes stripped).
   * Used for bootstrap detection ("permissions" text).
   */
  async search(pattern: string): Promise<boolean> {
    const strip = await loadStripAnsi();
    const text = strip(this.getRecent());
    return text.includes(pattern);
  }

  /**
   * Synchronous search for simple patterns.
   * Does basic ANSI stripping inline (strips ESC[ sequences).
   */
  searchSync(pattern: string): boolean {
    const text = this.getRecent().replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
    return text.includes(pattern);
  }

  /**
   * Check if agent has bootstrapped (permissions prompt appeared).
   */
  isBootstrapped(): boolean {
    // Look for Claude Code's status bar which shows "permissions" as a mode indicator.
    // Avoid false positives from the trust folder prompt which also contains permission-related text.
    // The status bar appears after Claude has fully initialized and is ready for input.
    const recent = this.getRecent();
    const cleaned = recent.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
    // Trust prompt contains "trust this folder" - exclude that
    if (cleaned.includes('trust') && !cleaned.includes('> ')) {
      return false;
    }
    return cleaned.includes('permissions');
  }

  /**
   * Get the total size of buffered output in bytes.
   * Useful for activity detection (typing indicator).
   */
  getSize(): number {
    let size = 0;
    for (const chunk of this.chunks) {
      size += chunk.length;
    }
    return size;
  }

  /**
   * Check whether the recent PTY output contains signatures of an Anthropic
   * API rate-limit or overload response. Used by the daemon to distinguish
   * rate-limit exits from real crashes so it can apply an extended pause
   * instead of the normal crash-backoff cycle.
   *
   * Patterns matched (case-insensitive, ANSI stripped):
   *   - "overloaded_error" / "overloaded" (HTTP 529 body)
   *   - "rate_limit_error" / "rate limit" / "rate-limit"
   *   - "too many requests"
   *   - "quota exceeded" / "usage limit"
   *   - "529"
   */
  hasRateLimitSignature(): boolean {
    // Only scan the last 200 chunks — rate-limit messages appear near session end
    const text = this.chunks.slice(-200).join('').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').toLowerCase();
    return (
      text.includes('overloaded_error') ||
      text.includes('rate_limit_error') ||
      text.includes('rate limit') ||
      text.includes('rate-limit') ||
      text.includes('too many requests') ||
      text.includes('quota exceeded') ||
      text.includes('usage limit') ||
      // Claude Code CLI status bar: "used N% of your weekly limit · resets Xpm"
      // and "used N% of your 5-hour limit · resets Xpm"
      text.includes('weekly limit') ||
      text.includes('5-hour limit') ||
      text.includes('5h limit') ||
      /used \d+% of your/.test(text) ||
      // HTTP 529 status line or JSON error code
      (text.includes('529') && (text.includes('overload') || text.includes('error')))
    );
  }

  /**
   * Parse the reset time from a Claude Code CLI rate-limit message and return
   * the number of seconds until that reset. Returns null if no reset time is
   * found. Handles formats like:
   *   "resets 10pm (America/Los_Angeles)"
   *   "resets 3am"
   * Returns a minimum of 300s (5min) and a maximum of 7 days.
   */
  getRateLimitResetSeconds(): number | null {
    const text = this.chunks.slice(-200).join('').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').toLowerCase();
    // Match "resets <hour><am|pm>" optionally followed by a tz in parens
    const m = text.match(/resets\s+(\d{1,2})\s*(am|pm)/);
    if (!m) return null;
    const hour12 = parseInt(m[1], 10);
    const ampm = m[2];
    let hour24 = hour12 % 12;
    if (ampm === 'pm') hour24 += 12;

    // Build a Date in America/Los_Angeles for the reset hour. Use Intl to
    // compute the LA offset without depending on the machine tz.
    const now = new Date();
    const laString = now.toLocaleString('en-US', {
      timeZone: 'America/Los_Angeles',
      hour12: false,
    });
    // "4/15/2026, 01:00:00"  → parse to extract the LA wall clock
    const laMatch = laString.match(/(\d+)\/(\d+)\/(\d+),?\s+(\d+):(\d+):(\d+)/);
    if (!laMatch) return null;
    const laHour = parseInt(laMatch[4], 10);
    const laMin = parseInt(laMatch[5], 10);
    const laSec = parseInt(laMatch[6], 10);

    // Seconds from LA "now" to LA "hour24:00:00". If the reset hour has
    // already passed today, roll to tomorrow.
    let delta = (hour24 - laHour) * 3600 - laMin * 60 - laSec;
    if (delta <= 0) delta += 24 * 3600;

    // Weekly limits wait until the LA reset time, then add extra 5min of
    // safety so we do not re-enter the loop right at the boundary.
    const MIN = 300;          // 5 minutes
    const MAX = 7 * 24 * 3600; // 7 days
    return Math.max(MIN, Math.min(MAX, delta + 300));
  }

  /**
   * Clear the buffer.
   */
  clear(): void {
    this.chunks = [];
  }
}
