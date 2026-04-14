import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join, sep } from 'path';
import { homedir } from 'os';
import type { AgentConfig, AgentStatus, CtxEnv } from '../types/index.js';
import { AgentPTY } from '../pty/agent-pty.js';
import { MessageDedup, injectMessage } from '../pty/inject.js';
import { ensureDir } from '../utils/atomic.js';
import { writeCortextosEnv } from '../utils/env.js';
import { getOverdueReminders } from '../bus/reminders.js';
import { resolvePaths } from '../utils/paths.js';
import type { CronScheduler, ManagedAgent } from './cron-scheduler.js';

type LogFn = (msg: string) => void;

/**
 * Manages a single agent's lifecycle.
 * Replaces agent-wrapper.sh for one agent.
 *
 * Implements ManagedAgent so the daemon-side CronScheduler can attach to it
 * on start() and inject scheduled cron prompts without requiring Claude Code
 * to rebuild CronCreate state on every hard-restart.
 */
export class AgentProcess implements ManagedAgent {
  readonly name: string;
  private env: CtxEnv;
  private config: AgentConfig;
  private pty: AgentPTY | null = null;
  private sessionTimer: ReturnType<typeof setTimeout> | null = null;
  private crashCount: number = 0;
  private maxCrashesPerDay: number = 10;
  private sessionStart: Date | null = null;
  private status: AgentStatus['status'] = 'stopped';
  private stopping: boolean = false;
  // BUG-040 fix: persists across stop() return until handleExit clears it.
  // Required because BUG-032's CRLF + 5s wait can cause graceful shutdown to
  // exceed the 5s Promise.race timeout in stop(), which would otherwise reset
  // `stopping=false` BEFORE the PTY actually exits, then handleExit would fire
  // with stopping=false and trigger spurious crash recovery (a partial regression
  // of BUG-011). stopRequested survives the timeout and is only cleared either
  // by handleExit when an intentional exit fires, or by start() at the beginning
  // of a new lifecycle.
  private stopRequested: boolean = false;
  // BUG-040 fix: monotonic generation counter incremented on each successful
  // start(). Each PTY's onExit closure captures the generation at spawn time
  // and bails out if the generation doesn't match — i.e. a NEW PTY has been
  // spawned since this old one was created. Without this guard, a late exit
  // from an old PTY can race past stopRequested and trigger crash recovery on
  // the new agent.
  private lifecycleGeneration: number = 0;
  // BUG-011 fix: stop() awaits this promise (resolved by the onExit handler in start())
  // to guarantee the PTY exit has fired before stopping=false is reset. Without
  // this, the exit handler can fire after stopping=false and trigger spurious
  // crash recovery for an agent we just stopped intentionally.
  private exitPromise: Promise<void> | null = null;
  private resolveExit: (() => void) | null = null;
  private dedup: MessageDedup;
  private log: LogFn;
  private onStatusChange: ((status: AgentStatus) => void) | null = null;
  // Rate-limit recovery: pending restart timer. Stored so it can be cancelled
  // if a second rate-limit exit fires before the first timer elapses (preventing
  // two overlapping timers from racing and triggering a premature restart).
  private rateLimitTimer: ReturnType<typeof setTimeout> | null = null;
  // Daemon-side cron scheduler. Attached on successful start() and detached on
  // stop(). The scheduler owns all recurring + once-type cron timing so the
  // agent never has to rebuild CronCreate state after a hard-restart.
  private cronScheduler: CronScheduler | null = null;
  // Timestamp (ms) of the last "activity" event — a scheduler inject. Used by
  // isIdle() to decide whether the agent has finished processing whatever the
  // scheduler last handed it: if last_idle.flag has a newer timestamp than
  // lastActivityTs, the agent has gone idle since. Reset to 0 on stop.
  private lastActivityTs: number = 0;
  // Timestamp (ms) when the current lifecycle booted. isIdle() returns false
  // during a 60s grace window after bootTs so the scheduler never fires on
  // top of the bootstrap prompt, even if the idle-flag infrastructure isn't
  // wired (Stop hook not registered → last_idle.flag never written).
  private bootTs: number = 0;

