import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { BusPaths, TelegramUpdate, TelegramMessage, TelegramCallbackQuery, TelegramMessageReaction } from '../types/index.js';
import { TelegramAPI } from './api.js';
import { ensureDir, atomicWriteSync } from '../utils/atomic.js';
import { withRetry, isTransientError } from '../utils/retry.js';
import { logEvent } from '../bus/event.js';

export type MessageHandler = (msg: TelegramMessage) => void;
export type CallbackHandler = (query: TelegramCallbackQuery) => void;
export type ReactionHandler = (reaction: TelegramMessageReaction) => void;
export type ConflictHandler = () => void;

export interface TelegramPollerObservability {
  paths?: BusPaths;
  agentName?: string;
  org?: string;
  log?: (m: string) => void;
}

/** True when `err` is Telegram's getUpdates "Conflict" — another poller is
 *  already long-polling this bot token. Telegram permits exactly one. */
export function isConflictError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('Conflict') || msg.includes('terminated by other getUpdates');
}

/** Consecutive conflict cycles before a poller notifies its persistent-
 *  conflict handlers. ~8 one-second cycles is long enough to be sure this
 *  poller is a superseded orphan rather than a transient overlap. */
const PERSISTENT_CONFLICT_STREAK = 8;

/**
 * Telegram polling loop. Replaces the Telegram portion of fast-checker.sh.
 * Polls getUpdates every 1 second and routes messages/callbacks to handlers.
 */
export class TelegramPoller {
  private api: TelegramAPI;
  private offset: number = 0;
  private running: boolean = false;
  // BUG-POLLER-RACE fix: track whether start() has been called and whether
  // stop() was requested before start() had a chance to run. Without this,
  // a stop() call issued before the deferred setTimeout-start() fired would
  // be silently lost — the while-loop would unconditionally set running=true
  // and begin polling, producing an orphaned poller that no entry in the
  // agent-manager holds a reference to. A subsequent startAgent() would then
  // create a second live poller for the same bot token, and the two would
  // race on getUpdates and log "Conflict detected (another poller active)"
  // forever.
  private started: boolean = false;
  private stopRequested: boolean = false;
  private stateDir: string;
  private offsetFileName: string;
  private messageHandlers: MessageHandler[] = [];
  private callbackHandlers: CallbackHandler[] = [];
  private reactionHandlers: ReactionHandler[] = [];
  private pollInterval: number;
  private label: string;
  private observability?: TelegramPollerObservability;
  // Persistent-conflict self-heal. Telegram allows one getUpdates long-poll
  // per bot token; a second poller makes every getUpdates fail with
  // "Conflict". A poller losing getUpdates for a sustained streak is almost
  // certainly a superseded orphan. After PERSISTENT_CONFLICT_STREAK
  // consecutive conflict cycles it notifies conflictHandlers — the
  // agent-manager uses that to terminate orphans (incident 2026-05-17).
  private consecutiveConflictCycles: number = 0;
  private conflictHandlers: ConflictHandler[] = [];
  private consecutiveNonConflictErrors: number = 0;
  private lastErrSignature: string = '';
  /** Why the poll loop last exited ('stopped-externally' | 'conflict-self-die' | ''). */
  lastExitReason: string = '';

  /**
   * @param api Telegram API client scoped to a single bot token.
   * @param stateDir Directory for persisted poller state (offset, dedup).
   * @param pollInterval Milliseconds between getUpdates calls.
   * @param offsetFileSuffix Optional distinct suffix for the offset file.
   *   When omitted (default), offset persists to `.telegram-offset`. When
   *   provided, offset persists to `.telegram-offset-<suffix>`. Use this
   *   when running a second poller in the same stateDir against a
   *   different bot token (e.g. an activity-channel bot alongside the
   *   agent's own bot), so the two pollers do not clobber each other's
   *   offsets. Without this, two pollers sharing a stateDir would both
   *   write to `.telegram-offset` and lose track of which bot each
   *   offset belonged to.
   */
  constructor(api: TelegramAPI, stateDir: string, pollInterval: number = 1000, offsetFileSuffix?: string, label?: string, observability?: TelegramPollerObservability) {
    this.api = api;
    this.stateDir = stateDir;
    this.pollInterval = pollInterval;
    this.offsetFileName = offsetFileSuffix
      ? `.telegram-offset-${offsetFileSuffix}`
      : '.telegram-offset';
    this.label = label || 'telegram-poller';
    this.observability = observability;
    this.loadOffset();
  }

  /**
   * Register a handler for incoming messages.
   */
  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  /**
   * Register a handler for callback queries.
   */
  onCallback(handler: CallbackHandler): void {
    this.callbackHandlers.push(handler);
  }

  /**
   * Register a handler for message_reaction updates. These fire when a
   * user adds or removes an emoji reaction on a chat message the bot can
   * see. Requires the bot's getUpdates call to include `message_reaction`
   * in allowed_updates (handled by TelegramAPI.getUpdates).
   */
  onReaction(handler: ReactionHandler): void {
    this.reactionHandlers.push(handler);
  }

