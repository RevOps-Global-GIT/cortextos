import { createHash } from 'crypto';

// Bracketed paste mode escape sequences
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

// Key escape sequences for TUI navigation
export const KEYS = {
  ENTER: '\r',
  CTRL_C: '\x03',
  DOWN: '\x1b[B',
  UP: '\x1b[A',
  SPACE: ' ',
  ESCAPE: '\x1b',
  TAB: '\t',
} as const;

/**
 * Message deduplication via MD5 hash, time-bounded.
 *
 * Purpose: prevent double-injection on crash recovery — where the supervisor
 * replays a message within milliseconds of the first attempt. This is a
 * narrow, short-lived concern.
 *
 * Bug fix (2026-04-22): the original implementation had no TTL, which meant
 * any content injected once (e.g., a cron-scheduled nudge with a static
 * prompt) would be rejected on every subsequent fire forever, up to the
 * 100-entry cache depth. Agents would appear idle while their scheduled
 * prompts silently dropped. The fix here uses a short TTL (10s default) so
 * crash-recovery replays still dedupe, but legitimate periodic re-fires pass
 * through.
 *
 * Mirrors the bash fast-checker.sh hash pattern, just with an expiry.
 */
export class MessageDedup {
  // hash -> last-seen epoch ms
  private hashes: Map<string, number> = new Map();
  private maxEntries: number;
  private ttlMs: number;

  /**
   * @param maxEntries hard cap on the cache size regardless of TTL
   * @param ttlMs      how long a hash is considered a "duplicate" after first
   *                   injection. Default 10s: long enough to catch crash-
   *                   recovery double-injects, short enough that a cron firing
   *                   the same prompt every N minutes is never dropped.
   */
  constructor(maxEntries: number = 100, ttlMs: number = 10_000) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
  }

  /**
   * Returns true if this content was seen within the TTL window.
   * Advances the timestamp on a hit so rapid repeats stay suppressed.
   */
  isDuplicate(content: string): boolean {
    const hash = createHash('md5').update(content).digest('hex');
    const now = Date.now();

    const prior = this.hashes.get(hash);
    if (prior !== undefined && now - prior < this.ttlMs) {
      this.hashes.set(hash, now);
      return true;
    }

    // Opportunistic prune of expired entries (cheap; map stays small).
    for (const [h, ts] of this.hashes) {
      if (now - ts >= this.ttlMs) this.hashes.delete(h);
    }

    // Re-insert so insertion order reflects recency for the LRU-size bound.
    this.hashes.delete(hash);
    this.hashes.set(hash, now);

    if (this.hashes.size > this.maxEntries) {
      const oldest = this.hashes.keys().next().value;
      if (oldest !== undefined) this.hashes.delete(oldest);
    }

    return false;
  }

  clear(): void {
    this.hashes.clear();
  }
}

/**
 * Inject a message into a PTY process using bracketed paste mode.
 * Replaces tmux load-buffer + paste-buffer pattern.
 *
 * Bracketed paste mode wraps the content so the terminal treats it as
 * pasted text rather than typed input. This prevents special characters
 * from being interpreted as commands.
 *
 * @param write Function to write to the PTY (pty.write)
 * @param content The message content to inject
 * @param enterDelay Milliseconds to wait before sending Enter (default 300ms)
 */
export function injectMessage(
  write: (data: string) => void,
  content: string,
  enterDelay: number = 300,
): void {
  // For very large messages, chunk the write to avoid overwhelming the PTY buffer
  const MAX_CHUNK = 4096;

  if (content.length <= MAX_CHUNK) {
    write(PASTE_START + content + PASTE_END);
  } else {
    // Chunked write for large messages
    write(PASTE_START);
    for (let i = 0; i < content.length; i += MAX_CHUNK) {
      write(content.slice(i, i + MAX_CHUNK));
    }
    write(PASTE_END);
  }

  // Send Enter after a short delay to submit the pasted content
  setTimeout(() => write(KEYS.ENTER), enterDelay);
}

/**
 * Send a sequence of keys to the PTY for TUI navigation.
 * Used for AskUserQuestion option selection and Plan mode approval.
 *
 * @param write Function to write to the PTY
 * @param keys Array of key sequences to send
 * @param delay Milliseconds between each key (default 100ms)
 */
export async function sendKeySequence(
  write: (data: string) => void,
  keys: string[],
  delay: number = 100,
): Promise<void> {
  for (const key of keys) {
    write(key);
    await sleep(delay);
  }
}

/**
 * Navigate to a specific option in a TUI list and select it.
 * Matches bash fast-checker.sh AskUserQuestion navigation.
 *
 * @param write PTY write function
 * @param optionIndex 0-based index of the option to select
 * @param submit Whether to press Enter after selection
 */
export async function selectOption(
  write: (data: string) => void,
  optionIndex: number,
  submit: boolean = true,
): Promise<void> {
  // Navigate down to the option
  for (let i = 0; i < optionIndex; i++) {
    write(KEYS.DOWN);
    await sleep(100);
  }
  await sleep(200);

  if (submit) {
    write(KEYS.ENTER);
  }
}

/**
 * Toggle options for multi-select TUI and submit.
 * Matches bash fast-checker.sh multi-select pattern.
 */
export async function toggleAndSubmit(
  write: (data: string) => void,
  selectedIndices: number[],
  totalOptions: number,
): Promise<void> {
  const sorted = [...selectedIndices].sort((a, b) => a - b);
  let currentPos = 0;

  for (const idx of sorted) {
    const moves = idx - currentPos;
    for (let i = 0; i < moves; i++) {
      write(KEYS.DOWN);
      await sleep(100);
    }
    write(KEYS.SPACE);
    await sleep(100);
    currentPos = idx;
  }

  // Navigate to Submit button (past all options + "Other")
  const submitPos = totalOptions + 1;
  const remaining = submitPos - currentPos;
  for (let i = 0; i < remaining; i++) {
    write(KEYS.DOWN);
    await sleep(100);
  }
  await sleep(200);
  write(KEYS.ENTER);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