  constructor(
    name: string,
    env: CtxEnv,
    config: AgentConfig,
    log?: LogFn,
    cronScheduler?: CronScheduler,
  ) {
    this.name = name;
    this.env = env;
    this.config = config;
    if (config.max_crashes_per_day !== undefined) {
      this.maxCrashesPerDay = config.max_crashes_per_day;
    }
    this.dedup = new MessageDedup();
    this.log = log || ((msg) => console.log(`[${name}] ${msg}`));
    this.cronScheduler = cronScheduler ?? null;
  }

  // ---------- ManagedAgent implementation ----------

  /** Absolute path to this agent's state directory (state/<name>/). */
  get stateDir(): string {
    return join(this.env.ctxRoot, 'state', this.name);
  }

  /** Absolute path to this agent's config.json. */
  get configPath(): string {
    return join(this.env.agentDir, 'config.json');
  }

  /** IANA timezone used for cron expression evaluation (undefined → UTC). */
  get timezone(): string | undefined {
    return this.config.timezone;
  }

  /** Current lifecycle generation. Bumped on each successful start(). */
  get generation(): number {
    return this.lifecycleGeneration;
  }

  /** True when the PTY is spawned and status is 'running'. */
  isRunning(): boolean {
    return this.status === 'running' && this.pty !== null;
  }

  /**
   * True when it is safe for the cron scheduler to inject a new prompt.
   *
   * Three layers, in order:
   *   1. Startup grace: return false for STARTUP_GRACE_MS after bootTs so the
   *      scheduler never fires on top of the bootstrap prompt.
   *   2. Flag present: Claude Code's Stop hook (hook-idle-flag.ts) writes
   *      `last_idle.flag` as unix seconds after every agent turn. If the flag's
   *      timestamp is newer than lastActivityTs (i.e. the agent finished
   *      processing the last thing we injected), the agent is idle.
   *   3. Flag absent: in deployments where the Stop hook isn't registered, the
   *      flag never gets written. Rather than indefinitely stalling every cron
   *      in the max-defer window, default to "idle" once past the grace period
   *      — Claude Code's own message queue handles back-pressure when busy.
   */
  isIdle(): boolean {
    const STARTUP_GRACE_MS = 60_000;
    const now = Date.now();
    if (this.bootTs > 0 && now - this.bootTs < STARTUP_GRACE_MS) {
      return false;
    }
    const flagPath = join(this.stateDir, 'last_idle.flag');
    if (!existsSync(flagPath)) {
      // Stop hook not wired → treat as idle once past grace window.
      return true;
    }
    try {
      const tsSec = parseInt(readFileSync(flagPath, 'utf-8').trim(), 10);
      if (isNaN(tsSec)) return false;
      // hook-idle-flag.ts writes unix seconds; lastActivityTs is ms.
      return tsSec * 1000 > this.lastActivityTs;
    } catch {
      return false;
    }
  }

  /**
   * Inject a prompt via the daemon-owned scheduler path. Bypasses MessageDedup
   * because cron prompts are identical every fire by design — going through
   * injectMessage(content) would dedup the second and later fires of every
   * recurring cron and silently skip them. Bumps lastActivityTs so isIdle()
   * reports false until the agent finishes processing this prompt and the
   * Stop hook writes a newer idle flag.
   */
  inject(message: string): boolean {
    if (!this.pty || this.status !== 'running') {
      return false;
    }
    injectMessage((data) => this.pty!.write(data), message);
    this.lastActivityTs = Date.now();
    return true;
  }

