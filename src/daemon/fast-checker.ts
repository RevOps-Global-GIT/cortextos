import { readdirSync, readFileSync, existsSync, writeFileSync, unlinkSync, statSync, openSync, readSync, closeSync } from 'fs';
import { atomicWriteSync } from '../utils/atomic.js';
import { execFile, execFileSync, spawn } from 'child_process';
import { join } from 'path';
import { createHash } from 'crypto';
import { hardRestart } from '../bus/system.js';
import type { InboxMessage, BusPaths, TelegramMessage, TelegramCallbackQuery } from '../types/index.js';
import { checkInbox, ackInbox, sendMessage } from '../bus/message.js';
import { updateApproval, listPendingApprovals, readApproval } from '../bus/approval.js';
import { listTasks, recoverStaleInProgressTasks } from '../bus/task.js';
import { mirrorTaskToRgos, drainRetryQueue, isEnabled as isMirrorEnabled } from '../bus/rgos-mirror.js';
import { AgentProcess } from './agent-process.js';
import { DeadAirGuard, HOLDING_REPLY_TEXT, matchesUsageLimitBounce } from './dead-air-guard.js';
import { logEvent } from '../bus/event.js';
import type { TelegramAPI } from '../telegram/api.js';
import { KEYS } from '../pty/inject.js';
import { stripControlChars } from '../utils/validate.js';
import {
  formatTelegramTextMessage,
  formatTelegramReaction,
  formatTelegramPhotoMessage,
  formatTelegramDocumentMessage,
  formatTelegramVoiceMessage,
  formatTelegramVideoMessage,
  readLastSent,
} from './fast-checker-formatters.js';

type LogFn = (msg: string) => void;

/**
 * How long Tier 3 defers a context force-restart while the session is bouncing
 * on usage limits. Restarting a rate-limited session is pure thrash: the fresh
 * session burns rate-limited tokens on bootstrap, crosses the ctx threshold
 * again, and loops (session 62a6bac2: 5 rate-limit hits → 10 handoff cascades).
 * Deferring is safe because context cannot grow while turns are bouncing.
 */
export const RATE_LIMIT_HANDOFF_BACKOFF_MS = 10 * 60_000;

export type HandoffDeadlineAction =
  | { action: 'skip'; reason: 'pressure-resolved' }
  | { action: 'backoff'; nextDeadlineAt: number }
  | { action: 'restart' };

/**
 * Decide what an expired Tier 3 handoff deadline should do.
 *
 * - Context pressure already resolved (auto-compaction dropped usage below the
 *   handoff threshold, observed as low as 28%): skip the restart entirely and
 *   re-arm Tier 2 for a future climb.
 * - Session currently rate-limited: push the deadline back instead of
 *   restarting — the agent could not have cooperated with the handoff prompt.
 * - Otherwise: pressure persists and the agent ignored the prompt → restart.
 */
export function resolveHandoffDeadlineAction(opts: {
  now: number;
  effectivePct: number;
  handoffThreshold: number;
  rateLimited: boolean;
}): HandoffDeadlineAction {
  if (opts.effectivePct < opts.handoffThreshold) {
    return { action: 'skip', reason: 'pressure-resolved' };
  }
  if (opts.rateLimited) {
    return { action: 'backoff', nextDeadlineAt: opts.now + RATE_LIMIT_HANDOFF_BACKOFF_MS };
  }
  return { action: 'restart' };
}

/**
 * Fast message checker for a single agent.
 * Replaces fast-checker.sh: polls Telegram and inbox, injects into PTY.
 */
export class FastChecker {
  private agent: AgentProcess;
  private paths: BusPaths;
  private running: boolean = false;
  private pollInterval: number;
  private log: LogFn;
  private typingLastSent: number = 0;
  // Hook-based typing: track when we last injected a Telegram message (ms)
  private lastMessageInjectedAt: number = 0;
  // Track outbound message log size to detect when agent sends a reply
  private outboundLogSize: number = 0;
  // Track stdout log size to detect when agent is actively producing output
  private stdoutLogSize: number = -1;
  private frameworkRoot: string;
  private telegramApi?: TelegramAPI;
  private chatId?: string;
  private allowedUserId?: number;
  private daemonTelegramAlerts: boolean = true;
  private org: string = 'unknown';

  // Usage-limit dead-air guard: detects consecutive bounced turns and sends
  // one cooldown-guarded holding reply so the user never gets silent dead air.
  private deadAirGuard: DeadAirGuard = new DeadAirGuard();
  // stdout.log byte offset at probe arm time; -1 = no armed probe.
  private deadAirStdoutOffset: number = -1;

  // External Telegram handler (set by daemon)
  private telegramMessages: Array<{ formatted: string; ackIds: string[] }> = [];

  // Persistent dedup: message hashes to prevent duplicate delivery
  private seenHashes: Set<string> = new Set();
  private dedupFilePath: string = '';

  // SIGUSR1 wake: resolve to immediately wake from sleep
  private wakeResolve: (() => void) | null = null;

  // Idle-session heartbeat watchdog
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private staleTaskRecoveryTimer: NodeJS.Timeout | null = null;

  // Poll-cycle stall watchdog + circuit breaker
  private pollCycleWatchdog: NodeJS.Timeout | null = null;
  private lastPollCycleCompletedAt: number = 0;
  // Wall-clock time of the previous stall-watchdog tick. The watchdog runs on a
  // fixed 30s setInterval; a tick landing far later than that means the daemon
  // event loop was blocked, which the lag-guard in start() uses to distinguish
  // a true pollCycle wedge from a daemon-wide freeze.
  private lastWatchdogTickAt: number = 0;
  private watchdogRestarts: number[] = [];
  private watchdogCircuitBroken: boolean = false;
  private watchdogCircuitBrokenAt: number = 0;
  // Consecutive stall counter: only hard-restart after N consecutive watchdog ticks
  // that each detect a stall. Resets to 0 on any successful pollCycle completion.
  // Prevents a single transient stall (brief GC pause, slow Telegram call) from
  // triggering an immediate restart.
  private consecutiveStalls: number = 0;
  private readonly POLL_CYCLE_TIMEOUT_MS = 30_000;
  // Per-step timeout for outbound HTTP subprocess calls (gws, check-usage-api).
  // Tighter than POLL_CYCLE_TIMEOUT_MS so a single hung step can't monopolise the full 30s budget.
  private readonly STEP_HTTP_TIMEOUT_MS = 15_000;
  private readonly WATCHDOG_MAX_RESTARTS = 3;
  private readonly WATCHDOG_WINDOW_MS = 15 * 60 * 1000;   // 15 min
  private readonly WATCHDOG_CIRCUIT_RESET_MS = 30 * 60 * 1000; // 30 min
  private readonly WATCHDOG_CONSECUTIVE_THRESHOLD = 3;

  // Gmail watch state
  private gmailWatch?: { query: string; intervalMs: number };
  private gmailLastCheckedAt: number = 0;

  // Usage rate-limit guard state
  private usageLastCheckedAt: number = 0;
  private usageTier: 0 | 1 | 2 = 0; // 0=normal, 1=high(≥85%), 2=critical(≥95%)
  private usageTierFile: string = '';
  private readonly USAGE_CHECK_INTERVAL_MS = 15 * 60 * 1000;

  // Context-exhaustion + frozen-stdout watchdog state
  private bootstrappedAt: number = 0;
  private lastHardRestartAt: number = 0;
  private stdoutLastSize: number = 0;
  private stdoutLastChangeAt: number = 0;
  private watchdogTriggered: boolean = false;
  private readonly BOOTSTRAP_GRACE_MS = 10 * 60 * 1000;
  private readonly HARD_RESTART_COOLDOWN_MS = 15 * 60 * 1000;
  private readonly STDOUT_FROZEN_MS = 30 * 60 * 1000;

  // Context monitor state
  private ctxConfigMtime: number = 0;
  private ctxWarningFiredAt: number = 0;    // dedup: 15min cooldown between warnings
  private ctxHandoffFiredAt: number = 0;    // fires once per session (0 = not yet)
  private ctxHandoffDeadlineAt: number = 0; // timestamp after which force-restart fires
  private ctxAutoresetFiredAt: number = 0;  // Tier 0 auto-reset: fires once per session
  private ctxSessionStartedAt: number = 0;  // set on first session_id observed; gates Tier 0 boot-window
  private ctxLastSessionId: string | null = null; // detects new session → clears stale deadline
  private ctxCircuitRestarts: number[] = []; // timestamps of recent context-triggered restarts
  private ctxCircuitBrokenAt: number | null = null; // when circuit tripped (null = healthy)
  private sessionRefreshInProgress: boolean = false; // serialise concurrent forceContextRestart calls
  // Persisted to disk so --continue restarts don't reset the circuit breaker
  private ctxCircuitFile: string = '';
  // Cascade guard cache: avoids hammering the handoffs dir with readdirSync+statSync
  // on every 1s poll cycle when ctx thresholds are crossed but a recent handoff exists.
  private ctxCascadeGuardCachedAt: number = 0;
  private ctxCascadeGuardCachedResult: boolean = false;

  constructor(
    agent: AgentProcess,
    paths: BusPaths,
    frameworkRoot: string,
    options: {
      pollInterval?: number;
      log?: LogFn;
      telegramApi?: TelegramAPI;
      chatId?: string;
      allowedUserId?: number;
      gmailWatch?: { query: string; intervalMs: number };
      daemonTelegramAlerts?: boolean;
      org?: string;
    } = {},
  ) {
    this.agent = agent;
    this.paths = paths;
    this.frameworkRoot = frameworkRoot;
    this.pollInterval = options.pollInterval || 1000;
    this.log = options.log || ((msg) => console.log(`[fast-checker/${agent.name}] ${msg}`));
    this.telegramApi = options.telegramApi;
    this.chatId = options.chatId;
    this.allowedUserId = options.allowedUserId;
    this.daemonTelegramAlerts = options.daemonTelegramAlerts ?? true;
    this.org = options.org ?? 'unknown';

    // Initialize persistent dedup
    this.dedupFilePath = join(paths.stateDir, '.message-dedup-hashes');
    this.loadDedupHashes();

    // Initialize Gmail watch
    if (options.gmailWatch) {
      this.gmailWatch = options.gmailWatch;
    }

    // Initialize usage tier state
    this.usageTierFile = join(paths.stateDir, 'usage-tier.json');
    this.loadUsageTier();

    // Load persisted circuit breaker state so --continue restarts don't reset it
    this.ctxCircuitFile = join(paths.stateDir, '.ctx-circuit.json');
    this.loadCtxCircuit();
  }

