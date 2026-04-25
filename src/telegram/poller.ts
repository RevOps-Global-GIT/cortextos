import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { TelegramUpdate, TelegramMessage, TelegramCallbackQuery, TelegramMessageReaction } from '../types/index.js';
import { TelegramAPI } from './api.js';
import { ensureDir, atomicWriteSync } from '../utils/atomic.js';
import { withRetry, isTransientError } from '../utils/retry.js';

export type MessageHandler = (msg: TelegramMessage) => void;
export type CallbackHandler = (query: TelegramCallbackQuery) => void;
export type ReactionHandler = (reaction: TelegramMessageReaction) => void;

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
  constructor(api: TelegramAPI, stateDir: string, pollInterval: number = 1000, offsetFileSuffix?: string, label?: string) {
    this.api = api;
    this.stateDir = stateDir;
    this.pollInterval = pollInterval;
    this.offsetFileName = offsetFileSuffix
      ? `.telegram-offset-${offsetFileSuffix}`
      : '.telegram-offset';
    this.label = label || 'telegram-poller';
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
    while (this.running) {
      try {
        await this.pollOnce();
      } catch (err) {
        // Log error but continue polling
        console.error(`[${this.label}] Poll error:`, err);
      }
      await sleep(this.pollInterval);
    }
  }

  /**
   * Stop the polling loop. Safe to call before start() — the subsequent
   * start() will observe stopRequested and return without entering the loop.
   */
  stop(): void {
    this.stopRequested = true;
    this.running = false;
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
    const isConflict = (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      return msg.includes('Conflict') || msg.includes('terminated by other getUpdates');
    };
    const result = await withRetry(
      () => this.api.getUpdates(this.offset, 1),
      {
        maxAttempts: 3,
        baseDelayMs: 8_000,
        maxDelayMs: 30_000,
        isRetryable: (err) => isConflict(err) || isTransientError(err),
        onRetry: (attempt, err) => {
          const msg = err instanceof Error ? err.message : String(err);
          const reason = isConflict(err) ? 'Conflict (another poller active)' : 'transient error';
          console.warn(`[${this.label}] getUpdates attempt ${attempt} failed (${reason}), retrying: ${msg}`);
        },
      },
    );
    if (!result?.result?.length) return;

    for (const update of result.result as TelegramUpdate[]) {
      const nextOffset = update.update_id + 1;
      let handlerFailed = false;

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