  /**
   * Start the agent. Spawns Claude Code in a PTY.
   */
  async start(): Promise<void> {
    if (this.status === 'running') {
      this.log('Already running');
      return;
    }

    // Apply startup delay
    const delay = this.config.startup_delay || 0;
    if (delay > 0) {
      this.log(`Startup delay: ${delay}s`);
      await sleep(delay * 1000);
    }

    // Write .cortextos-env for backward compat (D6)
    if (this.env.agentDir) {
      writeCortextosEnv(this.env.agentDir, this.env);
    }

    // Determine start mode
    const mode = this.shouldContinue() ? 'continue' : 'fresh';
    // Read the rate-limit marker before building the prompt
    // but do NOT delete it yet. Deleted only after pty.spawn() succeeds
    // so that a spawn failure doesn't permanently swallow the recovery context.
    const stateDir = join(this.env.ctxRoot, 'state', this.name);
    const hadRateLimit = this.hasRateLimitMarker(stateDir);
    const prompt = mode === 'fresh'
      ? this.buildStartupPrompt()
      : this.buildContinuePrompt();

    this.log(`Starting in ${mode} mode`);
    this.status = 'starting';

    // BUG-040 fix: clear any stale stop request from a previous lifecycle
    // (e.g. if the previous stop() timed out before the PTY actually exited).
    // We're starting fresh — the new PTY has no pending stop.
    this.stopRequested = false;
    // BUG-040 fix: bump generation. The onExit closure below captures THIS
    // value and uses it to detect "I'm an old PTY whose exit fired after a
    // new lifecycle began" — in which case it bails out without touching
    // handleExit, preventing spurious crash recovery on the new agent.
    const myGeneration = ++this.lifecycleGeneration;

    // Create PTY
    const logPath = join(this.env.ctxRoot, 'logs', this.name, 'stdout.log');
    ensureDir(join(this.env.ctxRoot, 'logs', this.name));
    this.log(`Log path: ${logPath}`);
    this.pty = new AgentPTY(this.env, this.config, logPath);

    // BUG-011 fix: create a fresh exit signal for this run. resolveExit is
    // called from the onExit handler below; stop() awaits exitPromise to
    // guarantee the exit handler has fired before clearing stopping.
    this.exitPromise = new Promise<void>((resolve) => {
      this.resolveExit = resolve;
    });

    // Handle exit
    this.pty.onExit((exitCode, signal) => {
      // BUG-040 fix: if the lifecycle has moved on (a new start() incremented
      // the generation since this PTY was spawned), this is an old PTY's late
      // exit. Ignore it entirely — we don't want it to trigger handleExit on
      // the current PTY's state.
      if (myGeneration !== this.lifecycleGeneration) {
        this.log(`Ignoring late exit from previous lifecycle gen ${myGeneration} (current: ${this.lifecycleGeneration})`);
        return;
      }
      this.log(`Exited with code ${exitCode} signal ${signal}`);
      this.handleExit(exitCode);
      // Signal anyone awaiting this PTY's exit (e.g. stop() — BUG-011 fix)
      this.resolveExit?.();
      this.resolveExit = null;
    });

    try {
      await this.pty.spawn(mode, prompt);
      this.status = 'running';
      this.sessionStart = new Date();
      this.log(`Running (pid: ${this.pty.getPid()})`);

      // Delete rate-limit marker only after spawn succeeds.
      if (hadRateLimit) this.deleteRateLimitMarker(stateDir);

      // Reset idle baseline for this lifecycle. isIdle() uses bootTs for the
      // startup grace window and lastActivityTs for per-inject back-pressure.
      const bootNow = Date.now();
      this.bootTs = bootNow;
      this.lastActivityTs = bootNow;

      // Start session timer
      this.startSessionTimer();

      // Attach the cron scheduler if the daemon provided one. Attach AFTER
      // spawn+status=running so scheduler.isRunning() is immediately true.
      this.cronScheduler?.attachAgent(this);


      this.notifyStatusChange();
    } catch (err) {
      this.log(`Failed to start: ${err}`);
      this.status = 'crashed';
      this.notifyStatusChange();
    }
  }

  /**
   * Stop the agent gracefully.
   */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    // BUG-040 fix: stopRequested persists ACROSS stop()'s return until
    // handleExit clears it. This is the safety net for the case where the
    // PTY exits later than the Promise.race timeout below.
    this.stopRequested = true;
    this.log('Stopping...');
    this.clearSessionTimer();
    // Detach from the cron scheduler — subsequent ticks will skip this agent
    // until a fresh start() re-attaches with a new lifecycle generation.
    this.cronScheduler?.detachAgent(this.name);

    // Capture and null out pty BEFORE any awaits so handleExit() during graceful
    // shutdown doesn't race with us and trigger crash recovery or a double-kill.
    const pty = this.pty;
    this.pty = null;
    // Capture the exit promise before any awaits — we'll wait on this AFTER
    // pty.kill() to guarantee the exit handler has run before stopping=false.
    const exitPromise = this.exitPromise;