  /**
   * Start the polling loop.
   */
  async start(): Promise<void> {
    this.running = true;
    this.log('Starting. Waiting for bootstrap...');

    // Register SIGUSR1 handler for immediate wake
    const sigusr1Handler = () => {
      this.log('SIGUSR1 received - waking immediately');
      if (this.wakeResolve) {
        this.wakeResolve();
        this.wakeResolve = null;
      }
    };
    if (process.platform !== 'win32') {
      process.on('SIGUSR1', sigusr1Handler);
    }

    // Wait for bootstrap
    await this.waitForBootstrap();
    this.log('Bootstrap complete. Beginning poll loop.');
    this.bootstrappedAt = Date.now();
    this.stdoutLastChangeAt = Date.now();

    // Re-notify user of any approvals that were pending before restart.
    // Runs once per session start; best-effort (errors are logged, not thrown).
    this.rescanPendingApprovals().catch(err => this.log(`rescanPendingApprovals error: ${err}`));

    // Mirror any in-progress tasks that may have been claimed during a gap window
    // (e.g. before the claimTask mirror hook shipped). Idempotent — upsert on UUIDv5 ID.
    this.backfillInProgressTasks().catch(err => this.log(`backfillInProgressTasks error: ${err}`));

    // Boot-time drain: flush any queued retry entries that accumulated while the
    // daemon was down. Short-lived CLI processes exit before setImmediate fires so
    // entries can stack up between restarts. The daemon is long-lived — safe to await.
    if (isMirrorEnabled()) {
      drainRetryQueue().catch(err => this.log(`boot drain error: ${err}`));
    }

    // Idle-session heartbeat watchdog: fires every 50 min regardless of REPL state
    const HEARTBEAT_INTERVAL_MS = 50 * 60 * 1000;
    const agentName = this.agent.name;
    this.heartbeatTimer = setInterval(() => {
      const ts = new Date().toISOString();
      execFile('cortextos', ['bus', 'update-heartbeat', `[watchdog] ${agentName} alive — idle session ${ts}`], (err) => {
        if (err) this.log(`Heartbeat watchdog error: ${err.message}`);
      });
    }, HEARTBEAT_INTERVAL_MS);

    // Stale-task recovery: hourly sweep (plus one at boot) that flips
    // in_progress tasks untouched for 24h+ to blocked with blocker context.
    // Without it a task claimed by a crashed agent sat in_progress forever.
    const STALE_RECOVERY_INTERVAL_MS = 60 * 60 * 1000;
    const runStaleRecovery = () => {
      try {
        const result = recoverStaleInProgressTasks(this.paths);
        if (result.recovered.length > 0) {
          this.log(`stale-task-recovery: blocked ${result.recovered.length} stale in_progress task(s): ${result.recovered.join(', ')}`);
        }
        for (const e of result.errors) {
          this.log(`stale-task-recovery: failed for ${e.id}: ${e.error}`);
        }
      } catch (err) {
        this.log(`stale-task-recovery error: ${err}`);
      }
    };
    runStaleRecovery();
    this.staleTaskRecoveryTimer = setInterval(runStaleRecovery, STALE_RECOVERY_INTERVAL_MS);

    // Poll-cycle stall watchdog: runs independently every 30s.
    // If pollCycle hasn't completed in 90s the loop is wedged — hard-restart.
    // A circuit breaker halts auto-restart after 3 trips in 15 min (upstream likely down).
    this.lastPollCycleCompletedAt = Date.now();
    const WATCHDOG_INTERVAL_MS = 30_000;
    const STALL_THRESHOLD_MS = 90_000;
    // A watchdog tick landing more than this much later than its 30s schedule
    // means the daemon event loop was blocked for the overshoot — see guard.
    const EVENT_LOOP_LAG_TOLERANCE_MS = 20_000;
    this.lastWatchdogTickAt = Date.now();
    this.pollCycleWatchdog = setInterval(() => {
      const now = Date.now();

      // Event-loop-lag guard.
      // The stall watchdog, the poll loop, and pollCycle's own 30s race-timeout
      // all run on the daemon's single shared event loop. When something blocks
      // that loop synchronously, all of them freeze together: the poll loop
      // cannot reach its end-of-iteration clock update, the 30s race-timeout
      // cannot fire, and lastPollCycleCompletedAt goes stale — not because
      // pollCycle is wedged, but because the whole loop was frozen. A per-agent
      // hard-restart cannot unblock a daemon-wide event-loop block, and firing
      // one per agent on every tick is the false-positive cascade behind the
      // hundreds of restarts and the Telegram spam.
      //
      // Detect it from the watchdog's own lateness: this setInterval is
      // scheduled every 30s, so a tick landing >50s after the previous one
      // means the loop was blocked for the overshoot. The stall reading is then
      // an artifact — absorb the gap (reset the stall clock), log the block for
      // diagnosis, and skip the restart. A genuine pollCycle wedge that leaves
      // the event loop responsive keeps watchdog ticks on-schedule, so the real
      // restart path below still fires for it.
      const tickGap = now - this.lastWatchdogTickAt;
      this.lastWatchdogTickAt = now;
      if (tickGap > WATCHDOG_INTERVAL_MS + EVENT_LOOP_LAG_TOLERANCE_MS) {
        const blockedSec = Math.round((tickGap - WATCHDOG_INTERVAL_MS) / 1000);
        this.log(
          `[watchdog] daemon event loop was blocked ~${blockedSec}s ` +
          `(watchdog tick ${Math.round(tickGap / 1000)}s late) — stall reading unreliable, ` +
          `skipping false-positive hard-restart`,
        );
        this.lastPollCycleCompletedAt = now;
        return;
      }

      if (this.bootstrappedAt === 0) return;
      if (now - this.bootstrappedAt < STALL_THRESHOLD_MS) return;

      // Auto-reset circuit breaker after 30 min of quiet
      if (this.watchdogCircuitBroken && now - this.watchdogCircuitBrokenAt > this.WATCHDOG_CIRCUIT_RESET_MS) {
        this.watchdogCircuitBroken = false;
        this.watchdogRestarts = [];
        // Reset stall clock on circuit reset: the 30-min quiet window would otherwise
        // appear as a 1800s stall on the very next watchdog tick, immediately firing
        // another restart and re-entering the cascade that caused the trip.
        this.lastPollCycleCompletedAt = now;
        this.log('Watchdog circuit breaker reset after 30min quiet window');
      }
      if (this.watchdogCircuitBroken) return;

      // Skip watchdog fire if agent is halted — zombie exits that trickle in after
      // max_crashes is hit would otherwise stall-detect and fire restarts past the halt gate.
      if (this.agent.getStatus().status === 'halted') {
        this.lastPollCycleCompletedAt = now;
        return;
      }

      const stallMs = now - this.lastPollCycleCompletedAt;
      if (stallMs <= STALL_THRESHOLD_MS) {
        this.consecutiveStalls = 0; // reset on healthy tick
        return;
      }

      // Require N consecutive stall detections before restarting.
      // A single transient stall (slow network call, brief GC) does not restart.
      this.consecutiveStalls++;
      if (this.consecutiveStalls < this.WATCHDOG_CONSECUTIVE_THRESHOLD) {
        this.log(
          `[watchdog] pollCycle stalled for ${Math.round(stallMs / 1000)}s — ` +
          `consecutive stall ${this.consecutiveStalls}/${this.WATCHDOG_CONSECUTIVE_THRESHOLD} (not restarting yet)`,
        );
        return;
      }
      this.consecutiveStalls = 0; // reset before restart so a re-trip counts fresh

      // Prune restart history older than the window
      this.watchdogRestarts = this.watchdogRestarts.filter(t => now - t < this.WATCHDOG_WINDOW_MS);

      // Circuit break: too many restarts mean restart isn't fixing it
      if (this.watchdogRestarts.length >= this.WATCHDOG_MAX_RESTARTS) {
        this.watchdogCircuitBroken = true;
        this.watchdogCircuitBrokenAt = now;
        const winMin = this.WATCHDOG_WINDOW_MS / 60_000;
        const resetMin = this.WATCHDOG_CIRCUIT_RESET_MS / 60_000;
        this.log(
          `Watchdog circuit breaker TRIPPED: ${this.watchdogRestarts.length} restarts in ${winMin}min. ` +
          `Halting auto-restart for ${resetMin}min — likely upstream issue. ` +
          `Check manually with: pm2 logs cortextos-daemon`,
        );
        if (this.telegramApi && this.chatId && this.daemonTelegramAlerts) {
          this.telegramApi
            .sendMessage(
              this.chatId,
              `⚠️ ${agentName} watchdog tripped — ${this.watchdogRestarts.length} auto-restarts in ${winMin}min. Restart loop paused ${resetMin}min. Likely upstream issue. Manual fix: pm2 restart cortextos-daemon`,
            )
            .catch(() => {});
        }
        this.lastPollCycleCompletedAt = now;
        return;
      }

      this.watchdogRestarts.push(now);
      this.log(
        `pollCycle stalled for ${Math.round(stallMs / 1000)}s — triggering hard-restart ` +
        `(${this.watchdogRestarts.length}/${this.WATCHDOG_MAX_RESTARTS} in ${this.WATCHDOG_WINDOW_MS / 60_000}min window)`,
      );
      this.triggerHardRestart(`pollCycle stalled for ${Math.round(stallMs / 1000)}s`);
      this.lastPollCycleCompletedAt = now;
    }, WATCHDOG_INTERVAL_MS);

    while (this.running) {
      try {
        // Check for urgent signal file
        this.checkUrgentSignal();
        // Race pollCycle against a timeout so a hung operation (e.g. stuck fetch,
        // slow execFile) can't freeze the loop indefinitely. If the timeout fires,
        // the underlying operation is abandoned and the loop continues on the next tick.
        await Promise.race([
          this.pollCycle(),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`pollCycle timeout after ${this.POLL_CYCLE_TIMEOUT_MS}ms`)),
              this.POLL_CYCLE_TIMEOUT_MS,
            ),
          ),
        ]);
      } catch (err) {
        this.log(`Poll error: ${err}`);
      }
      // One iteration is complete. Reaching this line proves the poll loop is
      // alive and cycling: pollCycle resolved, hit the 30s race timeout, or
      // threw (e.g. a Telegram "Conflict" back-off from a duplicate getUpdates
      // poller). None of those mean the loop is wedged, so the stall watchdog
      // must treat the cycle as completed and advance its clock here.
      //
      // The prior code advanced lastPollCycleCompletedAt only on clean success
      // or a literal "pollCycle timeout" error. Any other rejection — a
      // Telegram Conflict in particular — left the clock frozen, so the
      // watchdog hard-restarted a perfectly live loop after 90s. Each restart
      // spawned a fresh Telegram poller, deepening the Conflict and re-freezing
      // the clock: the hours-long restart cascade.
      //
      // A genuine synchronous freeze never lets control reach this line, so the
      // watchdog still detects a truly wedged loop.
      this.lastPollCycleCompletedAt = Date.now();
      this.consecutiveStalls = 0; // any completed cycle (success, timeout, or throw) resets stall count
      await this.sleepInterruptible(this.pollInterval);
    }

    if (process.platform !== 'win32') {
      process.removeListener('SIGUSR1', sigusr1Handler);
    }
  }

  /**
   * Stop the polling loop.
   */
  stop(): void {
    this.running = false;
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.pollCycleWatchdog !== null) {
      clearInterval(this.pollCycleWatchdog);
      this.pollCycleWatchdog = null;
    }
    if (this.staleTaskRecoveryTimer !== null) {
      clearInterval(this.staleTaskRecoveryTimer);
      this.staleTaskRecoveryTimer = null;
    }
  }

  /**
   * Trigger immediate wake from sleep.
   * Cross-platform alternative to SIGUSR1, called by IPC 'wake' command.
   */
  wake(): void {
    if (this.wakeResolve) {
      this.wakeResolve();
      this.wakeResolve = null;
    }
  }

  /**
   * Queue a formatted Telegram message for injection.
   * Called by the daemon's Telegram handler.
   */
  queueTelegramMessage(formatted: string): void {
    this.telegramMessages.push({ formatted, ackIds: [] });
  }

  /**
   * Single poll cycle: check inbox + queued Telegram messages.
   */
  private async pollCycle(): Promise<void> {
    // Per-step timing. The watchdog lag-guard in start() suppresses the
    // false-positive restart when the daemon event loop is blocked, but it
    // cannot remove the block. A synchronous block surfaces here as a single
    // step with a multi-second delta, naming the call that has to be fixed.
    const SLOW_STEP_MS = 8_000;
    let stepStartedAt = Date.now();
    const mark = (label: string): void => {
      const dt = Date.now() - stepStartedAt;
      if (dt > SLOW_STEP_MS) {
        this.log(`[pollCycle] slow step "${label}" took ${dt}ms — event-loop blocker candidate`);
      }
      stepStartedAt = Date.now();
    };

    let messageBlock = '';
    const ackIds: string[] = [];

    // Process queued Telegram messages
    let hasTelegramMessage = false;
    while (this.telegramMessages.length > 0) {
      const msg = this.telegramMessages.shift()!;
      messageBlock += msg.formatted;
      hasTelegramMessage = true;
    }

    // Check agent inbox
    const inboxMessages = checkInbox(this.paths);
    for (const msg of inboxMessages) {
      // Silently drop short ACK chatter from agent-to-agent bus so it never
      // reaches the Claude PTY and gets relayed to the user's Telegram chat.
      if (FastChecker.isAgentAck(msg)) {
        ackIds.push(msg.id);
        continue;
      }
      messageBlock += this.formatInboxMessage(msg);
      ackIds.push(msg.id);
    }
    mark('checkInbox');

    // Inject if there's anything
    if (messageBlock) {
      const injected = this.agent.injectMessage(messageBlock);
      mark('injectMessage');
      if (injected) {
        // ACK inbox messages
        for (const id of ackIds) {
          ackInbox(this.paths, id);
        }
        this.log(`Injected ${messageBlock.length} bytes`);
        // Only update typing timestamp for Telegram messages, not inbox/cron.
        // Inbox messages (agent-to-agent, session continuations) must not
        // restart the typing indicator after Stop has cleared it.
        if (hasTelegramMessage) {
          this.lastMessageInjectedAt = Date.now();
          this.armDeadAirProbe();
        }
        // Cooldown after injection (deliberate delay — not a blocker, not timed).
        await sleep(5000);
        stepStartedAt = Date.now();
      }
    }

    // Typing indicator: send while Claude is actively working
    if (this.chatId && this.telegramApi && this.isAgentActive()) {
      await this.sendTyping(this.telegramApi, this.chatId);
    }
    mark('sendTyping');

    // Watchdog: detect ctx-exhaustion survey + frozen stdout
    this.watchdogCheck();
    mark('watchdogCheck');

    // Dead-air guard: detect usage-limit bounced turns after Telegram injection
    this.checkDeadAir();
    mark('checkDeadAir');

    // Gmail watch: check on configured interval (default 15 min)
    await this.checkGmailWatch();
    mark('checkGmailWatch');

    // Usage rate-limit guard: check every 15 min
    await this.checkUsageTier();
    mark('checkUsageTier');

    // Context monitor: check usage thresholds and fire warnings/handoffs
    await this.checkContextStatus();
    mark('checkContextStatus');
  }

  /**
   * Arm the dead-air probe after a Telegram message is injected: remember the
   * current stdout.log size so checkDeadAir() only scans output produced after
   * this injection.
   */
  private armDeadAirProbe(): void {
    const now = Date.now();
    this.deadAirGuard.onInjection(now);
    const stdoutPath = join(this.paths.logDir, 'stdout.log');
    try {
      this.deadAirStdoutOffset = existsSync(stdoutPath) ? statSync(stdoutPath).size : 0;
    } catch {
      this.deadAirStdoutOffset = 0;
    }
  }

  /**
   * Tail stdout.log from the armed offset and feed new output to the guard.
   * When the guard fires (N consecutive usage-limit bounces, cooldown clear),
   * send ONE holding Telegram reply and log a bus event so the incident
   * surfaces in the morning brief / Warden.
   */
  private checkDeadAir(): void {
    if (this.deadAirStdoutOffset < 0) return;
    const now = Date.now();

    const stdoutPath = join(this.paths.logDir, 'stdout.log');
    let newOutput = '';
    try {
      if (existsSync(stdoutPath)) {
        const size = statSync(stdoutPath).size;
        if (size < this.deadAirStdoutOffset) {
          // Log rotated underneath us — restart scan from the top of the new file.
          this.deadAirStdoutOffset = 0;
        }
        if (size > this.deadAirStdoutOffset) {
          const fd = openSync(stdoutPath, 'r');
          try {
            // Cap each scan at 64 KB — bounce error text is short and recent.
            const len = Math.min(size - this.deadAirStdoutOffset, 64 * 1024);
            const buf = Buffer.alloc(len);
            const bytesRead = readSync(fd, buf, 0, len, this.deadAirStdoutOffset);
            newOutput = buf.toString('utf-8', 0, bytesRead);
            this.deadAirStdoutOffset += bytesRead;
          } finally {
            closeSync(fd);
          }
        }
      }
    } catch {
      // Unreadable log never blocks the poll cycle.
    }

    const fired = this.deadAirGuard.onOutput(newOutput, now);
    if (!this.deadAirGuard.isArmed()) {
      this.deadAirStdoutOffset = -1;
    }
    if (!fired) return;

    const bounces = this.deadAirGuard.getConsecutiveBounces();
    this.log(`Dead-air guard fired: ${bounces} consecutive usage-limit bounced turns — sending holding reply`);
    // Sent even when daemonTelegramAlerts is off: this is conversation
    // continuity for a user actively messaging this agent, not a proactive
    // daemon alert.
    if (this.telegramApi && this.chatId) {
      this.telegramApi.sendMessage(this.chatId, HOLDING_REPLY_TEXT).catch(() => {});
    }
    try {
      logEvent(this.paths, this.agent.name, this.org, 'action', 'degraded_responder_fired', 'warning', {
        consecutive_bounces: bounces,
      });
    } catch (err) {
      this.log(`Dead-air guard logEvent failed: ${err}`);
    }
  }

  /**
   * Detect stuck agent and trigger hard-restart.
   * Ported from CRM fast-checker.sh (FROZEN_RESTART + context-threshold logic).
   *
   * Two signals:
   *   1. Claude Code's "How is Claude doing this session?" survey prompt — fires
   *      when context is exhausted and the session needs to end. If it appears
   *      in stdout, the agent is cooked.
   *   2. stdout log unchanged for 30+ min while the agent is "active" (has a
   *      pending message and no idle flag) — passively frozen.
   */
  private watchdogCheck(): void {
    if (this.watchdogTriggered) return;
    const now = Date.now();
    if (this.bootstrappedAt === 0 || now - this.bootstrappedAt < this.BOOTSTRAP_GRACE_MS) return;
    if (this.lastHardRestartAt > 0 && now - this.lastHardRestartAt < this.HARD_RESTART_COOLDOWN_MS) return;

    const stdoutPath = join(this.paths.logDir, 'stdout.log');
    if (!existsSync(stdoutPath)) return;

    let size: number;
    try { size = statSync(stdoutPath).size; } catch { return; }

    if (size !== this.stdoutLastSize) {
      this.stdoutLastSize = size;
      this.stdoutLastChangeAt = now;
    }

    // Signal 1: scan last 20KB of stdout for the session-survey prompt.
    // Claude Code emits this when context is full ("How is Claude doing this session?").
    try {
      const tailBytes = Math.min(20000, size);
      if (tailBytes > 0) {
        const fd = openSync(stdoutPath, 'r');
        const buf = Buffer.alloc(tailBytes);
        readSync(fd, buf, 0, tailBytes, size - tailBytes);
        closeSync(fd);
        const tail = buf.toString('utf-8');
        if (/How is Claude doing this session\?/.test(tail)) {
          this.log('WATCHDOG: ctx-exhaustion survey prompt detected — hard-restarting');
          this.triggerHardRestart('ctx exhaustion: session survey prompt in stdout');
          return;
        }
      }
    } catch { /* non-critical */ }

    // Signal 2: stdout frozen for 30+ min while agent is active.
    if (
      this.lastMessageInjectedAt > 0 &&
      now - this.stdoutLastChangeAt > this.STDOUT_FROZEN_MS &&
      this.isAgentActive()
    ) {
      const stalledSec = Math.round((now - this.stdoutLastChangeAt) / 1000);
      this.log(`WATCHDOG: stdout frozen for ${stalledSec}s while active — hard-restarting`);
      this.triggerHardRestart(`frozen: stdout unchanged ${stalledSec}s while active`);
    }
  }

  private triggerHardRestart(reason: string): void {
    this.watchdogTriggered = true;
    this.lastHardRestartAt = Date.now();
    if (this.telegramApi && this.chatId && this.daemonTelegramAlerts) {
      this.telegramApi
        .sendMessage(this.chatId, `Got stuck (${reason}). Hard-restarting now.`)
        .catch(() => { /* non-critical */ });
    }
    this.forceContextRestart(reason);
  }

  /**
   * Poll Gmail for unread messages matching the configured query.
   *
   * Runs on the configured interval (default 15 min). Uses the `gws` CLI
   * (https://github.com/google-workspace-utilities/gws) which reads OAuth
   * credentials from ~/.config/gws/. Requires `gws` to be authenticated.
   *
   * If unread messages are found: writes an inbox message so Claude wakes
   * and processes them. If nothing matches: does nothing (zero Claude cost).
   * Claude is responsible for marking messages read after processing.
   */
  private async checkGmailWatch(): Promise<void> {
    if (!this.gmailWatch) return;
    const now = Date.now();
    if (now - this.gmailLastCheckedAt < this.gmailWatch.intervalMs) return;
    this.gmailLastCheckedAt = now;

    // Fetch unread message list
    let listOutput = '';
    try {
      listOutput = await new Promise<string>((resolve, reject) => {
        execFile('gws', ['gmail', 'users', 'messages', 'list',
          '--params', JSON.stringify({ userId: 'me', q: this.gmailWatch!.query }),
          '--format', 'json',
        ], { timeout: this.STEP_HTTP_TIMEOUT_MS }, (err, stdout) => {
          if (err) { reject(err); return; }
          resolve(stdout);
        });
      });
    } catch (err) {
      this.log(`Gmail watch list failed: ${err}`);
      return;
    }

    let messageIds: string[] = [];
    try {
      const data = JSON.parse(listOutput);
      messageIds = (data?.messages ?? []).map((m: { id: string }) => m.id).filter(Boolean);
    } catch {
      this.log('Gmail watch: could not parse list response');
      return;
    }

    if (messageIds.length === 0) return; // nothing to do

    // Fetch snippet + subject for each message (metadata format only)
    const summaries: string[] = [];
    for (const id of messageIds.slice(0, 20)) { // cap at 20 to avoid runaway fetches
      try {
        const getOutput = await new Promise<string>((resolve, reject) => {
          execFile('gws', ['gmail', 'users', 'messages', 'get',
            '--params', JSON.stringify({ userId: 'me', id, format: 'metadata', metadataHeaders: ['Subject', 'From'] }),
            '--format', 'json',
          ], { timeout: this.STEP_HTTP_TIMEOUT_MS }, (err, stdout) => {
            if (err) { reject(err); return; }
            resolve(stdout);
          });
        });
        const msg = JSON.parse(getOutput);
        const headers: Array<{ name: string; value: string }> = msg?.payload?.headers ?? [];
        const subject = headers.find(h => h.name === 'Subject')?.value ?? '(no subject)';
        const from = headers.find(h => h.name === 'From')?.value ?? '(unknown)';
        const snippet = msg?.snippet ?? '';
        summaries.push(`ID: ${id}\n   Subject: ${subject}\n   From: ${from}\n   Snippet: ${snippet.slice(0, 200)}`);
      } catch {
        summaries.push(`ID: ${id} (could not fetch details)`);
      }
    }

    const total = messageIds.length;
    const shown = summaries.length;
    const header = `=== GMAIL WATCH: ${total} unread message${total !== 1 ? 's' : ''} ===\n` +
      `Query: ${this.gmailWatch.query}\n\n`;
    const body = summaries.map((s, i) => `${i + 1}. ${s}`).join('\n\n');
    const footer = total > shown ? `\n\n(${total - shown} more not shown)` : '';
    const hint = `\n\nProcess: gws gmail users messages get --params '{"userId":"me","id":"<ID>","format":"full"}' --format json` +
      `\nMark read: gws gmail users messages modify --params '{"userId":"me","id":"<ID>"}' --body '{"removeLabelIds":["UNREAD"]}' --format json`;

    const inboxText = header + body + footer + hint;
    this.log(`Gmail watch: ${total} unread message(s) — writing inbox`);

    try {
      sendMessage(this.paths, 'fast-checker', this.agent.name, 'normal', inboxText);
    } catch (err) {
      this.log(`Gmail watch inbox write failed: ${err}`);
    }
  }

  /**
   * Check Claude Max API utilization and send tier-transition alerts.
   *
   * Runs every 15 minutes. Calls `cortextos bus check-usage-api` and reads
   * the JSON output. Computes tier (0=normal, 1=high≥85%, 2=critical≥95%).
   * On tier change: sends a Telegram alert directly (no Claude wake) and
   * writes an inbox message so Claude acts on it next time it is awake.
   * Tier state persists across restarts in usage-tier.json.
   */
  private async checkUsageTier(): Promise<void> {
    const now = Date.now();
    if (now - this.usageLastCheckedAt < this.USAGE_CHECK_INTERVAL_MS) return;
    this.usageLastCheckedAt = now;

    let rawJson = '';
    try {
      rawJson = await new Promise<string>((resolve, reject) => {
        // Pass high warn thresholds to suppress the script's own Telegram alerts —
        // we handle alerting ourselves on tier transitions only.
        execFile('cortextos', ['bus', 'check-usage-api', '--json'], { timeout: this.STEP_HTTP_TIMEOUT_MS }, (err, stdout) => {
          if (err) { reject(err); return; }
          resolve(stdout);
        });
      });
    } catch (err) {
      const errMsg = String(err);
      if (!errMsg.includes('No OAuth token') && !errMsg.includes('accounts.json')) {
        this.log(`Usage check failed: ${errMsg}`);
      }
      return;
    }

    let utilization = -1;
    try {
      const data = JSON.parse(rawJson);
      const fiveH = typeof data?.five_hour?.utilization === 'number'
        ? data.five_hour.utilization
        : typeof data?.five_hour_utilization === 'number'
          ? data.five_hour_utilization
          : -1;
      const sevenD = typeof data?.seven_day?.utilization === 'number'
        ? data.seven_day.utilization
        : typeof data?.seven_day_utilization === 'number'
          ? data.seven_day_utilization
          : -1;
      utilization = Math.max(fiveH, sevenD);
    } catch {
      this.log('Usage check: could not parse response');
      return;
    }

    if (utilization < 0) return;

    const newTier: 0 | 1 | 2 = utilization >= 95 ? 2 : utilization >= 85 ? 1 : 0;
    const prevTier = this.usageTier;

    if (newTier === prevTier) return; // no transition — stay quiet

    this.usageTier = newTier;
    this.saveUsageTier();

    const pct = Math.round(utilization);
    const msg = newTier === 0
      ? `Rate limit recovered. Utilization at ${pct}%. Resuming normal operations.`
      : newTier === 1
        ? `Rate limit at ${pct}%. Tier 1 wind-down: finish current task, no new autonomous work.`
        : `Rate limit at ${pct}%. Critical threshold reached. Going dark — do not start new work. Will notify on reset.`;

    this.log(`Usage tier transition: ${prevTier} → ${newTier} (${pct}%)`);

    // 1. Send Telegram alert directly (no Claude wake needed)
    if (this.telegramApi && this.chatId) {
      this.telegramApi.sendMessage(this.chatId, msg).catch(() => { /* non-critical */ });
    }

    // 2. Write inbox message so Claude acts on it next time it is awake
    try {
      sendMessage(this.paths, 'fast-checker', this.agent.name, 'urgent', msg);
    } catch (err) {
      this.log(`Usage tier inbox write failed: ${err}`);
    }
  }

  /**
   * Load usage tier from persistent file.
   */
  private loadUsageTier(): void {
    try {
      if (existsSync(this.usageTierFile)) {
        const data = JSON.parse(readFileSync(this.usageTierFile, 'utf-8'));
        if (data.tier === 0 || data.tier === 1 || data.tier === 2) {
          this.usageTier = data.tier;
        }
      }
    } catch {
      this.usageTier = 0;
    }
  }

  /**
   * Persist current usage tier to file.
   */
  private saveUsageTier(): void {
    try {
      atomicWriteSync(this.usageTierFile, JSON.stringify({ tier: this.usageTier, checkedAt: Date.now() }));
    } catch {
      // Non-critical
    }
  }

  /**
   * Returns true for short agent-to-agent ACK chatter that should be silently
   * consumed without being injected into the Claude PTY.
   *
   * Criteria: text is <=50 chars after trimming, OR the trimmed text is an
   * exact (case-insensitive) match to a known ACK phrase.  Only applies to
   * messages whose sender is NOT the user (i.e. from another agent, not from
   * the Telegram/user path).
   *
   * Why this exists: orchestrator sends short acknowledgements ("ACK",
   * "Done, thanks.", "Good catch") back to dev over the bus.  Without this
   * filter, Claude processes them and sometimes relays them to Greg's Telegram
   * chat, creating noise.
   */
  private static isAgentAck(msg: InboxMessage): boolean {
    const ACK_PHRASES = new Set([
      'ack', 'done', 'done, thanks.', 'done, thanks', 'good catch',
      'roger', 'noted', 'ok', 'okay', 'thanks', 'thank you', '👍', '✅',
    ]);
    const trimmed = msg.text.trim();
    if (trimmed.length <= 50) return true;
    if (ACK_PHRASES.has(trimmed.toLowerCase())) return true;
    return false;
  }

  /**
   * Format an inbox message for injection.
   * Matches bash fast-checker.sh format exactly.
   */
  private formatInboxMessage(msg: InboxMessage): string {
    const replyNote = msg.reply_to ? ` [reply_to: ${msg.reply_to}]` : '';
    return `=== AGENT MESSAGE from ${msg.from}${replyNote} [msg_id: ${msg.id}] ===
\`\`\`
${msg.text}
\`\`\`
Reply using: cortextos bus send-message ${msg.from} normal '<your reply>' ${msg.id}

`;
  }

  /**
   * Format a Telegram text message for injection.
   * Matches bash fast-checker.sh format.
   */
  static formatTelegramTextMessage(...args: Parameters<typeof formatTelegramTextMessage>): string {
    return formatTelegramTextMessage(...args);
  }

  /**
   * Format a Telegram message_reaction update for PTY injection.
   * Reactions are emoji additions/removals on existing messages — they
   * surface to the agent so it can follow up on positive acknowledgements
   * or clarify after a negative reaction.
   *
   * `newReaction` is the current reaction state (an empty list means the
   * user REMOVED their reaction). `oldReaction` lets the formatter
   * distinguish "added X" from "removed Y". Custom emoji (type=custom_emoji)
   * render as [custom_emoji] since we don't resolve the custom_emoji_id.
   */
  static formatTelegramReaction(...args: Parameters<typeof formatTelegramReaction>): string {
    return formatTelegramReaction(...args);
  }

  /**
   * Format a Telegram photo message for injection.
   * Matches bash fast-checker.sh format.
   */
  static formatTelegramPhotoMessage(...args: Parameters<typeof formatTelegramPhotoMessage>): string {
    return formatTelegramPhotoMessage(...args);
  }

  /**
   * Format a Telegram document message for injection.
   * Matches bash fast-checker.sh format.
   */
  static formatTelegramDocumentMessage(...args: Parameters<typeof formatTelegramDocumentMessage>): string {
    return formatTelegramDocumentMessage(...args);
  }

  /**
   * Format a Telegram voice/audio message for injection.
   * Matches bash fast-checker.sh format.
   *
   * `transcript` is populated by `src/telegram/transcribe.ts` when whisper-cli
   * and the GGML model are available; otherwise it stays undefined and the
   * agent receives only the .ogg path. The codex extractor surfaces the
   * transcript block when present.
   */
  static formatTelegramVoiceMessage(...args: Parameters<typeof formatTelegramVoiceMessage>): string {
    return formatTelegramVoiceMessage(...args);
  }

  /**
   * Format a Telegram video/video_note message for injection.
   * Matches bash fast-checker.sh format.
   */
  static formatTelegramVideoMessage(...args: Parameters<typeof formatTelegramVideoMessage>): string {
    return formatTelegramVideoMessage(...args);
  }

  /**
   * Wait for the agent to finish bootstrapping.
   */
  private async waitForBootstrap(timeoutMs: number = 30000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.agent.isBootstrapped()) {
        return;
      }
      await sleep(2000);
    }
    this.log('Bootstrap timeout - proceeding anyway');
  }

  /**
   * Send typing indicator, rate-limited to once every 4 seconds.
   */
  private async sendTyping(api: TelegramAPI, chatId: string): Promise<void> {
    const now = Date.now();
    if (now - this.typingLastSent >= 4000) {
      try {
        await api.sendChatAction(chatId, 'typing');
      } catch {
        // Ignore typing indicator failures (matches bash: || true)
      }
      this.typingLastSent = now;
    }
  }

  /**
   * Read the last-sent message file for conversation context.
   * Returns the content (up to 500 chars) or null if not available.
   */
  static readLastSent(...args: Parameters<typeof readLastSent>): string | null {
    return readLastSent(...args);
  }

  /**
   * Handle a callback from the org's activity-channel bot.
   *
   * Runs alongside the agent's primary bot callback handler when the agent
   * is the org's orchestrator (see agent-manager.ts for the wiring). Only
   * appr_(allow|deny)_<approvalId> prefixes are accepted here — the
   * activity-channel bot only ever posts approval buttons, so any other
   * callback is rejected. The responding API must be the activity-channel
   * API (not the agent's own bot) so answerCallbackQuery + editMessageText
   * target the right message on the right bot.
   */
  async handleActivityCallback(query: TelegramCallbackQuery, activityApi: TelegramAPI): Promise<void> {
    const data = stripControlChars(query.data || '');
    const callbackQueryId = query.id;

    // SECURITY: callbacks must come from the whitelisted user. Identical
    // check to handleCallback — approval clicks are as sensitive as
    // permission clicks and the same gate applies.
    if (this.allowedUserId !== undefined) {
      const fromUserId = query.from?.id;
      if (fromUserId !== this.allowedUserId) {
        this.log(`SECURITY: activity-channel callback from unauthorized user ${fromUserId} - rejecting`);
        try { await activityApi.answerCallbackQuery(callbackQueryId, 'Not authorized'); } catch { /* ignore */ }
        return;
      }
    }

    const apprMatch = data.match(/^appr_(allow|deny)_(approval_\d+_[a-zA-Z0-9]+)$/);
    if (!apprMatch) {
      this.log(`activity-channel callback ignored (unknown prefix): ${data.slice(0, 40)}`);
      try { await activityApi.answerCallbackQuery(callbackQueryId, 'Unknown button'); } catch { /* ignore */ }
      return;
    }

    await this.routeApprovalCallback(apprMatch[1] as 'allow' | 'deny', apprMatch[2], query, activityApi);
  }

  /**
   * On session start, re-notify the user of any approvals that were in
   * pending/ before the restart. Without this, a crash while an approval is
   * pending leaves the approval silently sitting in pending/ forever — the
   * user never gets another notification and the requesting agent stays blocked.
   *
   * Sends one Telegram message per pending approval with Approve/Deny buttons
   * (same callback_data format as createApproval's activity-channel post, so
   * handleCallback routes them correctly). No-ops if Telegram is not configured.
   *
   * Best-effort: errors are logged and never propagate to the caller.
   */
  private async rescanPendingApprovals(): Promise<void> {
    if (!this.telegramApi || !this.chatId) return;
    // Only the orchestrator re-broadcasts pending approvals on restart.
    // Approvals are stored org-level (shared across all agents), so without
    // this guard every restarting agent would ping Greg via its own bot —
    // the direct cause of the multi-bot approval spam reported 2026-05-23.
    const orchName = process.env.CTX_ORCHESTRATOR || 'orchestrator';
    if (this.agent.name !== orchName) return;

    let pending;
    try {
      pending = listPendingApprovals(this.paths);
    } catch {
      return; // approvalDir missing or unreadable — nothing to do
    }

    if (pending.length === 0) return;
    this.log(`rescanPendingApprovals: ${pending.length} pending approval(s) found — re-notifying`);

    const resolvedDir = join(this.paths.approvalDir, 'resolved');
    for (const approval of pending) {
      // Belt-and-suspenders: listPendingApprovals() already filters orphaned
      // entries (file in both pending/ and resolved/), but we re-verify here to
      // guard against the race window where an approval is resolved between the
      // scan and this notification loop (e.g. Greg approved via the original
      // Telegram card while the daemon was restarting).
      if (existsSync(join(resolvedDir, `${approval.id}.json`))) {
        this.log(`rescanPendingApprovals: skipping ${approval.id} — already in resolved/`);
        continue;
      }
      // Third guard: check the status field in the pending file itself.
      // An approval resolved through a non-callback path (e.g. RGOS web UI) may
      // update the status field without moving the file, leaving a stale pending/
      // entry that would otherwise trigger a spurious re-notification every restart.
      if (approval.status && approval.status !== 'pending') {
        this.log(`rescanPendingApprovals: skipping ${approval.id} — status is '${approval.status}' (not pending)`);
        try { unlinkSync(join(this.paths.approvalDir, 'pending', `${approval.id}.json`)); } catch { /* */ }
        continue;
      }
      try {
        const lines = [
          `⏳ Pending approval (restart re-notify): ${approval.title}`,
          `Category: ${approval.category}`,
          `Requested by: ${approval.requesting_agent}`,
        ];
        if (approval.description) lines.push('', approval.description);
        lines.push('', `id: ${approval.id}`);

        const keyboard = {
          inline_keyboard: [[
            { text: '✅ Approve', callback_data: `appr_allow_${approval.id}` },
            { text: '❌ Deny', callback_data: `appr_deny_${approval.id}` },
          ]],
        };

        await this.telegramApi.sendMessage(this.chatId, lines.join('\n'), keyboard);
        this.log(`rescanPendingApprovals: re-notified for ${approval.id}`);
      } catch (err) {
        this.log(`rescanPendingApprovals: failed to re-notify ${approval.id}: ${err}`);
      }
    }
  }

  /**
   * On session start, push any locally in-progress tasks to the RGOS mirror.
   * Handles the gap window where claimTask ran before the mirror hook shipped.
   * Idempotent — all mirror operations are upserts (POST + Prefer:merge-duplicates).
   * No-ops immediately if the task directory does not exist (first-boot guard).
   */
  private async backfillInProgressTasks(): Promise<void> {
    // listTasks() already returns [] when taskDir is missing; explicit guard for clarity.
    if (!existsSync(this.paths.taskDir)) return;

    const tasks = listTasks(this.paths, { status: 'in_progress' });
    if (tasks.length === 0) return;

    this.log(`backfillInProgressTasks: mirroring ${tasks.length} in-progress task(s) to RGOS`);
    for (const task of tasks) {
      await mirrorTaskToRgos(task, 'update').catch(err =>
        this.log(`backfillInProgressTasks: failed to mirror ${task.id}: ${err}`),
      );
    }
    this.log(`backfillInProgressTasks: done`);
  }

  /**
   * Shared approval-callback resolution path. Called by both handleCallback
   * (agent's own bot) and handleActivityCallback (activity-channel bot).
   *
   * Resolves the approval via updateApproval (which moves the file from
   * pending/ to resolved/ and notifies the requesting agent via inbox),
   * answers the Telegram callback so the spinner stops, and edits the
   * original message to show who approved/denied for the audit trail.
   *
   * `api` is the TelegramAPI that owns the bot the callback came from —
   * answerCallbackQuery and editMessageText must target the same bot.
   */
  private async routeApprovalCallback(
    decision: 'allow' | 'deny',
    approvalId: string,
    query: TelegramCallbackQuery,
    api: TelegramAPI | undefined,
  ): Promise<void> {
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;
    const callbackQueryId = query.id;
    const status = decision === 'allow' ? 'approved' : 'rejected';

    // Build a friendly audit-trail suffix: "by Alice (@alice)" or just
    // "by Alice" if no username. Falls back to the Telegram user id if
    // both are missing (shouldn't happen in practice but guards edge).
    const firstName = query.from?.first_name;
    const username = query.from?.username;
    const auditWho = firstName && username
      ? `${firstName} (@${username})`
      : firstName ?? (username ? `@${username}` : `user ${query.from?.id ?? 'unknown'}`);
    const auditNote = `via Telegram activity channel by ${auditWho}`;

    try {
      updateApproval(this.paths, approvalId, status, auditNote);
    } catch (err) {
      this.log(`Approval callback: updateApproval failed for ${approvalId}: ${err}`);
      if (api) {
        try { await api.answerCallbackQuery(callbackQueryId, 'Approval not found or already resolved'); } catch { /* ignore */ }
      }
      return;
    }

    // Best-effort: if the resolved approval has a linked Supabase orch_approvals
    // row, PATCH its status so the Hub Pending Approvals panel reflects the decision.
    try {
      const resolved = readApproval(this.paths, approvalId);
      const orchId = resolved?.linked_orch_approval_id;
      if (orchId) {
        const supabaseUrl = process.env.SUPABASE_RGOS_URL || process.env.SUPABASE_URL || '';
        const serviceKey = process.env.SUPABASE_RGOS_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
        if (supabaseUrl && serviceKey) {
          fetch(`${supabaseUrl}/rest/v1/orch_approvals?id=eq.${encodeURIComponent(orchId)}`, {
            method: 'PATCH',
            headers: {
              'apikey': serviceKey,
              'Authorization': `Bearer ${serviceKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              status,
              decided_by: auditWho,
              decided_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            }),
            signal: AbortSignal.timeout(10000),
          }).catch((err) => this.log(`Approval callback: Supabase sync failed for ${orchId}: ${err}`));
        }
      }
    } catch {
      // Non-fatal — local approval already resolved
    }

    if (api) {
      try { await api.answerCallbackQuery(callbackQueryId, decision === 'allow' ? 'Approved' : 'Denied'); } catch { /* ignore */ }
      if (chatId && messageId) {
        const label = decision === 'allow' ? `✅ Approved by ${auditWho}` : `❌ Denied by ${auditWho}`;
        try { await api.editMessageText(chatId, messageId, label); } catch { /* ignore */ }
      }
    }
    this.log(`Approval callback: ${decision} for ${approvalId} by ${auditWho}`);
  }

  /**
   * Handle a Telegram inline button callback query.
   * Routes to permission, restart, or AskUserQuestion handlers.
   */
  async handleCallback(query: TelegramCallbackQuery): Promise<void> {
    const data = stripControlChars(query.data || '');
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;
    const callbackQueryId = query.id;

    // SECURITY: callbacks must come from the whitelisted user. Without this,
    // anyone who sees a button (forwarded message, group, etc.) could click it.
    if (this.allowedUserId !== undefined) {
      const fromUserId = query.from?.id;
      if (fromUserId !== this.allowedUserId) {
        this.log(`SECURITY: callback from unauthorized user ${fromUserId} - rejecting`);
        return;
      }
    }

    // Approval callbacks: appr_(allow|deny)_{approvalId}
    // These originate from the org's activity channel bot (see
    // handleActivityCallback) but may also arrive here if an operator
    // ever routes an approval button through the agent's own bot. The
    // prefix check is cheap and routing-agnostic.
    const apprMatch = data.match(/^appr_(allow|deny)_(approval_\d+_[a-zA-Z0-9]+)$/);
    if (apprMatch) {
      await this.routeApprovalCallback(apprMatch[1] as 'allow' | 'deny', apprMatch[2], query, this.telegramApi);
      return;
    }

    // Permission callbacks: perm_(allow|deny|continue)_{hexId}
    const permMatch = data.match(/^perm_(allow|deny|continue)_([a-f0-9]+)$/);
    if (permMatch) {
      const [, decision, hexId] = permMatch;
      const hookDecision = decision === 'continue' ? 'deny' : decision;
      const responseFile = join(this.paths.stateDir, `hook-response-${hexId}.json`);
      writeFileSync(responseFile, JSON.stringify({ decision: hookDecision }) + '\n', 'utf-8');

      if (this.telegramApi) {
        try { await this.telegramApi.answerCallbackQuery(callbackQueryId, 'Got it'); } catch { /* ignore */ }
        if (chatId && messageId) {
          const labelMap: Record<string, string> = { allow: 'Approved', deny: 'Denied', continue: 'Continue in Chat' };
          try { await this.telegramApi.editMessageText(chatId, messageId, labelMap[decision] || decision); } catch { /* ignore */ }
        }
      }
      this.log(`Permission callback: ${decision} for ${hexId}`);
      return;
    }

    // Restart callbacks: restart_(allow|deny)_{hexId}
    const restartMatch = data.match(/^restart_(allow|deny)_([a-f0-9]+)$/);
    if (restartMatch) {
      const [, decision, hexId] = restartMatch;
      const responseFile = join(this.paths.stateDir, `restart-response-${hexId}.json`);
      writeFileSync(responseFile, JSON.stringify({ decision }) + '\n', 'utf-8');

      if (this.telegramApi) {
        try { await this.telegramApi.answerCallbackQuery(callbackQueryId, 'Got it'); } catch { /* ignore */ }
        if (chatId && messageId) {
          const label = decision === 'allow' ? 'Restart Approved' : 'Restart Denied';
          try { await this.telegramApi.editMessageText(chatId, messageId, label); } catch { /* ignore */ }
        }
      }
      this.log(`Restart callback: ${decision} for ${hexId}`);
      return;
    }

    // AskUserQuestion single-select: askopt_{questionIdx}_{optionIdx}
    const askoptMatch = data.match(/^askopt_(\d+)_(\d+)$/);
    if (askoptMatch) {
      const qIdx = parseInt(askoptMatch[1], 10);
      const oIdx = parseInt(askoptMatch[2], 10);

      if (this.telegramApi) {
        try { await this.telegramApi.answerCallbackQuery(callbackQueryId, 'Got it'); } catch { /* ignore */ }
        if (chatId && messageId) {
          try { await this.telegramApi.editMessageText(chatId, messageId, 'Answered'); } catch { /* ignore */ }
        }
      }

      // Navigate TUI: Down * oIdx, then Enter
      for (let k = 0; k < oIdx; k++) {
        this.agent.write(KEYS.DOWN);
        await sleep(50);
      }
      await sleep(100);
      this.agent.write(KEYS.ENTER);

      this.log(`AskUserQuestion: Q${qIdx} selected option ${oIdx}`);

      // Check for more questions
      const askStatePath = join(this.paths.stateDir, 'ask-state.json');
      if (existsSync(askStatePath)) {
        try {
          const state = JSON.parse(readFileSync(askStatePath, 'utf-8'));
          const totalQ = state.total_questions || 1;
          const nextQ = qIdx + 1;
          if (nextQ < totalQ) {
            state.current_question = nextQ;
            writeFileSync(askStatePath, JSON.stringify(state) + '\n', 'utf-8');
            await sleep(500);
            await this.sendNextQuestion(nextQ);
          } else {
            await sleep(500);
            this.agent.write(KEYS.ENTER);
            this.log('AskUserQuestion: submitted all answers');
            try { unlinkSync(askStatePath); } catch { /* ignore */ }
          }
        } catch { /* ignore parse errors */ }
      }
      return;
    }

    // AskUserQuestion multi-select toggle: asktoggle_{questionIdx}_{optionIdx}
    const toggleMatch = data.match(/^asktoggle_(\d+)_(\d+)$/);
    if (toggleMatch) {
      const qIdx = parseInt(toggleMatch[1], 10);
      const oIdx = parseInt(toggleMatch[2], 10);

      if (this.telegramApi) {
        try { await this.telegramApi.answerCallbackQuery(callbackQueryId, 'Toggled'); } catch { /* ignore */ }
      }

      const askStatePath = join(this.paths.stateDir, 'ask-state.json');
      if (existsSync(askStatePath)) {
        try {
          const state = JSON.parse(readFileSync(askStatePath, 'utf-8'));
          if (!state.multi_select_chosen) state.multi_select_chosen = [];

          const idx = state.multi_select_chosen.indexOf(oIdx);
          if (idx === -1) {
            state.multi_select_chosen.push(oIdx);
          } else {
            state.multi_select_chosen.splice(idx, 1);
          }
          writeFileSync(askStatePath, JSON.stringify(state) + '\n', 'utf-8');

          // Update Telegram message with current selections
          if (this.telegramApi && chatId && messageId) {
            const chosen = [...state.multi_select_chosen].sort((a: number, b: number) => a - b);
            const chosenDisplay = chosen.map((i: number) => i + 1).join(', ');
            const question = state.questions?.[qIdx];
            const options: string[] = question?.options || [];

            // Build keyboard with toggle buttons + submit
            const keyboard: Array<Array<{ text: string; callback_data: string }>> = options.map((opt: string, i: number) => [{
              text: opt || `Option ${i + 1}`,
              callback_data: `asktoggle_${qIdx}_${i}`,
            }]);
            keyboard.push([{ text: 'Submit Selections', callback_data: `asksubmit_${qIdx}` }]);

            const text = chosenDisplay
              ? `Selected: ${chosenDisplay}\nTap more options or Submit`
              : 'Tap options to toggle, then tap Submit';

            try {
              await this.telegramApi.editMessageText(chatId, messageId, text, { inline_keyboard: keyboard });
            } catch { /* ignore */ }
          }
        } catch { /* ignore parse errors */ }
      }
      this.log(`AskUserQuestion: Q${qIdx} toggled option ${oIdx}`);
      return;
    }

    // AskUserQuestion multi-select submit: asksubmit_{questionIdx}
    const submitMatch = data.match(/^asksubmit_(\d+)$/);
    if (submitMatch) {
      const qIdx = parseInt(submitMatch[1], 10);

      if (this.telegramApi) {
        try { await this.telegramApi.answerCallbackQuery(callbackQueryId, 'Submitted'); } catch { /* ignore */ }
        if (chatId && messageId) {
          try { await this.telegramApi.editMessageText(chatId, messageId, 'Submitted'); } catch { /* ignore */ }
        }
      }

      const askStatePath = join(this.paths.stateDir, 'ask-state.json');
      if (existsSync(askStatePath)) {
        try {
          const state = JSON.parse(readFileSync(askStatePath, 'utf-8'));
          const chosenIndices: number[] = [...(state.multi_select_chosen || [])].sort((a, b) => a - b);
          const question = state.questions?.[qIdx];
          const totalOpts = question?.options?.length || 4;

          // Navigate TUI: for each chosen index, move Down from current position, press Space
          let currentPos = 0;
          for (const idx of chosenIndices) {
            const moves = idx - currentPos;
            for (let k = 0; k < moves; k++) {
              this.agent.write(KEYS.DOWN);
              await sleep(50);
            }
            this.agent.write(KEYS.SPACE);
            await sleep(50);
            currentPos = idx;
          }

          // Navigate to Submit button (past all options + 1 for "Other")
          const submitPos = totalOpts + 1;
          const remaining = submitPos - currentPos;
          for (let k = 0; k < remaining; k++) {
            this.agent.write(KEYS.DOWN);
            await sleep(50);
          }
          await sleep(100);
          this.agent.write(KEYS.ENTER);

          this.log(`AskUserQuestion: Q${qIdx} submitted multi-select`);

          // Reset multi_select_chosen
          state.multi_select_chosen = [];
          writeFileSync(askStatePath, JSON.stringify(state) + '\n', 'utf-8');

          // Check for more questions
          const totalQ = state.total_questions || 1;
          const nextQ = qIdx + 1;
          if (nextQ < totalQ) {
            state.current_question = nextQ;
            writeFileSync(askStatePath, JSON.stringify(state) + '\n', 'utf-8');
            await sleep(500);
            await this.sendNextQuestion(nextQ);
          } else {
            await sleep(500);
            this.agent.write(KEYS.ENTER);
            this.log('AskUserQuestion: submitted all answers');
            try { unlinkSync(askStatePath); } catch { /* ignore */ }
          }
        } catch { /* ignore parse errors */ }
      }
      return;
    }

    this.log(`Unhandled callback data: ${data}`);
  }

  /**
   * Send the next AskUserQuestion to Telegram.
   * Reads ask-state.json and builds the question message and inline keyboard.
   */
  async sendNextQuestion(questionIdx: number): Promise<void> {
    if (!this.telegramApi || !this.chatId) {
      this.log('sendNextQuestion: no Telegram API or chatId configured');
      return;
    }

    const askStatePath = join(this.paths.stateDir, 'ask-state.json');
    if (!existsSync(askStatePath)) {
      this.log('sendNextQuestion: state file not found');
      return;
    }

    try {
      const state = JSON.parse(readFileSync(askStatePath, 'utf-8'));
      const totalQ = state.total_questions || 1;
      const question = state.questions?.[questionIdx];
      if (!question) {
        this.log(`sendNextQuestion: question ${questionIdx} not found`);
        return;
      }

      const qText = question.question || 'Question';
      const qHeader = question.header || '';
      const qMulti = question.multiSelect === true;
      const qOptions: string[] = question.options || [];

      // Build message text
      let msg = `QUESTION (${questionIdx + 1}/${totalQ}) - ${this.agent.name}:`;
      if (qHeader) msg += `\n${qHeader}`;
      msg += `\n${qText}\n`;
      if (qMulti) {
        msg += '\n(Multi-select: tap options to toggle, then tap Submit)';
      }
      for (let i = 0; i < qOptions.length; i++) {
        msg += `\n${i + 1}. ${qOptions[i] || `Option ${i + 1}`}`;
      }

      // Build inline keyboard
      let keyboard: Array<Array<{ text: string; callback_data: string }>>;
      if (qMulti) {
        keyboard = qOptions.map((opt, i) => [{
          text: opt || `Option ${i + 1}`,
          callback_data: `asktoggle_${questionIdx}_${i}`,
        }]);
        keyboard.push([{ text: 'Submit Selections', callback_data: `asksubmit_${questionIdx}` }]);
      } else {
        keyboard = qOptions.map((opt, i) => [{
          text: opt || `Option ${i + 1}`,
          callback_data: `askopt_${questionIdx}_${i}`,
        }]);
      }

      await this.telegramApi.sendMessage(this.chatId, msg, { inline_keyboard: keyboard });
      this.log(`Sent question ${questionIdx + 1}/${totalQ} to Telegram`);
    } catch (err) {
      this.log(`sendNextQuestion error: ${err}`);
    }
  }

  /**
   * Sleep that can be interrupted by SIGUSR1.
   */
  private sleepInterruptible(ms: number): Promise<void> {
    return new Promise(resolve => {
      const timer = setTimeout(resolve, ms);
      this.wakeResolve = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  /**
   * Check for .urgent-signal file and process it.
   */
  private checkUrgentSignal(): void {
    const urgentPath = join(this.paths.stateDir, '.urgent-signal');
    if (existsSync(urgentPath)) {
      try {
        const content = readFileSync(urgentPath, 'utf-8').trim();
        this.log(`Urgent signal detected: ${content}`);
        unlinkSync(urgentPath);

        // Inject the urgent message
        if (content) {
          const urgentMsg = `=== URGENT SIGNAL ===\n\`\`\`\n${content}\n\`\`\`\n\n`;
          this.agent.injectMessage(urgentMsg);
        }
      } catch (err) {
        this.log(`Error processing urgent signal: ${err}`);
      }
    }
  }

  /**
   * Read ctx thresholds from config.json with mtime-based caching (BUG-048 pattern).
   * Re-reads from disk only when the file has changed so dashboard updates take effect
   * within one poll cycle without a daemon restart.
   *
   * `autoreset` is 0 when disabled (absent or explicit 0). Any value > 0 arms the
   * Tier 0 silent auto-reset path.
   */
  private getCtxThresholds(): { warn: number; handoff: number; autoreset: number } {
    try {
      const configPath = join(this.agent.getAgentDir(), 'config.json');
      const mtime = statSync(configPath).mtimeMs;
      if (mtime !== this.ctxConfigMtime) {
        const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
        const config = this.agent.getConfig();
        config.ctx_warning_threshold = cfg.ctx_warning_threshold;
        config.ctx_handoff_threshold = cfg.ctx_handoff_threshold;
        config.ctx_autoreset_threshold = cfg.ctx_autoreset_threshold;
        this.ctxConfigMtime = mtime;
      }
    } catch { /* keep stale values */ }
    const config = this.agent.getConfig();
    const raw = config.ctx_autoreset_threshold;
    const autoreset = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 0;
    // Treat 0 as "use default" (disabled) — a threshold of 0 means "fire at 0% context"
    // which is never the intent. Agents that want to disable the monitor set thresholds
    // to 0; treating those as the default (70/80) keeps the feature off for them since
    // their context will rarely reach 70-80% before a natural session boundary.
    const warnRaw = config.ctx_warning_threshold;
    const handoffRaw = config.ctx_handoff_threshold;
    return {
      warn: typeof warnRaw === 'number' && warnRaw > 0 ? warnRaw : 70,
      handoff: typeof handoffRaw === 'number' && handoffRaw > 0 ? handoffRaw : 80,
      autoreset,
    };
  }

  /**
   * Best-effort NON-BLOCKING snapshot for the current agent. Called by Tier 0
   * alongside a force-restart. Launched detached with `spawn` so the 1s poll
   * loop is never blocked by slow I/O in the snapshot chain (Neon INSERT,
   * memory file append). Always --silent (daemon-initiated auto-resets must
   * not page Logan).
   *
   * We do NOT wait for the snapshot to finish. The caller proceeds with
   * hardRestart + sessionRefresh immediately. Worst case: the agent process
   * dies while the snapshot is mid-write. Partial snapshot is acceptable —
   * losing context is what we are avoiding, and the Neon + memory steps are
   * each individually idempotent (append-only, insert-only).
   */
  private runAutoresetSnapshot(reason: string): void {
    try {
      const scriptPath = join(this.frameworkRoot, 'scripts', 'snapshot-agent.sh');
      if (!existsSync(scriptPath)) {
        this.log(`snapshot-agent.sh not found at ${scriptPath} — skipping snapshot`);
        return;
      }
      const child = spawn('bash', [scriptPath, this.agent.name, '--silent', '--reason', reason], {
        env: {
          ...process.env,
          CTX_AGENT_NAME: this.agent.name,
          CTX_AGENT_DIR: this.agent.getAgentDir(),
          CTX_FRAMEWORK_ROOT: this.frameworkRoot,
        },
        stdio: 'ignore',
        detached: true,
      });
      child.on('error', err => this.log(`snapshot-agent.sh spawn failed (non-fatal): ${err.message}`));
      // unref so the Node event loop is not kept alive by the child
      child.unref();
    } catch (err) {
      // Snapshot failed to spawn. Caller still restarts — losing a snapshot is
      // better than letting the agent drift toward the hard 80% handoff tier.
      this.log(`snapshot-agent.sh failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Whether the tail of the PTY output shows a usage-limit turn bounce.
   * Reuses the dead-air guard's bounce patterns (status-bar usage text does
   * NOT match). Window is deliberately small: once the agent produces ~4KB of
   * normal output past a bounce, it no longer counts as "currently limited".
   * A quiet agent keeps matching, which is fine — deferral while idle is free
   * because context cannot grow without processed turns.
   */
  private isRecentOutputRateLimited(): boolean {
    return matchesUsageLimitBounce(this.agent.getOutputBuffer()?.getRecent(4000) ?? '');
  }

  /**
   * Context monitor — called on every poll cycle.
   * Reads context_status.json written by the statusLine bridge hook and takes
   * action when thresholds are crossed.
   */
  private async checkContextStatus(): Promise<void> {
    const now = Date.now();

    // Circuit breaker: check if we should pause auto-restarts
    if (this.ctxCircuitBrokenAt !== null) {
      if (now - this.ctxCircuitBrokenAt >= 30 * 60_000) {
        this.ctxCircuitBrokenAt = null;
        this.ctxCircuitRestarts = [];
        this.saveCtxCircuit();
        this.log('Context circuit breaker reset after 30min pause');
      } else {
        return; // still paused
      }
    }

    // Read the bridge file written by hook-context-status
    const statusPath = join(this.paths.stateDir, 'context_status.json');
    if (!existsSync(statusPath)) return;

    let pct: number | null = null;
    let exceeds200k = false;
    try {
      const raw = readFileSync(statusPath, 'utf-8');
      const data = JSON.parse(raw);
      const age = now - new Date(data.written_at || 0).getTime();
      if (age > 10 * 60_000) return; // stale file — skip
      pct = typeof data.used_percentage === 'number' ? data.used_percentage : null;
      exceeds200k = Boolean(data.exceeds_200k_tokens);

      // Detect new session: if session_id changed, clear stale per-session ctx state.
      // This handles the case where the agent self-restarts (voluntary handoff) and the
      // 5-min deadline timer would otherwise fire on the fresh low-context session.
      const incomingSessionId = typeof data.session_id === 'string' ? data.session_id : null;
      if (incomingSessionId && incomingSessionId !== this.ctxLastSessionId) {
        if (this.ctxLastSessionId !== null) {
          this.ctxHandoffFiredAt = 0;
          this.ctxHandoffDeadlineAt = 0;
          this.ctxWarningFiredAt = 0;
          this.ctxAutoresetFiredAt = 0;
          this.log(`New session detected (${incomingSessionId.slice(0, 8)}…) — per-session ctx state reset`);
        }
        this.ctxLastSessionId = incomingSessionId;
        this.ctxSessionStartedAt = now;
      }
    } catch { return; }

    // Check PTY output for hard API overflow errors (always act regardless of threshold config)
    const recentOutput = this.agent.getOutputBuffer()?.getRecent(8000) ?? '';
    if (/extra usage.*?1[Mm] context|conversation too long.*?compaction/i.test(recentOutput)) {
      this.log('Context overflow error detected in PTY output — force restarting');
      this.forceContextRestart('API overflow error in PTY output');
      return;
    }

    const { warn, handoff, autoreset } = this.getCtxThresholds();

    // No threshold configured — observe-only mode (log but don't act). Any of
    // the three thresholds being explicitly set arms the monitor; an agent
    // that sets only ctx_autoreset_threshold still gets Tier 0.
    const cfg = this.agent.getConfig();
    // A threshold of 0 means "disabled" — only arm the monitor when at least one
    // threshold is explicitly set to a positive value. This prevents agents that
    // set all thresholds to 0 (to disable the feature) from accidentally triggering
    // the monitor at every poll cycle (0% context always satisfies 0% threshold).
    const anyThresholdSet =
      (typeof cfg.ctx_handoff_threshold === 'number' && cfg.ctx_handoff_threshold > 0) ||
      (typeof cfg.ctx_warning_threshold === 'number' && cfg.ctx_warning_threshold > 0) ||
      (typeof cfg.ctx_autoreset_threshold === 'number' && cfg.ctx_autoreset_threshold > 0);
    if (!anyThresholdSet) return;

    const effectivePct = pct ?? (exceeds200k ? 101 : null);
    if (effectivePct === null) return;

    // Tier 3: deadline exceeded — restart only if context pressure still exists
    // and the session is not currently bouncing on usage limits. The deadline
    // alone is not evidence the agent is stuck: auto-compaction may have already
    // resolved the pressure, and a rate-limited agent cannot cooperate at all.
    if (this.ctxHandoffDeadlineAt > 0 && now > this.ctxHandoffDeadlineAt) {
      const decision = resolveHandoffDeadlineAction({
        now,
        effectivePct,
        handoffThreshold: handoff,
        rateLimited: this.isRecentOutputRateLimited(),
      });
      if (decision.action === 'skip') {
        this.ctxHandoffDeadlineAt = 0;
        this.ctxHandoffFiredAt = 0; // re-arm Tier 2 in case context climbs again
        this.log(`Handoff deadline expired but ctx is ${Math.round(effectivePct)}% (< ${handoff}%) — pressure resolved, skipping restart`);
        return;
      }
      if (decision.action === 'backoff') {
        this.ctxHandoffDeadlineAt = decision.nextDeadlineAt;
        this.log(`Handoff deadline expired at ${Math.round(effectivePct)}% but session is rate-limited — deferring restart ${Math.round(RATE_LIMIT_HANDOFF_BACKOFF_MS / 60_000)}min`);
        return;
      }
      this.log(`Handoff deadline exceeded (${Math.round(effectivePct)}%) — force restarting`);
      this.ctxHandoffDeadlineAt = 0;
      this.forceContextRestart(`ctx ${Math.round(effectivePct)}% — handoff not completed within 5min`);
      return;
    }

    // Tier 0: silent auto-reset — takes a snapshot and force-restarts BEFORE
    // the graceful-handoff tier fires. Disabled unless ctx_autoreset_threshold > 0.
    // Fires once per session lifecycle; session-id change clears the fired flag.
    //
    // Boot-window floor: refuse to fire within 60s of session start. Without
    // this, an agent that boots at or above the threshold (bloated CLAUDE.md,
    // large handoff doc, heavy bootstrap) enters a restart loop — every fresh
    // session would immediately cross the threshold and trip Tier 0 again.
    //
    // Idempotency: if .restart-planned already exists AND is recent, another
    // path is already restarting the agent, so we skip to avoid stacking restart
    // requests. Stale markers (> 2min old or negative age from clock skew) are
    // treated as leaked from an earlier crash and ignored — otherwise a single
    // orphaned marker would permanently disable Tier 0 for that agent.
    if (autoreset > 0 && effectivePct >= autoreset && this.ctxAutoresetFiredAt === 0) {
      const sessionAge = this.ctxSessionStartedAt > 0 ? now - this.ctxSessionStartedAt : Infinity;
      if (sessionAge >= 0 && sessionAge < 60_000) {
        this.log(`Tier 0 would fire at ${Math.round(effectivePct)}% but session is only ${Math.round(sessionAge / 1000)}s old — skipping (boot-window guard)`);
        return; // do not latch — let the next poll reconsider after boot window
      }
      // Rate-limit guard: a restart now would burn rate-limited tokens on
      // bootstrap and immediately re-cross the threshold. Context cannot grow
      // while turns bounce, so deferring is safe; next poll reconsiders.
      if (this.isRecentOutputRateLimited()) {
        this.log(`Tier 0 would fire at ${Math.round(effectivePct)}% but session is rate-limited — deferring (no latch)`);
        return;
      }
      const restartPlannedMarker = join(this.paths.stateDir, '.restart-planned');
      if (existsSync(restartPlannedMarker)) {
        let markerAge: number = Infinity;
        try { markerAge = now - statSync(restartPlannedMarker).mtimeMs; } catch { /* ignore */ }
        // Treat negative ages (clock skew) as stale — a marker "from the future"
        // is almost certainly a leftover whose mtime we cannot trust.
        const markerIsFresh = markerAge >= 0 && markerAge < 2 * 60_000;
        if (markerIsFresh) {
          this.log(`Tier 0 would fire at ${Math.round(effectivePct)}% but .restart-planned present (age ${Math.round(markerAge / 1000)}s) — skipping`);
          this.ctxAutoresetFiredAt = now; // latch so we do not re-check every poll
          return;
        }
        this.log(`Tier 0: .restart-planned is stale (age ${markerAge}ms) — proceeding anyway`);
      }
      this.ctxAutoresetFiredAt = now;
      const pctRound = Math.round(effectivePct);
      this.log(`Tier 0 auto-reset fired at ${pctRound}% (threshold ${autoreset}%)`);
      this.runAutoresetSnapshot(`ctx auto-reset at ${pctRound}%`);
      // Reset context_status.json pre-emptively so the restarted session's
      // FastChecker does not immediately re-fire Tier 0 off the stale value.
      try {
        writeFileSync(statusPath, JSON.stringify({ used_percentage: 0, exceeds_200k_tokens: false, written_at: new Date().toISOString() }));
      } catch { /* non-fatal */ }
      // Arm silent-restart marker so the post-restart session suppresses the
      // boot "online" Telegram messages. Without this, every Tier 0 trip leaks
      // a user-visible "back online" notification, violating the silent
      // contract of auto-reset.
      try {
        writeFileSync(join(this.paths.stateDir, '.silent-restart'), `tier-0-autoreset-${pctRound}%`, 'utf-8');
      } catch { /* non-fatal */ }
      // forceContextRestart handles circuit breaker + hardRestart + sessionRefresh.
      this.forceContextRestart(`ctx auto-reset at ${pctRound}% (tier 0)`);
      return;
    }

    // Tier 1: warning — PTY injection only, no Telegram ping (context management is internal)
    if (effectivePct >= warn && now - this.ctxWarningFiredAt > 15 * 60_000) {
      this.ctxWarningFiredAt = now;
      const pctRound = Math.round(effectivePct);
      const statusSuffix = effectivePct >= handoff ? 'Handoff in progress.' : `Handoff triggers at ${handoff}%.`;
      this.agent.injectMessage(`[CONTEXT] Window at ${pctRound}%. ${statusSuffix}`);
      this.log(`Context warning fired at ${pctRound}%`);
    }

    // Tier 2: handoff (fires once per session lifecycle)
    // Boot-window guard: skip for 90s after session start. Without this, an agent
    // that boots with high baseline context (large CLAUDE.md, bootstrap files) will
    // immediately fire Tier 2, cooperatively call hard-restart, and loop — because
    // context_status.json showed the old high value even though the new session is fresh.
    // hardRestart() now zeroes context_status.json, but a 90s guard provides defence-in-depth
    // and handles the race where the status file is read before hardRestart() writes it.
    if (effectivePct >= handoff && this.ctxHandoffFiredAt === 0) {
      const sessionAge = this.ctxSessionStartedAt > 0 ? now - this.ctxSessionStartedAt : Infinity;
      if (sessionAge >= 0 && sessionAge < 90_000) {
        // Do not latch ctxHandoffFiredAt — allow Tier 2 to fire once the session is settled.
        return;
      }

      // Rate-limit guard: injecting the handoff prompt into a session whose
      // turns are bouncing arms a 5-min deadline the agent cannot possibly meet,
      // guaranteeing a Tier 3 force-restart. Defer without latching — context
      // cannot grow while turns bounce, so Tier 2 fires once the limit lifts.
      if (this.isRecentOutputRateLimited()) {
        this.log(`Tier 2 would fire at ${Math.round(effectivePct)}% but session is rate-limited — deferring handoff prompt (no latch)`);
        return;
      }

      // Cascade guard: if a handoff doc was written within the last 5 minutes, this session
      // is still stabilising after a handoff cascade. Skip Tier 2 until the window passes so
      // we don't inject the handoff prompt again into a session that is fresh from a handoff.
      // Does not latch ctxHandoffFiredAt, so Tier 2 can still fire once the guard expires.
      //
      // Result is cached for 60s to avoid hammering the handoffs directory with
      // readdirSync+statSync on every 1s poll cycle. A 60s lag in detecting when the
      // cascade window expires is acceptable — Tier 2 fires at most 60s late.
      const GUARD_CACHE_MS = 60_000;
      try {
        const handoffsDir = join(this.agent.getAgentDir(), 'memory', 'handoffs');
        let recentDoc: boolean;
        if (now - this.ctxCascadeGuardCachedAt < GUARD_CACHE_MS) {
          recentDoc = this.ctxCascadeGuardCachedResult;
        } else {
          const fiveMinAgo = now - 5 * 60_000;
          recentDoc = existsSync(handoffsDir) && readdirSync(handoffsDir)
            .filter(f => f.startsWith('handoff-') && f.endsWith('.md'))
            .some(f => statSync(join(handoffsDir, f)).mtimeMs >= fiveMinAgo);
          this.ctxCascadeGuardCachedAt = now;
          this.ctxCascadeGuardCachedResult = recentDoc;
        }
        if (recentDoc) {
          this.log(`Cascade guard: recent handoff doc found — skipping Tier 2 at ${Math.round(effectivePct)}% (session age ${Math.round(sessionAge / 1000)}s)`);
          return;
        }
      } catch { /* non-fatal — proceed to Tier 2 if guard check fails */ }
      this.ctxHandoffFiredAt = now;
      this.ctxHandoffDeadlineAt = now + 5 * 60_000; // 5min grace for agent to cooperate
      // Reset context_status.json so the new session doesn't re-trigger immediately
      const statusPath = join(this.paths.stateDir, 'context_status.json');
      try {
        writeFileSync(statusPath, JSON.stringify({ used_percentage: 0, exceeds_200k_tokens: false, written_at: new Date().toISOString() }));
      } catch { /* non-fatal */ }
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + 'Z';
      const handoffPrompt = `[CONTEXT HANDOFF REQUIRED] Context is at ${Math.round(effectivePct)}%. Write a handoff document to memory/handoffs/handoff-${ts}.md with EXACTLY these sections (machine-parseable — do not rename or reorder them):

## Active Tasks
- [task_id] title — status, next action

## Key Decisions Made This Session
- Decision: chose X over Y because Z

## Files Modified
- path/to/file — what changed and why

## Cron State Notes
- Any cron-related state worth preserving

## Memory Extractions
- Any facts learned this session that should persist across sessions (these will be auto-appended to MEMORY.md)

## Unfinished Work
- Exactly what to pick up immediately in the next session

Then run: cortextos bus hard-restart --reason "context handoff at ${Math.round(effectivePct)}%" --handoff-doc <absolute path to the handoff doc you just wrote>. Do this NOW before the context window is exhausted.`;
      this.agent.injectMessage(handoffPrompt);
      this.log(`Handoff prompt injected at ${Math.round(effectivePct)}%`);
      // Pre-arm .force-fresh so the next restart is always a clean fresh session.
      // If the agent cooperates and calls hard-restart, it also writes .force-fresh — no-op.
      // If context exhausts naturally before the agent acts, .force-fresh is already set,
      // preventing a --continue restart that would loop at the same high context level.
      try {
        writeFileSync(join(this.paths.stateDir, '.force-fresh'), '');
      } catch { /* non-fatal */ }
    }
  }

  /**
   * Force a fresh hard restart for context exhaustion reasons.
   * Writes .force-fresh + .restart-planned, then triggers sessionRefresh().
   * The circuit breaker prevents runaway restart loops.
   */
  private forceContextRestart(reason: string): void {
    // Serialise concurrent calls: under burst load the stall watchdog, ctx monitor,
    // and stdout freeze watchdog can all fire simultaneously, each calling
    // sessionRefresh(). Multiple concurrent stop()/start() races corrupt PTY state.
    if (this.sessionRefreshInProgress) {
      this.log(`forceContextRestart skipped (restart already in progress): ${reason}`);
      return;
    }
    this.sessionRefreshInProgress = true;
    const now = Date.now();

    // Update and check circuit breaker window (persisted to disk — survives --continue restarts)
    this.ctxCircuitRestarts = this.ctxCircuitRestarts.filter(t => now - t < 15 * 60_000);
    if (this.ctxCircuitRestarts.length >= 3) {
      this.ctxCircuitBrokenAt = now;
      this.saveCtxCircuit();
      const msg = `Context circuit breaker TRIPPED for ${this.agent.name}: 3 restarts in 15min. Watchdog paused 30min. Check logs/${this.agent.name}/restarts.log for details.`;
      this.log(msg);
      if (this.telegramApi && this.chatId && this.daemonTelegramAlerts) {
        this.telegramApi.sendMessage(this.chatId, msg).catch(() => {});
      }
      return;
    }
    this.ctxCircuitRestarts.push(now);
    this.saveCtxCircuit();

    // If the agent wrote a handoff doc in the last 15 minutes but didn't get to call
    // hard-restart --handoff-doc (e.g. Tier 3 force-restart cut it short), pick it up
    // so the new session still receives handoff context.
    try {
      const handoffsDir = join(this.agent.getAgentDir(), 'memory', 'handoffs');
      if (existsSync(handoffsDir)) {
        const cutoff = now - 15 * 60_000;
        const recent = readdirSync(handoffsDir)
          .filter(f => f.startsWith('handoff-') && f.endsWith('.md'))
          .map(f => ({ f, mtime: statSync(join(handoffsDir, f)).mtimeMs }))
          .filter(({ mtime }) => mtime >= cutoff)
          .sort((a, b) => b.mtime - a.mtime);
        if (recent.length > 0) {
          const docPath = join(handoffsDir, recent[0].f);
          const markerPath = join(this.paths.stateDir, '.handoff-doc-path');
          writeFileSync(markerPath, docPath, 'utf-8');
          this.log(`Tier 3 restart: found recent handoff doc, writing marker → ${docPath}`);
        }
      }
    } catch { /* non-fatal — proceed without handoff context */ }

    // Reset per-session context state for the new session
    this.ctxHandoffFiredAt = 0;
    this.ctxHandoffDeadlineAt = 0;
    this.ctxWarningFiredAt = 0;
    this.ctxAutoresetFiredAt = 0;

    // Write .force-fresh + .restart-planned (hardRestart from src/bus/system.ts)
    hardRestart(this.paths, this.agent.name, `CONTEXT-FORCE-RESTART: ${reason}`);

    // Reset context_status.json so the new session's FastChecker doesn't re-trigger
    // Tier 2 immediately by reading the stale high-% value from the previous session.
    const statusPath = join(this.paths.stateDir, 'context_status.json');
    try {
      writeFileSync(statusPath, JSON.stringify({ used_percentage: 0, exceeds_200k_tokens: false, written_at: new Date().toISOString() }));
    } catch { /* non-fatal */ }

    // sessionRefresh() does stop() + start(); shouldContinue() will return false
    // because .force-fresh was just written, giving us a clean fresh session.
    this.agent.sessionRefresh()
      .catch(err => this.log(`Context restart failed: ${err}`))
      .finally(() => { this.sessionRefreshInProgress = false; });
  }

  /**
   * Compute a hash for message dedup. Uses SHA-256 to avoid collision attacks.
   */
  private hashMessage(text: string): string {
    return createHash('sha256').update(text).digest('hex');
  }

  /**
   * Check if message has been seen (dedup). Returns true if duplicate.
   */
  isDuplicate(text: string): boolean {
    const hash = this.hashMessage(text);
    if (this.seenHashes.has(hash)) return true;
    this.seenHashes.add(hash);
    this.saveDedupHashes();
    return false;
  }

  /**
   * Load dedup hashes from persistent file.
   */
  private loadDedupHashes(): void {
    try {
      if (existsSync(this.dedupFilePath)) {
        const content = readFileSync(this.dedupFilePath, 'utf-8');
        const hashes = content.trim().split('\n').filter(Boolean);
        // Keep only last 1000 hashes to prevent file bloat
        const recent = hashes.slice(-1000);
        this.seenHashes = new Set(recent);
      }
    } catch {
      // Start fresh on error
      this.seenHashes = new Set();
    }
  }

  /**
   * Save dedup hashes to persistent file.
   */
  private saveDedupHashes(): void {
    try {
      const hashes = Array.from(this.seenHashes).slice(-1000);
      writeFileSync(this.dedupFilePath, hashes.join('\n') + '\n', 'utf-8');
    } catch {
      // Non-critical - dedup will still work in memory
    }
  }

  /**
   * Load circuit breaker state from disk.
   * Persisting this across --continue restarts is critical: without it,
   * the in-memory ctxCircuitRestarts array resets on every restart, making
   * the circuit breaker unable to count restarts and stop a restart loop.
   */
  private loadCtxCircuit(): void {
    try {
      if (!existsSync(this.ctxCircuitFile)) return;
      const data = JSON.parse(readFileSync(this.ctxCircuitFile, 'utf-8'));
      this.ctxCircuitRestarts = Array.isArray(data.restarts) ? data.restarts : [];
      this.ctxCircuitBrokenAt = typeof data.brokenAt === 'number' ? data.brokenAt : null;
    } catch {
      // Start fresh on error
    }
  }

  /**
   * Persist circuit breaker state to disk after every update.
   */
  private saveCtxCircuit(): void {
    try {
      writeFileSync(this.ctxCircuitFile, JSON.stringify({
        restarts: this.ctxCircuitRestarts,
        brokenAt: this.ctxCircuitBrokenAt,
      }), 'utf-8');
    } catch {
      // Non-critical
    }
  }

  /**
   * Check if the agent is actively working on a response (typing indicator).
   *
   * Hook-based approach:
   *   - fast-checker records when it injected a message (lastMessageInjectedAt)
   *   - Stop hook writes a Unix timestamp to state/<agent>/last_idle.flag
   *   - Typing = message was injected AND last_idle.flag is older than injection
   *     AND injection was within the last 10 minutes
   *
   * This is accurate: typing starts when user sends a message, clears the
   * moment Claude finishes its turn (Stop fires). No false positives from TUI.
   */
  isAgentActive(): boolean {
    // Hook-based approach only. Claude Code writes ANSI escape codes (spinner,
    // cursor movement) to stdout constantly even when idle, so stdout.log always
    // grows — using file size as an activity signal produces a permanent "typing"
    // indicator. Instead, rely solely on:
    //   - lastMessageInjectedAt: when fast-checker last pushed a message in
    //   - last_idle.flag: written by the Stop hook when Claude finishes a turn
    // This gives accurate per-turn typing with no false positives.

    if (this.lastMessageInjectedAt === 0) return false;

    const now = Date.now();
    const tenMinMs = 10 * 60 * 1000;
    if (now - this.lastMessageInjectedAt > tenMinMs) return false;

    // Clear typing immediately when the agent sends a reply.
    // outbound-messages.jsonl grows each time the agent calls send-telegram.
    const outboundPath = join(this.paths.logDir, 'outbound-messages.jsonl');
    try {
      if (existsSync(outboundPath)) {
        const { size } = require('fs').statSync(outboundPath);
        if (this.outboundLogSize === 0) {
          // First check: seed baseline, don't trigger yet
          this.outboundLogSize = size;
        } else if (size > this.outboundLogSize) {
          // New reply sent — clear typing state
          this.outboundLogSize = size;
          this.lastMessageInjectedAt = 0;
          return false;
        }
      }
    } catch { /* non-critical */ }

    // Read last_idle.flag written by the Stop hook
    const flagPath = join(this.paths.stateDir, 'last_idle.flag');
    try {
      if (!existsSync(flagPath)) {
        // No idle flag yet — hook hasn't fired, so still working
        return true;
      }
      const idleTs = parseInt(readFileSync(flagPath, 'utf-8').trim(), 10) * 1000;
      // Typing if injection happened AFTER the last idle signal
      return this.lastMessageInjectedAt > idleTs;
    } catch {
      return true; // Can't read flag — assume still active
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