  /**
   * Register a handler invoked when this poller has lost getUpdates to a
   * Conflict for PERSISTENT_CONFLICT_STREAK consecutive cycles — i.e. another
   * poller holds this bot token. The agent-manager uses this to stop orphaned
   * pollers so exactly one poller per token survives.
   */
  onPersistentConflict(handler: ConflictHandler): void {
    this.conflictHandlers.push(handler);
  }

  /**
   * Start the polling loop.
   *
   * @param initialDelayMs Optional delay before the first getUpdates call.
   *   Used by agent-manager to stagger multiple agents' pollers so they do
   *   not all call the Telegram API simultaneously at daemon boot. Previously
   *   this was implemented via `setTimeout(() => poller.start(), delay)` in
   *   agent-manager, which created a race: if stopAgent() ran before the
   *   setTimeout fired, poller.stop() would set running=false on a poller
   *   that had not yet entered its while-loop, start() would then fire and
   *   unconditionally set running=true, and the result was an orphaned
   *   poller with no reference held by agent-manager. Moving the delay
   *   inside start() fixes that race by making stop() effective regardless
   *   of whether start() has run yet.
   */
  async start(initialDelayMs: number = 0): Promise<void> {
    // Respect a stop() that was issued before start() had a chance to run.
    if (this.stopRequested) return;
    // Idempotent — a second start() call on the same instance is a no-op.
    if (this.started) return;
    this.started = true;

    if (initialDelayMs > 0) {
      await sleep(initialDelayMs);
      // Re-check stopRequested after the delay — a stop() during the stagger
      // window must prevent the poll loop from ever starting.
      if (this.stopRequested) return;
    }

    this.running = true;
    this.lastExitReason = '';
    while (this.running) {
      try {
        await this.pollOnce();
        // A clean cycle clears both conflict streak and non-conflict error tracking.
        if (this.consecutiveNonConflictErrors > 0) {
          console.error(`[${this.label}] Recovered after ${this.consecutiveNonConflictErrors} failed polls.`);
          this.consecutiveNonConflictErrors = 0;
          this.lastErrSignature = '';
        }
        this.consecutiveConflictCycles = 0;
        await sleep(this.pollInterval);
      } catch (err) {
        if (isConflictError(err)) {
          this.consecutiveConflictCycles++;
          this.consecutiveNonConflictErrors = 0;
          this.lastErrSignature = '';
          console.warn(
            `[${this.label}] getUpdates Conflict (streak ${this.consecutiveConflictCycles}) — ` +
            `another poller is using this bot token`,
          );
          // Notify handlers at the streak threshold and every multiple
          // thereafter. The agent-manager's handler stops this poller if it
          // is a superseded orphan (no longer the registered poller).
          if (
            this.consecutiveConflictCycles >= PERSISTENT_CONFLICT_STREAK &&
            this.consecutiveConflictCycles % PERSISTENT_CONFLICT_STREAK === 0
          ) {
            for (const handler of this.conflictHandlers) {
              try { handler(); } catch { /* handler failure must not break the loop */ }
            }
          }
          await sleep(this.pollInterval);
        } else {
          // Non-conflict error: exponential backoff + log dedup.
          // First 5 errors log in full; then identical errors are suppressed
          // with one summary line every 100. Distinct signatures always log.
          this.consecutiveConflictCycles = 0;
          this.consecutiveNonConflictErrors++;
          const retryable = isRetryableError(err);
          const sig = err instanceof Error ? `${err.name}:${err.message}` : String(err);
          const n = this.consecutiveNonConflictErrors;
          const shouldLog =
            !retryable ||
            n <= 5 ||
            sig !== this.lastErrSignature ||
            n % 100 === 0;
          if (shouldLog) {
            const tag = retryable ? 'Poll error' : 'Poll error (non-retryable)';
            console.error(`[${this.label}] ${tag} (#${n}):`, err);
          }
          this.lastErrSignature = sig;
          let backoff: number;
          if (retryable) {
            const base = Math.min(this.pollInterval * 2 ** Math.min(n, 6), 60000);
            backoff = Math.floor(base * (0.5 + Math.random() * 0.5));
          } else {
            backoff = 5000;
          }
          await sleep(backoff);
        }
      }
    }
  }

  /**
   * Stop the polling loop. Safe to call before start() — the subsequent
   * start() will observe stopRequested and return without entering the loop.
   * Sets lastExitReason='stopped-externally' to mark the exit as intentional.
   */
  stop(): void {
    this.stopRequested = true;
    this.running = false;
    this.lastExitReason = 'stopped-externally';
  }