    if (pty) {
      try {
        // BUG-032 fix: use CRLF (not lone CR) so Claude Code's REPL actually
        // recognizes the /exit line as a complete command, AND wait long
        // enough (5s, was 3s) for the child to flush + exit cleanly. Without
        // these the child often dies from SIGHUP (exit code 129) when the
        // PTY is torn down before /exit has been processed. PR #11's
        // BUG-011 fix already ensured the daemon doesn't misinterpret 129
        // as a real crash, but the underlying graceful-shutdown sequence
        // still wasn't graceful — this PR makes it so.
        pty.write('\x03'); // Ctrl-C
        await sleep(1000);
        pty.write('/exit\r\n');
        await sleep(5000);
      } catch {
        // Ignore write errors during shutdown
      }
      // BUG-032 follow-up: only kill the PTY if the process is still alive.
      // After /exit + 5s wait, the child has usually exited cleanly. Calling
      // pty.kill() on an already-exited PTY tears down the file descriptor,
      // which can send SIGHUP (exit code 129) to a process that was in the
      // middle of flushing. Polling first eliminates the remaining SIGHUP risk.
      if (pty.isAlive()) {
        try {
          pty.kill();
        } catch {
          // PTY may have exited between the check and the kill — ignore
        }
      }

      // BUG-011 fix: AWAIT the exit handler before resolving stop().
      // BUG-040 fix: bumped timeout from 5s to 15s to give the PTY plenty of
      // time to exit cleanly even when BUG-032's slow graceful shutdown stacks
      // on top of pty.kill() lag. The functional correctness no longer depends
      // on this timeout (stopRequested handles late exits), but a generous
      // timeout reduces "Ignoring late exit from previous lifecycle" log noise.
      if (exitPromise) {
        await Promise.race([exitPromise, sleep(15000)]);
      }
    }

    this.stopping = false;
    // NOTE: this.stopRequested is intentionally NOT cleared here. It is
    // cleared by handleExit when the intentional exit fires (or by start()
    // when a new lifecycle begins). See BUG-040 fix in handleExit().
    this.status = 'stopped';
    this.notifyStatusChange();
    this.log('Stopped');
  }

  /**
   * Restart with --continue (session refresh).
   *
   * Delegates to stop() + start() so it inherits the BUG-011 race fix
   * automatically. This also eliminates a separate bug in the previous
   * inline implementation where the OLD pty's exit handler could fire
   * AFTER the NEW pty was set up, nulling out the wrong reference.
   * `start()` will pick up `continue` mode automatically because the
   * conversation directory still has .jsonl files (shouldContinue() is true).
   */
  async sessionRefresh(): Promise<void> {
    this.log('Session refresh (--continue restart)');
    await this.stop();
    await this.start();
    this.log('Session refreshed');
  }

  /**
   * Inject a message into the agent's PTY.
   */
  injectMessage(content: string): boolean {
    if (!this.pty || this.status !== 'running') {
      return false;
    }

    if (this.dedup.isDuplicate(content)) {
      this.log('Dedup: skipping duplicate message');
      return false;
    }

    injectMessage((data) => this.pty!.write(data), content);
    return true;
  }

  /**
   * Check if the agent has bootstrapped (ready for messages).
   */
  isBootstrapped(): boolean {
    return this.pty?.getOutputBuffer().isBootstrapped() ?? false;
  }

  /**
   * Get current agent status.
   */
  getStatus(): AgentStatus {
    return {
      name: this.name,
      status: this.status,
      pid: this.pty?.getPid() || undefined,
      uptime: this.sessionStart
        ? Math.floor((Date.now() - this.sessionStart.getTime()) / 1000)
        : undefined,
      sessionStart: this.sessionStart?.toISOString(),
      crashCount: this.crashCount,
      model: this.config.model,
    };
  }

  /**
   * Register a status change handler.
   */
  onStatusChanged(handler: (status: AgentStatus) => void): void {
    this.onStatusChange = handler;
  }

  /**
   * Write raw data to the agent's PTY.
   * Used for TUI navigation (key sequences).
   */
  write(data: string): void {
    if (this.pty) {
      this.pty.write(data);
    }
  }

  /**
   * Get the output buffer for reading agent output.
   */
  getOutputBuffer() {
    return this.pty?.getOutputBuffer();
  }

  // --- Private methods ---

  private handleExit(exitCode: number): void {
    // Capture the output buffer BEFORE nulling this.pty — needed for rate-limit
    // detection below (hasRateLimitSignature reads from the buffer).
    const outputBuffer = this.pty?.getOutputBuffer();
    this.pty = null;
    this.clearSessionTimer();

    // When the cortextos daemon is shut down by PM2, SIGTERM propagates to
    // the whole process group and reaches each PTY's Claude Code child
    // BEFORE the daemon's stopAll() loop has a chance to call stopAgent() on
    // it. Those children exit cleanly (code 0) but arrive at handleExit with
    // stopRequested=false, which used to classify the exit as a crash and
    // inflate .crash_count_today by one per agent, per PM2 restart.
    //
    // agent-manager.ts:stopAll() already writes a `.daemon-stop` marker in
    // every agent's state dir at the START of its shutdown loop for an
    // unrelated reason (SessionEnd crash-alert hook). We reuse that marker
    // here as the authoritative "the daemon is going down" signal. If the
    // marker exists AND is recent (written within the last 60s), any PTY
    // exit is a shutdown casualty, not a real crash — swallow it.
    //
    // The 60s window guards against a stale marker from a previous shutdown
    // that wasn't cleaned up: we do NOT want an old marker to silently mask
    // a genuine crash days later. handleExit does NOT delete the marker —
    // cleanup stays with agent-manager / hook-crash-alert per the existing
    // separation of concerns.
    if (this.isDaemonShuttingDown()) {
      return;
    }

    // BUG-040 fix: check stopRequested instead of (only) stopping. The
    // stopping flag is cleared inside stop() after a 15s timeout window —
    // which means a slow PTY shutdown can fire handleExit AFTER stopping is
    // already false, leading to spurious crash recovery. stopRequested is
    // set by stop() at the START of the shutdown sequence and persists across
    // stop()'s return until handleExit clears it (right here). This guarantees
    // that the FIRST exit after a stop() call is treated as intentional, no
    // matter how delayed it is.
    //
    // Also keep the legacy `stopping` check for in-progress detection during
    // the (most common) case where the exit fires while stop() is still
    // awaiting. Either flag short-circuits crash recovery.
    if (this.stopRequested || this.stopping) {
      this.stopRequested = false;
      return;
    }

    const stateDir = join(this.env.ctxRoot, 'state', this.name);

    // Rate-limit detection: if the PTY output contains Anthropic rate-limit or
    // overload signatures, treat this as a planned pause rather than a crash.
    // Rate-limit pauses do NOT count toward max_crashes_per_day and do NOT
    // trigger the git watchdog — they are expected operational events tied to
    // Anthropic's 5-hour rolling rate-limit window.
    if (outputBuffer?.hasRateLimitSignature()) {
      const pauseSeconds = this.config.rate_limit_pause_seconds ?? 18000;
      this.log(`Rate-limit detected — pausing ${pauseSeconds}s before restart (not counted as crash)`);
      this.status = 'rate-limited';
      this.notifyStatusChange();
      // Write a marker so the next boot prompt informs the agent it's recovering
      // from a rate-limit pause rather than a normal crash.
      try {
        writeFileSync(join(stateDir, '.rate-limited'), pauseSeconds.toString(), 'utf-8');
      } catch { /* ignore write errors */ }
      // Cancel any prior rate-limit timer before scheduling a new one (Bug-1 fix).
      // Without this, two sequential rate-limit exits leave two timers running;
      // the first fires into the second pause window and triggers an early restart.
      if (this.rateLimitTimer) {
        clearTimeout(this.rateLimitTimer);
        this.rateLimitTimer = null;
      }
      this.rateLimitTimer = setTimeout(() => {
        this.rateLimitTimer = null;
        if (this.status === 'rate-limited') {
          this.start().catch(err => this.log(`Rate-limit restart failed: ${err}`));
        }
      }, pauseSeconds * 1000);
      return;
    }

    // Check crash limit
    this.crashCount++;
    const today = new Date().toISOString().split('T')[0];
    this.resetCrashCountIfNewDay(today);

    if (this.crashCount >= this.maxCrashesPerDay) {
      this.log(`HALTED: exceeded ${this.maxCrashesPerDay} crashes today`);
      this.appendCrashToRestartsLog(exitCode, 0, 'HALTED');
      this.status = 'halted';
      this.notifyStatusChange();
      return;
    }

    // Exponential backoff restart
    const backoff = Math.min(5000 * Math.pow(2, this.crashCount - 1), 300000);
    this.log(`Crash recovery: restart in ${backoff / 1000}s (crash #${this.crashCount})`);
    // Persist the crash to restarts.log so operators have a durable audit
    // trail. Previously only planned SELF-RESTART / HARD-RESTART from
    // bus/system.ts wrote here, which left daemon-classified crashes
    // invisible outside the rotating PM2 daemon stdout log.
    this.appendCrashToRestartsLog(exitCode, backoff, 'CRASH');
    this.status = 'crashed';
    this.notifyStatusChange();

    setTimeout(() => {
      if (this.status === 'crashed') {
        this.start().catch(err => this.log(`Restart failed: ${err}`));
      }
    }, backoff);
  }

  /**
   * Check whether the rate-limit recovery marker exists (read-only).
   * The caller is responsible for deleting it after a successful spawn via
   * deleteRateLimitMarker(), so a failed spawn doesn't permanently swallow
   * the recovery context.
   */
  private hasRateLimitMarker(stateDir: string): boolean {
    return existsSync(join(stateDir, '.rate-limited'));
  }

  /**
   * Delete the rate-limit recovery marker.
   * Call only after pty.spawn() succeeds.
   */
  private deleteRateLimitMarker(stateDir: string): void {
    try {
      const { unlinkSync } = require('fs');
      unlinkSync(join(stateDir, '.rate-limited'));
    } catch { /* ignore */ }
  }

  private shouldContinue(): boolean {
    // Check for force-fresh marker
    const forceFreshPath = join(this.env.ctxRoot, 'state', this.name, '.force-fresh');
    if (existsSync(forceFreshPath)) {
      try {
        const { unlinkSync } = require('fs');
        unlinkSync(forceFreshPath);
      } catch { /* ignore */ }
      return false;
    }

    // Check for existing conversation
    const launchDir = this.config.working_directory || this.env.agentDir;
    if (!launchDir) return false;

    // Claude projects dir uses the absolute path with all separators replaced by dashes
    // e.g. /Users/foo/agents/boss -> -Users-foo-agents-boss (leading sep becomes -)
    // Use homedir() for cross-platform compatibility (HOME is not set on Windows).
    const convDir = join(
      homedir(),
      '.claude',
      'projects',
      launchDir.split(sep).join('-'),
    );

    try {
      const files = require('fs').readdirSync(convDir);
      return files.some((f: string) => f.endsWith('.jsonl'));
    } catch {
      return false;
    }
  }

  private buildStartupPrompt(): string {
    const stateDir = join(this.env.ctxRoot, 'state', this.name);
    const onboardedPath = join(stateDir, '.onboarded');
    const onboardingPath = join(this.env.agentDir, 'ONBOARDING.md');
    const heartbeatPath = join(stateDir, 'heartbeat.json');
    let onboardingAppend = '';

    // If agent has a heartbeat but no .onboarded marker, they completed onboarding but
    // forgot to write the marker. Auto-write it so they don't re-onboard next restart.
    if (!existsSync(onboardedPath) && existsSync(heartbeatPath)) {
      try {
        const { writeFileSync } = require('fs');
        writeFileSync(onboardedPath, '', 'utf-8');
      } catch { /* ignore */ }
    }

    if (!existsSync(onboardedPath) && existsSync(onboardingPath)) {
      onboardingAppend = ' IMPORTANT: This is your FIRST BOOT. Before doing anything else, read ONBOARDING.md and complete the onboarding protocol.';
    }

    const nowUtc = new Date().toISOString();
    const reminderBlock = this.buildReminderBlock();
    const deliverablesBlock = this.buildDeliverablesBlock();
    const rateLimitBlock = this.hasRateLimitMarker(stateDir)
      ? ' RATE-LIMIT RECOVERY: Your previous session was paused by the daemon due to an Anthropic rate-limit or overload response. You have been restarted after the configured recovery window. Resume normal operations — this was not a crash.'
      : '';
    return `You are starting a new session. Current UTC time: ${nowUtc}. Your working directory is your agent dir (CTX_AGENT_DIR). For cortextOS commands use: node $CTX_FRAMEWORK_ROOT/dist/cli.js bus ... (not node dist/cli.js). Read AGENTS.md and all bootstrap files listed there. Your recurring and one-shot crons are scheduled by the daemon from config.json — do NOT call CronCreate or /loop for cron entries. If any old in-session crons remain from a previous version, run CronList and CronDelete them. Use ScheduleWakeup only for ad-hoc one-shot deferrals within the current session.${reminderBlock}${deliverablesBlock} Check inbox. Do NOT send a Telegram "back online" message — the daemon handles startup notifications automatically.${onboardingAppend}${rateLimitBlock}`;
  }

  private buildContinuePrompt(): string {
    const stateDir = join(this.env.ctxRoot, 'state', this.name);
    const nowUtc = new Date().toISOString();
    const reminderBlock = this.buildReminderBlock();
    const deliverablesBlock = this.buildDeliverablesBlock();
    const rateLimitBlock = this.hasRateLimitMarker(stateDir)
      ? ' RATE-LIMIT RECOVERY: Your previous session was paused by the daemon due to an Anthropic rate-limit or overload response. You have been restarted after the configured recovery window. Resume normal operations — this was not a crash.'
      : '';
    return `SESSION CONTINUATION: Your CLI process was restarted with --continue to reload configs. Current UTC time: ${nowUtc}. Your working directory is your agent dir (CTX_AGENT_DIR). For cortextOS commands use: node $CTX_FRAMEWORK_ROOT/dist/cli.js bus ... (not node dist/cli.js). Your full conversation history is preserved. Re-read AGENTS.md and ALL bootstrap files listed there. Your recurring and one-shot crons are scheduled by the daemon from config.json — do NOT call CronCreate or /loop for cron entries. If any old in-session crons remain from a previous version, run CronList and CronDelete them.${reminderBlock}${deliverablesBlock} Check inbox. Resume normal operations. Do NOT send a Telegram notification — --continue restarts are silent by design.${rateLimitBlock}`;
  }

  /**
   * Build a reminder block for the boot prompt.
   * If any pending reminders are overdue, include them so the agent handles them
   * even after a hard-restart that cleared in-memory cron state (#69).
   */
  private buildReminderBlock(): string {
    try {
      const paths = resolvePaths(this.name, this.env.instanceId, this.env.org);
      const overdue = getOverdueReminders(paths);
      if (overdue.length === 0) return '';
      const items = overdue.map(r =>
        `  - [${r.id}] (due ${r.fire_at}): ${r.prompt}`,
      ).join('\n');
      return ` You also have ${overdue.length} overdue persistent reminder(s) from before this restart — handle each one, then run: cortextos bus ack-reminder <id>\n${items}`;
    } catch {
      return '';
    }
  }

  /**
   * Build a deliverable-standard instruction block for the boot prompt.
   * When require_deliverables is enabled in the org's context.json, agents
   * are told that every task submitted for review must have at least one
   * file attached via save-output. The instruction is injected dynamically
   * so existing agents pick up the rule on their next boot with zero file
   * changes, and toggling it off removes it from the next startup prompt.
   */
  private buildDeliverablesBlock(): string {
    try {
      const contextPath = join(this.env.frameworkRoot, 'orgs', this.env.org, 'context.json');
      if (!existsSync(contextPath)) return '';
      const ctx = JSON.parse(readFileSync(contextPath, 'utf-8'));
      if (!ctx.require_deliverables) return '';
      return ' DELIVERABLE STANDARD: Every task you submit for review MUST have at least one file deliverable attached via the save-output bus command. A task with zero file deliverables will be sent back. Attach files with: cortextos bus save-output <task-id> <file-path> --label "<descriptive label>". Labels must be human-readable at a glance: describe WHAT it is plus enough context to understand at a glance. Good: "Traffic Growth Plan — 10 channels, 30-day launch sequence". Bad: "traffic-growth-plan.md" or "output-1". Notes are for context only, never file paths or URLs.';
    } catch {
      return '';
    }
  }

  private startSessionTimer(): void {
    const DEFAULT_MAX_SESSION_S = 255600;
    const startedAt = Date.now();
    const initialMs = (this.config.max_session_seconds || DEFAULT_MAX_SESSION_S) * 1000;

    // BUG-048 fix: re-read max_session_seconds from config.json on each timer
    // fire so that config changes after start() take effect. Without this, a
    // briefly-low max_session_seconds baked at start time causes a fleet-wide
    // simultaneous restart when all agents hit the same stale deadline.
    const scheduleCheck = (delayMs: number): void => {
      this.sessionTimer = setTimeout(() => {
        // Re-read current config from disk
        let currentMaxMs = initialMs;
        try {
          const configPath = join(this.env.agentDir, 'config.json');
          if (existsSync(configPath)) {
            const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
            currentMaxMs = (cfg.max_session_seconds || DEFAULT_MAX_SESSION_S) * 1000;
          }
        } catch { /* use initial value on read error */ }

        const elapsedMs = Date.now() - startedAt;
        const remainingMs = currentMaxMs - elapsedMs;

        if (remainingMs > 5000) {
          // Config was updated to a longer duration — reschedule for the remaining time.
          this.log(`Session timer: config updated to ${currentMaxMs / 1000}s, rescheduling (${Math.round(remainingMs / 1000)}s remaining)`);
          scheduleCheck(remainingMs);
          return;
        }

        this.log(`Session timer fired after ${Math.round(elapsedMs / 1000)}s (limit: ${currentMaxMs / 1000}s)`);
        this.sessionRefresh().catch(err => this.log(`Session refresh failed: ${err}`));
      }, delayMs);
    };

    scheduleCheck(initialMs);
  }

  private clearSessionTimer(): void {
    if (this.sessionTimer) {
      clearTimeout(this.sessionTimer);
      this.sessionTimer = null;
    }
  }

  /**
   * Check whether the daemon is currently in its shutdown sequence.
   *
   * Returns true iff a `.daemon-stop` marker exists in this agent's state
   * dir AND was written within the last 60 seconds. The marker is written
   * by AgentManager.stopAll() before it begins iterating stopAgent() calls.
   * A stale marker older than 60s is treated as leftover from a prior
   * shutdown and ignored — real crashes must not be masked indefinitely.
   */
  private isDaemonShuttingDown(): boolean {
    const marker = join(this.env.ctxRoot, 'state', this.name, '.daemon-stop');
    try {
      if (!existsSync(marker)) return false;
      const ageMs = Date.now() - statSync(marker).mtimeMs;
      return ageMs < 60_000;
    } catch {
      return false;
    }
  }

  /**
   * Append an unplanned-exit entry to restarts.log. Complements the planned
   * SELF-RESTART / HARD-RESTART entries written by src/bus/system.ts so that
   * a single file gives the complete restart history for an agent.
   *
   * Format matches bus/system.ts: `[ISO] <KIND>: <details>`. appendFileSync
   * uses write(2) with O_APPEND on Linux, which is atomic for writes under
   * PIPE_BUF (~4KB) — each CRASH line fits comfortably. All errors are
   * swallowed: logging must never break crash recovery.
   */
  private appendCrashToRestartsLog(
    exitCode: number,
    backoffMs: number,
    kind: 'CRASH' | 'HALTED',
  ): void {
    try {
      const logDir = join(this.env.ctxRoot, 'logs', this.name);
      ensureDir(logDir);
      const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      const details =
        kind === 'HALTED'
          ? `exit_code=${exitCode} crash_count=${this.crashCount} max_crashes=${this.maxCrashesPerDay}`
          : `exit_code=${exitCode} crash_count=${this.crashCount} backoff_s=${backoffMs / 1000}`;
      const logLine = `[${timestamp}] ${kind}: ${details}\n`;
      appendFileSync(join(logDir, 'restarts.log'), logLine, 'utf-8');
    } catch {
      /* swallow — never break crash recovery on a logging failure */
    }
  }

  private resetCrashCountIfNewDay(today: string): void {
    const crashFile = join(this.env.ctxRoot, 'logs', this.name, '.crash_count_today');
    try {
      if (existsSync(crashFile)) {
        const content = readFileSync(crashFile, 'utf-8').trim();
        const [storedDate, count] = content.split(':');
        if (storedDate === today) {
          this.crashCount = parseInt(count, 10) + 1;
        } else {
          this.crashCount = 1;
        }
      }
      ensureDir(join(this.env.ctxRoot, 'logs', this.name));
      writeFileSync(crashFile, `${today}:${this.crashCount}`, 'utf-8');
    } catch { /* ignore */ }
  }

  private notifyStatusChange(): void {
    if (this.onStatusChange) {
      this.onStatusChange(this.getStatus());
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