  /**
   * Perform a single poll cycle.
   *
   * Offset-after-handler semantics: the offset only advances after every
   * registered handler for an update returns successfully. If any handler
   * throws, the update is left un-acknowledged (Telegram will re-deliver it
   * on the next `getUpdates` call) and the remainder of the batch is deferred
   * to preserve ordering. The offset is persisted after each successful
   * update so a crash mid-batch does not drop confirmed state.
   */
  async pollOnce(): Promise<void> {
    // Conflict errors are deliberately NOT retried here. A Conflict means
    // another poller holds this bot token; 8-30s retry backoff would keep a
    // superseded orphan calling getUpdates for ~70s after stop(), and that
    // overlap window is exactly how orphaned pollers stacked into the
    // Conflict storm (incident 2026-05-17). Letting the Conflict throw
    // immediately returns control to start()'s loop, which re-checks the
    // running flag every cycle and counts the conflict streak for self-heal.
    const result = await withRetry(
      () => this.api.getUpdates(this.offset, 1),
      {
        maxAttempts: 3,
        baseDelayMs: 8_000,
        maxDelayMs: 30_000,
        isRetryable: (err) => !isConflictError(err) && isTransientError(err),
        onRetry: (attempt, err) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[${this.label}] getUpdates attempt ${attempt} failed (transient error), retrying: ${msg}`);
        },
      },
    );
    if (!result?.result?.length) return;

    for (const update of result.result as TelegramUpdate[]) {
      const nextOffset = update.update_id + 1;
      const updateType = detectUpdateType(update);
      let handlerFailed = false;

      this.observability?.log?.(`[${this.label}] update_id=${update.update_id} type=${updateType}`);

      if (update.message) {
        for (const handler of this.messageHandlers) {
          try {
            handler(update.message);
          } catch (err) {
            console.error(`[${this.label}] Message handler error:`, err);
            handlerFailed = true;
            break;
          }
        }
      }

      if (!handlerFailed && update.callback_query) {
        for (const handler of this.callbackHandlers) {
          try {
            handler(update.callback_query);
          } catch (err) {
            console.error(`[${this.label}] Callback handler error:`, err);
            handlerFailed = true;
            break;
          }
        }
      }

      if (!handlerFailed && update.message_reaction) {
        for (const handler of this.reactionHandlers) {
          try {
            handler(update.message_reaction);
          } catch (err) {
            console.error('[telegram-poller] Reaction handler error:', err);
            handlerFailed = true;
            break;
          }
        }
      }

      if (!update.message && !update.callback_query && !update.message_reaction) {
        const keys = Object.keys(update);
        console.warn(`[${this.label}] UNKNOWN update shape: update_id=${update.update_id} keys=${keys.join(',')}`);
        if (this.observability?.paths && this.observability.agentName && this.observability.org) {
          logEvent(this.observability.paths, this.observability.agentName, this.observability.org, 'error', 'telegram_unknown_update', 'warning', {
            update_id: update.update_id,
            keys,
          });
        }
      }

      if (handlerFailed) {
        // Do not advance offset — the update will be redelivered.
        // Stop processing the rest of this batch to preserve ordering.
        return;
      }

      this.offset = nextOffset;
      this.saveOffset();
    }
  }

  /**
   * Load persisted offset from state file.
   */
  private loadOffset(): void {
    const offsetFile = join(this.stateDir, this.offsetFileName);
    try {
      if (existsSync(offsetFile)) {
        const content = readFileSync(offsetFile, 'utf-8').trim();
        const parsed = parseInt(content, 10);
        if (!isNaN(parsed)) {
          this.offset = parsed;
        }
      }
    } catch {
      // Start from 0 if can't read
    }
  }

  /**
   * Save current offset to state file using an atomic write (write-then-rename).
   * Prevents a torn/empty offset file on crash mid-write, which would cause the
   * poller to restart from offset 0 and re-deliver already-processed messages.
   */
  private saveOffset(): void {
    const offsetFile = join(this.stateDir, this.offsetFileName);
    try {
      atomicWriteSync(offsetFile, String(this.offset));
    } catch {
      // Ignore write errors
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function detectUpdateType(update: TelegramUpdate): 'message' | 'callback_query' | 'message_reaction' | 'unknown' {
  if (update.message) return 'message';
  if (update.callback_query) return 'callback_query';
  if (update.message_reaction) return 'message_reaction';
  return 'unknown';
}

/**
 * Classify a non-conflict poll error as retryable (network/transient) or
 * fatal (code bug, auth failure). Retryable errors get exponential backoff
 * + log dedup; fatal errors are logged every time with a short fixed backoff.
 *
 * Note: pollOnce() already retries transient errors via withRetry (3 attempts,
 * 8–30s). Errors that reach start()'s catch have either exhausted those
 * retries or are non-transient. isRetryableError() guards the outer loop.
 */
function isRetryableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'TypeError' || err.name === 'ReferenceError' || err.name === 'SyntaxError') {
    return false;
  }
  const msg = err.message;
  if (msg.startsWith('Telegram API request timed out')) return true;
  if (msg.startsWith('Telegram API request failed')) return true;
  if (msg.startsWith('Failed to download file:')) return true;
  if (msg.startsWith('Telegram API error:')) {
    return /\b(429|Too Many Requests|retry after|5\d\d|Bad Gateway|Gateway Timeout|Service Unavailable|Internal Server Error)\b/i.test(msg);
  }
  return false;
}
