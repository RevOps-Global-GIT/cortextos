import { appendFileSync, existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { atomicWriteSync } from '../utils/atomic.js';
import { withSpan } from '../utils/observe.js';
import { join, resolve, sep } from 'path';
import { homedir } from 'os';
import { detectDayNightMode } from '../bus/heartbeat.js';
import type { AgentConfig, AgentStatus, CtxEnv } from '../types/index.js';
import { AgentPTY } from '../pty/agent-pty.js';
import { CodexAppServerPTY } from '../pty/codex-app-server-pty.js';
import { HermesPTY, hermesDbExists } from '../pty/hermes-pty.js';
import { ScriptPTY } from '../pty/script-pty.js';
import { MessageDedup, injectMessage } from '../pty/inject.js';
import { recordSpawnFailure } from './spawn-failure-alerter.js';
import type { TelegramAPI } from '../telegram/api.js';
import { ensureDir } from '../utils/atomic.js';
import { writeCortextosEnv } from '../utils/env.js';
import { getOverdueReminders } from '../bus/reminders.js';
import { resolveAgentCwd, resolvePaths } from '../utils/paths.js';
import type { CronScheduler, ManagedAgent } from './cron-scheduler.js';
import { detectContextCap, archiveCappedSession } from './context-cap-detect.js';
import { rotateOversizedDailyMemory } from './daily-memory-guard.js';

type LogFn = (msg: string) => void;

/**
 * Manages a single agent's lifecycle.
 * Replaces agent-wrapper.sh for one agent.
 */
export class AgentProcess implements ManagedAgent {
  readonly name: string;
  private env: CtxEnv;
  private config: AgentConfig;
  private pty: AgentPTY | CodexAppServerPTY | null = null;
  private sessionTimer: ReturnType<typeof setTimeout> | null = null;
  private crashCount: number = 0;
  private maxCrashesPerDay: number = 10;
  // CrashLoopPauser (instar-inspired): sliding-window crash detection.
  // Timestamps of recent crashes within the configured window. If the
  // window fills, the agent auto-pauses instead of retrying with backoff.
  private crashTimestamps: number[] = [];
  private crashWindowMs: number = 0;
  private crashWindowMax: number = 0;
  // Premature-voluntary-exit guard. When a claude session exits cleanly
  // (code 0, no signal) within `prematureExitThresholdMs` of starting and
  // no planned-exit markers were written, treat it as a "premature voluntary
  // exit." Almost always caused by `/exit` appearing inside a prompt or
  // handoff doc. We back off LONGER than a normal crash (rapid restart will
  // just re-trigger the same prompt path) and halt if too many fire in a
  // sliding window. See AgentConfig.premature_exit_window.
  private prematureExitTimestamps: number[] = [];
  private prematureExitWindowMs: number = 600_000;        // 10 min
  private prematureExitMax: number = 3;
  private prematureExitThresholdMs: number = 60_000;      // 60 s uptime
  private prematureExitBackoffMs: number = 300_000;       // 5 min
  private sessionStart: Date | null = null;
  private status: AgentStatus['status'] = 'stopped';
  private stopping: boolean = false;
  // Timestamp (epoch ms) of the last successful inject — used by isIdle() to
  // tell the daemon-side CronScheduler whether the agent is still processing
  // a previously-injected message. Cleared when we observe a fresh idle flag.
  private lastInjectedAt: number = 0;
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
  private cronScheduler: CronScheduler | null;
  // Issue #330: held here so CodexAppServerPTY can be re-wired across session refresh
  // (each start() recreates the PTY, but the Telegram handle persists).
  private telegramApi: TelegramAPI | null = null;
  private telegramChatId: string | null = null;
  // Spawn-verify (gen-B): bootstrap-completion is the line between the spawn-
  // retry budget and crash-recovery. everBootstrapped flips on a real bootstrap
  // (markBootstrapped) and routes future exits to crash-recovery; spawnAttempts
  // is the unified pre-bootstrap budget (reset on bootstrap); spawnVerifying
  // makes handleExit defer to the settle poll during the post-spawn window.
  private everBootstrapped = false;
  private spawnAttempts = 0;
  private spawnVerifying = false;
  /** Settle window (ms) to confirm a spawned pid stays alive — INJECTABLE for tests. */
  static spawnSettleMs = 500;
  /** Settle poll interval (ms) — INJECTABLE for tests. */
  static spawnSettlePollMs = 100;

  constructor(name: string, env: CtxEnv, config: AgentConfig, log?: LogFn, cronScheduler?: CronScheduler | null) {
    this.name = name;
    this.env = env;
    this.config = config;
    if (config.max_crashes_per_day !== undefined) {
      this.maxCrashesPerDay = config.max_crashes_per_day;
    }
    if (config.crash_window?.seconds) {
      this.crashWindowMs = config.crash_window.seconds * 1000;
      this.crashWindowMax = config.crash_window.max_crashes ?? 3;
    }
    // Premature-voluntary-exit guard. `seconds: 0` disables entirely.
    if (config.premature_exit_window !== undefined) {
      const pew = config.premature_exit_window;
      if (pew.seconds === 0) {
        this.prematureExitWindowMs = 0; // disabled
      } else {
        if (pew.seconds !== undefined) this.prematureExitWindowMs = pew.seconds * 1000;
        if (pew.max_exits !== undefined) this.prematureExitMax = pew.max_exits;
        if (pew.threshold_seconds !== undefined) {
          this.prematureExitThresholdMs = pew.threshold_seconds * 1000;
        }
        if (pew.backoff_seconds !== undefined) {
          this.prematureExitBackoffMs = pew.backoff_seconds * 1000;
        }
      }
    }
    this.dedup = new MessageDedup();
    this.log = log || ((msg) => console.log(`[${name}] ${msg}`));
    this.cronScheduler = cronScheduler ?? null;
  }

  // --- ManagedAgent interface (daemon-side CronScheduler) ---

  get stateDir(): string {
    return join(this.env.ctxRoot, 'state', this.name);
  }

  get configPath(): string {
    return join(this.env.agentDir, 'config.json');
  }

  get timezone(): string | undefined {
    return this.config.timezone || undefined;
  }

  get generation(): number {
    return this.lifecycleGeneration;
  }

  isRunning(): boolean {
    return this.status === 'running' && this.hasLivePtyProcess();
  }

  /**
   * True when the in-memory lifecycle says "running" but the backing PTY
   * process is no longer live. AgentManager uses this to recover the registry
   * wedge where startAgent() would otherwise dedupe against a dead entry.
   */
  isDeadButRegistered(): boolean {
    return this.status === 'running' && !this.hasLivePtyProcess();
  }

  /**
   * Mark a missing backing process as crashed so a manager-driven restart can
   * tear down stale per-agent resources before starting a fresh PTY.
   */
  markProcessDead(reason: string): void {
    if (this.status !== 'running') return;
    this.log(`Process liveness lost while registered as running: ${reason}`);
    this.stopRequested = true;
    this.pty = null;
    this.clearSessionTimer();
    this.status = 'crashed';
    this.notifyStatusChange();
  }

  /**
   * Idle iff the Stop hook's last_idle.flag timestamp is newer than the most
   * recent inject. Returns true when we have never injected yet (safe to fire).
   * Returns false when we can't read the flag (conservative — defer fires and
   * let maxDeferMs force-inject).
   */
  isIdle(): boolean {
    if (this.lastInjectedAt === 0) return true;
    const flagPath = join(this.stateDir, 'last_idle.flag');
    try {
      if (!existsSync(flagPath)) return false;
      const idleMs = parseInt(readFileSync(flagPath, 'utf-8').trim(), 10) * 1000;
      return idleMs > this.lastInjectedAt;
    } catch {
      return false;
    }
  }

  /** CronScheduler.inject(). Delegates to injectMessage and tracks timestamp. */
  inject(message: string): boolean {
    const ok = this.injectMessage(message);
    if (ok) this.lastInjectedAt = Date.now();
    return ok;
  }

  private hasLivePtyProcess(): boolean {
    if (!this.pty || !this.pty.isAlive()) return false;

    const pid = this.pty.getPid();
    if (pid && process.platform !== 'win32') {
      try {
        process.kill(pid, 0);
      } catch {
        return false;
      }
    }

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

    // Boot-loop guard: rotate an oversized daily memory file before the session
    // reads it whole during its boot checklist (see card d30fe222).
    this.guardOversizedDailyMemory();

    // Determine start mode
    const mode = this.shouldContinue() ? 'continue' : 'fresh';
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

    // Create PTY — runtime-specific subclass handles binary, args, bootstrap detection
    const logPath = join(this.env.ctxRoot, 'logs', this.name, 'stdout.log');
    ensureDir(join(this.env.ctxRoot, 'logs', this.name));
    this.log(`Log path: ${logPath}`);

    // Spawn with verification + bounded retry (gen-B spawn-verify). One call to
    // start() consumes one persistent pre-bootstrap spawn attempt. node-pty can
    // return a PTY object for a dead or briefly-alive wrapper process, so require
    // both an immediately live pid and survival through a bounded settle window.
    // Any pre-bootstrap exit routes to onPreBootstrapExit, which retries up to
    // MAX_SPAWN_ATTEMPTS then records SPAWN-FAILED registry truth.
    this.spawnAttempts++;
    this.pty = this.config.runtime === 'hermes'
      ? new HermesPTY(this.env, this.config, logPath)
      : this.config.runtime === 'codex-app-server'
        ? new CodexAppServerPTY(this.env, this.config, logPath)
        : this.config.runtime === 'script'
          ? new ScriptPTY(this.env, this.config, logPath)
          : new AgentPTY(this.env, this.config, logPath);

    // Issue #330: re-wire the Telegram handle (only CodexAppServerPTY uses it).
    if (this.config.runtime === 'codex-app-server' && this.telegramApi && this.telegramChatId) {
      (this.pty as CodexAppServerPTY).setTelegramHandle(this.telegramApi, this.telegramChatId);
    }

    // BUG-011 fix: fresh exit signal; stop() awaits exitPromise.
    this.exitPromise = new Promise<void>((resolve) => {
      this.resolveExit = resolve;
    });
    this.pty.onExit((exitCode, signal) => {
      // BUG-040 fix: ignore a late exit from a superseded lifecycle generation.
      if (myGeneration !== this.lifecycleGeneration) {
        this.log(`Ignoring late exit from previous lifecycle gen ${myGeneration} (current: ${this.lifecycleGeneration})`);
        return;
      }
      this.log(`Exited with code ${exitCode} signal ${signal}`);
      this.handleExit(exitCode, signal);
      this.resolveExit?.();
      this.resolveExit = null;
    });

    try {
      const agentName = this.name;
      const ptyRef = this.pty;
      await withSpan('daemon.agent_spawn', () => ptyRef!.spawn(mode, prompt), {
        agent: agentName,
        attributes: { mode, has_prompt: prompt ? 'true' : 'false' },
      });

      // Codex exec-per-turn legit fast exit: onExit nulled this.pty. handleExit
      // owns it — not a spawn failure.
      if (!this.pty) {
        this.log('PTY exited during spawn — handleExit will recover');
        return;
      }

      // Immediate pid probe: a posix_spawnp corpse is dead/absent right away.
      const spawnedPid = this.pty.getPid();
      if (spawnedPid === null || spawnedPid <= 0 || !isPidAlive(spawnedPid)) {
        this.onPreBootstrapExit(`spawn produced no live pid (pid=${spawnedPid ?? 'null'})`);
        return;
      }

      // SETTLE: catch a briefly-alive WRAPPER pid that dies as the exec fails
      // inside (the gen-B shape the immediate probe misses). spawnVerifying makes
      // handleExit defer to this poll so a mid-settle death routes exactly once.
      // Skipped for codex-app-server (its exec-per-turn model legitimately exits).
      if (this.config.runtime !== 'codex-app-server') {
        this.spawnVerifying = true;
        try {
          for (let waited = 0; waited < AgentProcess.spawnSettleMs; waited += AgentProcess.spawnSettlePollMs) {
            await sleep(AgentProcess.spawnSettlePollMs);
            if (!this.pty || !this.pty.isAlive() || !isPidAlive(spawnedPid)) {
              this.spawnVerifying = false;
              this.onPreBootstrapExit(`pid ${spawnedPid} died within the ${AgentProcess.spawnSettleMs}ms settle window`);
              return;
            }
          }
        } finally {
          this.spawnVerifying = false;
        }
      }

      // Survived the settle window. 'running', but NOT yet bootstrapped — a
      // pre-bootstrap exit from here still routes to the spawn-retry budget; only
      // a real bootstrap (markBootstrapped, from the fast-checker) hands the
      // agent over to crash-recovery and resets the budget.
      this.status = 'running';
      this.sessionStart = new Date();
      this.lastInjectedAt = 0;
      this.log(`Running (pid: ${spawnedPid})`);
      // Write an initial heartbeat.json at process-start so the stale-heartbeat
      // watcher sees a fresh timestamp immediately. Without this, an agent whose
      // heartbeat cron fired shortly before restart won't write a new heartbeat
      // until `interval - elapsed` minutes later, causing false stale alarms and
      // premature restart loops. We write only the file (no Supabase upsert) to
      // keep the hot path synchronous and non-blocking.
      try {
        const stateDir = join(this.env.ctxRoot, 'state', this.name);
        ensureDir(stateDir);
        const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
        atomicWriteSync(join(stateDir, 'heartbeat.json'), JSON.stringify({
          agent: this.name,
          org: this.env.org ?? '',
          status: 'starting',
          current_task: '',
          mode: detectDayNightMode(this.config.timezone ?? 'UTC'),
          last_heartbeat: ts,
          loop_interval: '',
        }));
        this.log(`Boot heartbeat written (${ts})`);
      } catch (err) {
        this.log(`Boot heartbeat write failed (non-fatal): ${err}`);
      }
      this.startSessionTimer();
      // Attach to the daemon-side CronScheduler so config.json crons fire
      // via PTY injection regardless of in-session CronCreate state.
      try {
        this.cronScheduler?.attachAgent(this);
      } catch (err) {
        this.log(`CronScheduler attach failed (non-fatal): ${err}`);
      }
      this.notifyStatusChange();
    } catch (err) {
      try { this.pty?.kill(); } catch { /* already dead */ }
      this.pty = null;
      this.onPreBootstrapExit(`spawn threw: ${err}`);
    }
  }

  /**
   * A pre-bootstrap exit (the process died before it ever bootstrapped, and was
   * not intentionally stopped) — from the settle poll or from handleExit. Routes
   * to the unified bounded spawn-retry budget: retry up to MAX_SPAWN_ATTEMPTS,
   * then SPAWN-FAILED + fleet alert + STOP (no crash-loop). This REPLACES the
   * crash-recovery path for pre-bootstrap exits (which is now post-bootstrap
   * only), tightening the bound from max_crashes_per_day (~10, silent) to 3-loud.
   */
  private onPreBootstrapExit(reason: string): void {
    if (this.everBootstrapped || this.status === 'spawn-failed' || this.stopRequested) return;
    this.clearSessionTimer();
    this.pty = null;
    const failureClass = classifySpawnFailure(reason);
    if (this.spawnAttempts >= MAX_SPAWN_ATTEMPTS) {
      this.markSpawnFailed(failureClass);
      return;
    }
    // The agent died — it is no longer running, so clear the 'running' status or
    // the retry's start() would bail with "Already running".
    this.status = 'starting';
    const backoff = SPAWN_RETRY_BASE_MS * 2 ** (this.spawnAttempts - 1); // 1s, 2s
    this.log(`Pre-bootstrap exit (attempt ${this.spawnAttempts}/${MAX_SPAWN_ATTEMPTS}, ${failureClass}): ${reason} — retrying in ${backoff}ms`);
    setTimeout(() => {
      if (this.status === 'spawn-failed' || this.stopRequested || this.everBootstrapped) return;
      void this.start();
    }, backoff);
  }

  /**
   * Record SPAWN-FAILED registry truth + feed the fleet-wide operator alert, and
   * STOP (no retry, no crash-recovery). Recoverable: the operator alert prompts a
   * `cortextos enable` (resets the budget), and a daemon restart re-attempts with
   * spawnAttempts=0.
   */
  private markSpawnFailed(failureClass: string): void {
    if (this.status === 'spawn-failed') return;
    this.status = 'spawn-failed';
    this.pty = null;
    this.clearSessionTimer();
    this.notifyStatusChange();
    recordSpawnFailure(this.name, failureClass);
    this.log(`SPAWN-FAILED after ${MAX_SPAWN_ATTEMPTS} attempts (${failureClass}) — agent is NOT running (recover via re-enable or daemon restart)`);
  }

  /**
   * The agent reached bootstrap — hand it over to crash-recovery for any future
   * exit, and reset the spawn-retry budget so a long-lived agent that crashes
   * months later isn't judged against stale pre-boot attempts. Called by the
   * fast-checker when waitForBootstrap succeeds (incl. the alive-but-quiet path).
   */
  markBootstrapped(): void {
    this.everBootstrapped = true;
    this.spawnAttempts = 0;
  }

  /** True once the agent has bootstrapped at least once this lifecycle. */
  hasBootstrapped(): boolean {
    return this.everBootstrapped;
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

    // Capture and null out pty BEFORE any awaits so handleExit() during graceful
    // shutdown doesn't race with us and trigger crash recovery or a double-kill.
    const pty = this.pty;
    this.pty = null;
    // Capture the exit promise before any awaits — we'll wait on this AFTER
    // pty.kill() to guarantee the exit handler has run before stopping=false.
    const exitPromise = this.exitPromise;

    if (pty) {
      try {
        if (this.config.runtime === 'hermes') {
          // Hermes REPL exit: Ctrl+D is the clean exit signal.
          // Hermes has a double-tap guard on Ctrl+C (accidental exit protection),
          // so we use Ctrl+D which exits cleanly on the first press.
          pty.write('\x04'); // Ctrl+D
          await sleep(3000);
        } else if (this.config.runtime === 'codex-app-server' || this.config.runtime === 'script') {
          // Codex uses an exec-per-turn model and script bridges own their loop —
          // neither has a REPL to exit gracefully. Just kill() directly.
          // Skipping the 6s Claude-REPL dance makes hard-restart feel responsive.
        } else {
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
        }
      } catch {
        // Ignore write errors during shutdown
      }
      // BUG-032 follow-up: only kill the PTY if the process is still alive.
      // After /exit + 5s wait, the child has usually exited cleanly. Calling
      // pty.kill() on an already-exited PTY tears down the file descriptor,
      // which can send SIGHUP (exit code 129) to a process that was in the
      // middle of flushing. Polling first eliminates the remaining SIGHUP risk.
      //
      // Capture the OS pid BEFORE pty.kill() — the wrapper nulls its handle and
      // flips isAlive() to false on the first kill(), so a later liveness recheck
      // through the wrapper is impossible. The pid lets us confirm a real exit
      // and escalate a wedged child (#202).
      let childPid: number | null = null;
      let descendantPids: number[] = [];
      if (pty.isAlive()) {
        childPid = pty.getPid();
        // Snapshot the descendant tree NOW, while it is still attached to the
        // leader (children are ppid-children until the leader dies). A child
        // that put itself in its OWN process group (job control / setpgid /
        // detached helper) survives a leader process-group SIGKILL and reparents
        // to pid 1 — the group signal alone misses it. Capturing by ppid here
        // lets the escalation SIGKILL each survivor by pid regardless of group.
        if (childPid !== null) descendantPids = collectDescendants(childPid);
        try {
          pty.kill(); // graceful SIGTERM via node-pty
        } catch {
          // PTY may have exited between the check and the kill — ignore
        }
      }

      // BUG-011 fix: AWAIT the exit handler before resolving stop().
      // #202 hard-restart fix: SIGTERM alone never escalates, so a wedged child
      // (and its descendants) could survive `bus hard-restart` as a zombie. Wait
      // a bounded window for the graceful exit; if the pid is still alive,
      // SIGKILL the whole PROCESS GROUP so no orphaned children survive (node-pty
      // spawns the child as a session leader, so the negative-pid signal reaps
      // the descendant tree — orphaned grandchildren are exactly the OS resource
      // exhaustion this class produced). pid-fallback + a kill(pid,0) liveness
      // guard keep it from signalling a recycled pid.
      if (exitPromise) {
        const exitedGracefully = await Promise.race([
          exitPromise.then(() => true),
          sleep(HARD_KILL_GRACE_MS).then(() => false),
        ]);
        if (!exitedGracefully && childPid !== null && isPidAlive(childPid)) {
          this.log(`PTY pid ${childPid} still alive ${HARD_KILL_GRACE_MS}ms after SIGTERM — escalating to SIGKILL on the process group (#202)`);
          hardKillProcessGroup(childPid);
          await Promise.race([exitPromise, sleep(5000)]);
        }
        // Regardless of how the leader exited, reap any descendant that outlived
        // it. Own-pgroup children orphan to pid 1 and escape BOTH the
        // SIGHUP-on-leader-death and a leader-group SIGKILL, so the group signal
        // is not sufficient — SIGKILL each snapshotted descendant still alive.
        // (This is the completion of (b): orphaned descendants are the suspected
        // OS process-exhaustion mechanism.)
        const survivors = descendantPids.filter(isPidAlive);
        if (survivors.length > 0) {
          this.log(`Reaping ${survivors.length} surviving PTY descendant(s) by pid after teardown — own-pgroup orphans escape the group signal (#202)`);
          for (const pid of survivors) {
            try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
          }
        }
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

    // Write .session-refresh marker BEFORE stop() so hook-crash-alert can
    // classify this exit as a planned session rotation (not a crash).
    const markerPath = join(this.env.ctxRoot, 'state', this.name, '.session-refresh');
    try {
      ensureDir(join(this.env.ctxRoot, 'state', this.name));
      writeFileSync(markerPath, 'session timer reached limit', 'utf-8');
    } catch { /* non-fatal */ }

    // Detect context-handoff: fast-checker writes .force-fresh before calling
    // sessionRefresh() for context-exhaustion restarts.
    const forceFreshExists = existsSync(join(this.env.ctxRoot, 'state', this.name, '.force-fresh'));
    const rotationType = forceFreshExists ? 'context-handoff' : 'soft';
    this.writeRotationEvent(rotationType, 'session timer reached limit').catch(() => {});

    await this.stop();
    await this.start();
    this.updateRotationResumeSuccess().catch(() => {});
    this.log('Session refreshed');
  }

  /**
   * Inject a message into the agent's PTY — structured outcome.
   *
   * Distinguishes NOT_RUNNING (agent registered but no live PTY) from
   * DEDUPED (content collapsed against the in-process MessageDedup window).
   * See issue #346 — both used to surface as a bare `false` and got mistaken
   * for "agent not found" by operators investigating restart/cron failures.
   *
   * For Hermes agents bracketed paste is buggy (NousResearch/hermes-agent
   * issue #7316 — ESC[200~/ESC[201~ markers leak and corrupt input). We use
   * the same file-based approach as the startup injection: write the prompt
   * to .cortextos-cron.md in the agent dir, then send a plain
   * `Read .cortextos-cron.md and follow the instructions there.\r`
   * without any bracketed paste wrapper.
   */
  injectMessageDetailed(content: string): { ok: true } | { ok: false; code: 'NOT_RUNNING' | 'DEDUPED'; message: string } {
    if (!this.pty || this.status !== 'running') {
      return { ok: false, code: 'NOT_RUNNING', message: `agent "${this.name}" is registered but not running (status: ${this.status})` };
    }

    if (this.dedup.isDuplicate(content)) {
      this.log('Dedup: skipping duplicate message');
      return { ok: false, code: 'DEDUPED', message: `inject for "${this.name}" deduped — content matches MessageDedup hash window` };
    }

    if (this.config.runtime === 'hermes') {
      // File-based injection avoids bracketed paste corruption in Hermes.
      const cronFile = join(this.env.agentDir, '.cortextos-cron.md');
      try {
        writeFileSync(cronFile, content, 'utf-8');
      } catch (err) {
        this.log(`[hermes inject] failed to write cron file: ${err}`);
        return { ok: false, code: 'NOT_RUNNING', message: `[hermes inject] failed to write cron file: ${err}` };
      }
      this.pty.write('Read .cortextos-cron.md and follow the instructions there.\r');
      return { ok: true };
    }

    injectMessage((data) => this.pty?.write(data), content);
    return { ok: true };
  }

  /**
   * Inject a message into the agent's PTY (back-compat boolean wrapper).
   * New callers that need to distinguish DEDUPED from NOT_RUNNING should use
   * `injectMessageDetailed()` instead.
   */
  injectMessage(content: string): boolean {
    return this.injectMessageDetailed(content).ok;
  }

  /**
   * Check if the agent has bootstrapped (ready for messages).
   */
  isBootstrapped(): boolean {
    return this.pty?.getOutputBuffer().isBootstrapped() ?? false;
  }

  /**
   * True if the agent's PTY process is alive at the OS level. Unlike the PTY
   * wrapper's optimistic `_alive` flag (set true on spawn and only cleared by
   * onExit — a posix_spawnp corpse keeps it true), this probes the real pid, so
   * the fast-checker can distinguish a dead process from an alive-but-quiet one
   * during the bootstrap wait (gen-B: never log "Bootstrap complete" for a corpse).
   */
  isProcessAlive(): boolean {
    const pid = this.pty?.getPid();
    return pid != null && pid > 0 && isPidAlive(pid);
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
   * Wire the agent's Telegram bot handle. Used by CodexAppServerPTY (issue #330) to
   * fire sendChatAction directly from the JSONL stream. Safe to call before
   * or after start() — the handle is re-applied on every PTY (re)spawn.
   */
  setTelegramHandle(api: TelegramAPI, chatId: string): void {
    this.telegramApi = api;
    this.telegramChatId = chatId;
    if (this.config.runtime === 'codex-app-server' && this.pty) {
      (this.pty as CodexAppServerPTY).setTelegramHandle(api, chatId);
    }
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

  /**
   * Get the agent directory (where config.json and .env live).
   */
  getAgentDir(): string {
    return this.env.agentDir;
  }

  /**
   * Get the current agent config (live reference — fields may be updated in-place).
   */
  getConfig(): AgentConfig {
    return this.config;
  }

  // --- Private methods ---

  private handleExit(exitCode: number, signal?: number): void {
    // Snapshot uptime BEFORE we null this.pty / clear the session timer below.
    // The premature-voluntary-exit check needs to know how long the session
    // actually ran for.
    const sessionUptimeMs = this.sessionStart
      ? Date.now() - this.sessionStart.getTime()
      : 0;

    // Capture rate-limit state from the output buffer BEFORE nulling the PTY.
    // Once this.pty = null, we lose access to the buffer.
    const isRateLimited = this.pty?.getOutputBuffer()?.hasRateLimitSignature() ?? false;
    const rateLimitResetSeconds = isRateLimited
      ? (this.pty?.getOutputBuffer()?.getRateLimitResetSeconds() ?? null)
      : null;

    // Spawn-verify: during the post-spawn settle window the settle poll owns the
    // death (it routes to onPreBootstrapExit exactly once). Defer — do NOT null
    // pty or recover here, or the settle's pid probe loses its handle.
    if (this.spawnVerifying) {
      return;
    }

    this.pty = null;
    this.clearSessionTimer();

    // Boot-failure guard: if the heartbeat.json still reads "starting" (the
    // agent never progressed past its first cortextos bus update-heartbeat
    // call), rewrite it to "crashed" so the fleet view shows the true state
    // instead of leaving a stale "starting" entry indefinitely. Only overwrite
    // when the current status is exactly "starting" — never clobber a
    // legitimate "online", "offline", or already-written "crashed" value.
    try {
      const hbPath = join(this.env.ctxRoot, 'state', this.name, 'heartbeat.json');
      if (existsSync(hbPath)) {
        const hbData = JSON.parse(readFileSync(hbPath, 'utf-8'));
        if (hbData.status === 'starting') {
          hbData.status = 'crashed';
          atomicWriteSync(hbPath, JSON.stringify(hbData));
          this.log('Boot-failure: heartbeat.json updated from "starting" to "crashed"');
        }
      }
    } catch {
      /* non-fatal — heartbeat correction must never block crash recovery */
    }

    // Detach from CronScheduler so no fires race a dead PTY. A subsequent
    // start() (crash recovery, session refresh) re-attaches with the new
    // generation; detaching here also ensures the scheduler doesn't hold a
    // stale ManagedAgent reference if the agent HALTs.
    try {
      this.cronScheduler?.detachAgent(this.name);
    } catch { /* non-fatal */ }

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

    // Rate-limit recovery: if the output buffer detected a rate-limit signature,
    // treat this as a controlled pause rather than a crash. Do NOT increment
    // crashCount or call watchdog recordFailure. Write a marker file so the next
    // startup can include RATE-LIMIT RECOVERY context, then schedule a restart
    // after the configured (or default) pause duration.
    if (isRateLimited) {
      this.status = 'rate-limited';
      this.notifyStatusChange();

      // Write .rate-limited marker so the next boot knows this was a rate-limit pause
      const markerPath = join(this.env.ctxRoot, 'state', this.name, '.rate-limited');
      try {
        ensureDir(join(this.env.ctxRoot, 'state', this.name));
        writeFileSync(markerPath, new Date().toISOString(), 'utf-8');
      } catch { /* non-fatal */ }

      // Schedule restart after pause
      const pauseSeconds = rateLimitResetSeconds
        ?? (this.config as Record<string, unknown>).rate_limit_pause_seconds as number | undefined
        ?? 18000;
      this.log(`Rate-limited: pausing ${pauseSeconds}s before restart`);

      setTimeout(() => {
        if (this.status === 'rate-limited') {
          this.start().catch(err => this.log(`Rate-limit restart failed: ${err}`));
        }
      }, pauseSeconds * 1000);

      return;
    }

    // Spawn-verify boundary (gen-B): bootstrap-completion is the semantic line.
    // An exit BEFORE the agent ever bootstrapped is a failed start — route it to
    // the unified spawn-retry budget, not crash-recovery. Crash-recovery below
    // serves post-bootstrap crashes only.
    if (!this.everBootstrapped && this.status !== 'spawn-failed') {
      this.onPreBootstrapExit(`exited code ${exitCode} before bootstrap`);
      return;
    }

    // Planned restart: the agent wrote .restart-planned via `cortextos bus hard-restart`
    // (or `bus self-restart`) before the session ended. This is an intentional exit —
    // skip crash counting entirely. The IPC restart-agent handler (triggered by the bus
    // command) will call restartAgent() → stop() + start() to bring the agent back up.
    // We do NOT unlink the marker here — hook-crash-alert.ts owns cleanup on next boot.
    const restartPlannedPath = join(this.env.ctxRoot, 'state', this.name, '.restart-planned');
    if (existsSync(restartPlannedPath)) {
      this.log('Planned restart (.restart-planned) — skipping crash count');
      return;
    }

    // Already halted: zombie processes (not SIGKILLed in time) can exit after the crash
    // ceiling is hit, producing HALTED log entries past max_crashes and potentially
    // re-entering the crash backoff loop. Skip all processing for late zombie exits.
    if (this.status === 'halted') {
      this.log(`Zombie exit ignored — agent already halted (exit_code=${exitCode})`);
      return;
    }

    // ctx_autoreset (Tier 0): FastChecker writes .silent-restart before triggering
    // forceContextRestart(). Normally stopRequested is set by sessionRefresh() → stop()
    // before handleExit fires, but in edge cases (e.g. Claude Code exits before stop()
    // is called) this marker is the canonical signal. Skip crash counting.
    // Do NOT unlink — consumed by buildStartPrompt() on the next session boot.
    const silentRestartPath = join(this.env.ctxRoot, 'state', this.name, '.silent-restart');
    if (existsSync(silentRestartPath)) {
      this.log('ctx_autoreset (.silent-restart) — skipping crash count, sessionRefresh handles restart');
      return;
    }

    // Premature-voluntary-exit guard.
    //
    // Symptom: a claude session exits with code 0 (no signal) within a short
    // window of starting. By the time we get here, every "planned" exit path
    // above has already returned — so this is not a daemon-initiated stop,
    // not a planned restart, not a silent ctx-autoreset, not a rate-limit
    // pause, not a daemon shutdown. The remaining cause is the agent itself
    // calling `/exit` from inside its session: a prompt, handoff doc, or
    // AGENTS.md fragment fed `/exit` into the REPL.
    //
    // Treating this as a normal crash is counterproductive: exponential
    // backoff starts at 5s, so within minutes the daemon has restarted the
    // session 5+ times and re-fed the same prompt path each time. The
    // watchdog circuit-breaker then trips and we have a hard outage.
    //
    // Instead:
    //   - Do NOT increment crashCount.
    //   - Back off LONGER (default 5 min) so the operator has time to notice
    //     and the next restart isn't a guaranteed re-trigger.
    //   - Track premature exits in their own sliding window; halt the agent
    //     after `prematureExitMax` of them inside `prematureExitWindowMs`.
    //     Manual intervention is required to bring it back — auto-restart at
    //     that point is just a tighter loop.
    //
    // Detection: exit code 0, no terminating signal, and uptime below the
    // configured threshold (default 60s). The window check is gated on a
    // non-zero `prematureExitWindowMs` so an operator can disable this guard
    // entirely via `premature_exit_window: { seconds: 0 }`.
    const isVoluntaryCleanExit =
      exitCode === 0 && (signal === undefined || signal === 0 || signal === null);
    // Only claude-code runtime (AgentPTY) is exposed to the /exit footgun.
    // Codex is exec-per-turn and exits cleanly by design; script bridges own
    // their own lifecycle; hermes uses Ctrl+D. Restricting the guard to
    // claude-code avoids false halts on the other runtimes. `runtime` is the
    // `AgentConfig['runtime']` enum: `'claude-code' | 'hermes' |
    // 'codex-app-server' | 'script'`, defaulting to 'claude-code' when absent.
    const isClaudeRuntime =
      this.config.runtime === undefined || this.config.runtime === 'claude-code';
    // sessionStart is set inside start() after pty.spawn() resolves. If the
    // PTY managed to fire onExit before that line ran, sessionStart is still
    // null and sessionUptimeMs is 0 — we have no signal here, fall through
    // to normal crash recovery. Use `>= 0` plus the sessionStart guard so
    // a same-tick exit (uptime 0 with sessionStart set) is still classified
    // as premature.
    const isPrematureExit =
      isClaudeRuntime &&
      isVoluntaryCleanExit &&
      this.prematureExitWindowMs > 0 &&
      this.sessionStart !== null &&
      sessionUptimeMs >= 0 &&
      sessionUptimeMs < this.prematureExitThresholdMs;

    if (isPrematureExit) {
      const now = Date.now();
      this.prematureExitTimestamps.push(now);
      this.prematureExitTimestamps = this.prematureExitTimestamps.filter(
        (ts) => now - ts <= this.prematureExitWindowMs,
      );

      const uptimeS = Math.round(sessionUptimeMs / 1000);
      const windowS = this.prematureExitWindowMs / 1000;

      if (this.prematureExitTimestamps.length >= this.prematureExitMax) {
        this.log(
          `PREMATURE_EXIT_LOOP: ${this.prematureExitTimestamps.length} ` +
            `clean exits with uptime<${this.prematureExitThresholdMs / 1000}s in ${windowS}s window — ` +
            `halting (likely '/exit' in a prompt or handoff doc; manual intervention required)`,
        );
        this.appendCrashToRestartsLog(exitCode, 0, 'PREMATURE_EXIT_LOOP');
        this.status = 'halted';
        this.notifyStatusChange();
        return;
      }

      this.log(
        `Premature voluntary exit detected (uptime=${uptimeS}s, code=0, signal=${signal ?? 0}). ` +
          `Likely '/exit' fired from inside the session. ` +
          `Backing off ${this.prematureExitBackoffMs / 1000}s before restart ` +
          `(${this.prematureExitTimestamps.length}/${this.prematureExitMax} in ${windowS}s).`,
      );
      this.appendCrashToRestartsLog(exitCode, this.prematureExitBackoffMs, 'PREMATURE_EXIT');
      this.writeRotationEvent('premature_exit', `exit_code=${exitCode} uptime_s=${uptimeS}`).catch(() => {});
      // We use status='crashed' so the existing dashboard / restart guard
      // semantics still apply (the restart setTimeout below checks for this).
      // We deliberately do NOT add a new status to AgentStatus — the
      // distinction lives in restarts.log and the daemon log line above.
      this.status = 'crashed';
      this.notifyStatusChange();

      setTimeout(() => {
        if (this.status === 'crashed') {
          this.start()
            .then(() => this.updateRotationResumeSuccess().catch(() => {}))
            .catch((err) => this.log(`Premature-exit restart failed: ${err}`));
        }
      }, this.prematureExitBackoffMs);
      return;
    }

    // CrashLoopPauser: if a sliding window is configured, check before the
    // legacy daily counter. 3 crashes in 30 minutes is a crash loop even if
    // the daily budget is far from exhausted.
    if (this.crashWindowMs > 0) {
      const now = Date.now();
      this.crashTimestamps.push(now);
      this.crashTimestamps = this.crashTimestamps.filter(
        (ts) => now - ts <= this.crashWindowMs,
      );
      if (this.crashTimestamps.length >= this.crashWindowMax) {
        this.log(
          `CRASH_LOOP: ${this.crashTimestamps.length} crashes in ${this.crashWindowMs / 1000}s window — auto-pausing`,
        );
        this.appendCrashToRestartsLog(exitCode, 0, 'CRASH_LOOP');
        this.status = 'halted';
        this.notifyStatusChange();
        return;
      }
    }

    // Legacy daily crash counter
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
    this.writeRotationEvent('crash', `exit_code=${exitCode}`).catch(() => {});
    // Persist the crash to restarts.log so operators have a durable audit
    // trail. Previously only planned SELF-RESTART / HARD-RESTART from
    // bus/system.ts wrote here, which left daemon-classified crashes
    // invisible outside the rotating PM2 daemon stdout log.
    this.appendCrashToRestartsLog(exitCode, backoff, 'CRASH');
    this.status = 'crashed';
    this.notifyStatusChange();

    setTimeout(() => {
      if (this.status === 'crashed') {
        this.start()
          .then(() => this.updateRotationResumeSuccess().catch(() => {}))
          .catch(err => this.log(`Restart failed: ${err}`));
      }
    }, backoff);
  }

  private shouldContinue(): boolean {
    // Hermes: session continuity is determined by whether the SQLite DB exists.
    // HERMES_HOME env var overrides the default ~/.hermes path.
    if (this.config.runtime === 'hermes') {
      const hermesHome = process.env['HERMES_HOME'];
      return hermesDbExists(hermesHome);
    }

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
    const launchDir = resolveAgentCwd(this.env.agentDir, this.config.working_directory);
    if (!launchDir) return false;

    // Claude projects dir uses the absolute path with all separators replaced by dashes
    // e.g. /Users/foo/agents/boss -> -Users-foo-agents-boss (leading sep becomes -)
    // Use homedir() for cross-platform compatibility (HOME is not set on Windows).
    // When config.home is set, resolve projects dir from config.home instead of homedir().
    const effectiveHome = this.config.home
      ? resolve(this.config.home.replace(/^~/, homedir()))
      : homedir();
    const convDir = join(
      effectiveHome,
      '.claude',
      'projects',
      launchDir.split(sep).join('-'),
    );

    try {
      const files = require('fs').readdirSync(convDir);
      if (!files.some((f: string) => f.endsWith('.jsonl'))) return false;
    } catch {
      return false;
    }

    // Context-cap zombie guard: if the most recent session jsonl ends
    // with Claude Code's "Context limit reached" marker, --continue
    // would restore that stuck state and re-zombie the agent on
    // restart. Archive the capped session aside so --continue has
    // nothing to pick up, then force a fresh session. Observed
    // 2026-04-19 with FRIDAY; full incident + design in
    // src/daemon/context-cap-detect.ts.
    const cap = detectContextCap(convDir);
    if (cap.capped && cap.sessionFile) {
      const archivePath = archiveCappedSession(cap.sessionFile);
      if (archivePath) {
        this.log(
          `Context-cap detected in prior session ${cap.sessionFile} — ` +
          `archived to ${archivePath}, forcing fresh session to break zombie loop.`,
        );
      } else {
        this.log(
          `Context-cap detected in ${cap.sessionFile} but archive rename failed — ` +
          `forcing fresh session anyway; --continue may restore the capped state.`,
        );
      }
      // Re-check whether any non-archived jsonl remains. If all sessions
      // were capped (or the only one was), we must start fresh.
      try {
        const remaining = require('fs').readdirSync(convDir);
        if (!remaining.some((f: string) => f.endsWith('.jsonl'))) return false;
      } catch {
        return false;
      }
      // An older non-capped session still exists — safer to start fresh
      // anyway, since --continue would pick up the next-most-recent
      // which may itself be stale. One zombie is enough evidence to
      // distrust the whole recent history for this agent.
      return false;
    }

    return true;
  }

  /**
   * Boot-loop guard (card d30fe222): rotate an oversized daily memory file before
   * the session reads it whole during boot. See daily-memory-guard.ts for the why.
   */
  private guardOversizedDailyMemory(): void {
    rotateOversizedDailyMemory(this.env.agentDir, this.name, undefined, (msg) => this.log(msg));
  }

  private buildStartupPrompt(): string {
    const onboardedPath = join(this.env.ctxRoot, 'state', this.name, '.onboarded');
    const onboardingPath = join(this.env.agentDir, 'ONBOARDING.md');
    const heartbeatPath = join(this.env.ctxRoot, 'state', this.name, 'heartbeat.json');
    let onboardingAppend = '';
    // Telegram-optional: when no bot is configured, this is a UI-only deployment.
    const hasTelegram = !!(this.telegramApi && this.telegramChatId);
    const stateDir = join(this.env.ctxRoot, 'state', this.name);

    // If agent has a heartbeat but no .onboarded marker, they completed onboarding but
    // forgot to write the marker. Auto-write it so they don't re-onboard next restart.
    if (!existsSync(onboardedPath) && existsSync(heartbeatPath)) {
      try {
        const { writeFileSync } = require('fs');
        writeFileSync(onboardedPath, '', 'utf-8');
      } catch { /* ignore */ }
    }

    if (!existsSync(onboardedPath) && existsSync(onboardingPath)) {
      onboardingAppend = hasTelegram
        ? ' IMPORTANT: This is your FIRST BOOT. Before doing anything else, read ONBOARDING.md and complete the onboarding protocol.'
        : ` IMPORTANT: This is your FIRST BOOT in a UI-ONLY deployment — Telegram is NOT configured. Do NOT run any send-telegram or *-telegram commands, and do NOT wait for Telegram input. Read AGENTS.md and ONBOARDING.md for context but SKIP every Telegram step. Your identity is already set in IDENTITY.md — do not re-ask it. Read the org context.json and goals.json for configuration. Then SELF-COMPLETE onboarding non-interactively: (1) write your first heartbeat exactly as described in HEARTBEAT.md; (2) mark onboarding complete by running this Bash command verbatim: mkdir -p "${stateDir}" && touch "${onboardedPath}" ; then begin normal operations. You are driven by your inbox and the dashboard Tasks board, not Telegram.`;
    }

    // Rate-limit recovery: if .rate-limited marker exists, prepend context
    const rateLimitMarker = join(this.env.ctxRoot, 'state', this.name, '.rate-limited');
    let rateLimitBlock = '';
    if (existsSync(rateLimitMarker)) {
      rateLimitBlock = ' RATE-LIMIT RECOVERY: Your previous session was paused due to API rate limiting. Resume normal operations but be mindful of request volume.';
      try {
        const { unlinkSync } = require('fs');
        unlinkSync(rateLimitMarker);
      } catch { /* ignore */ }
    }

    const nowUtc = new Date().toISOString();
    const reminderBlock = this.buildReminderBlock();
    const deliverablesBlock = this.buildDeliverablesBlock();
    const handoffBlock = this.consumeHandoffBlock();
    const isHandoffRestart = handoffBlock.length > 0;
    const isSilentRestart = this.consumeSilentRestartMarker();
    // HANDOFF UX: the pickup message MUST be the first action after reading the handoff doc —
    // before cron restoration, before heartbeat, before anything else. Placing this instruction
    // immediately after the handoffBlock in the prompt ensures it is not buried.
    // Dedup guard: if a "back —" message was already sent within the last 30 minutes (i.e., a
    // rapid cascade restart just happened), skip the send-telegram step to avoid a duplicate.
    const recentBackSent = isHandoffRestart && this.checkRecentBackMessage();
    const handoffUxOverride = isHandoffRestart
      ? recentBackSent
        ? ' HANDOFF UX: This is a context handoff restart — your memory is intact via the handoff doc. A "back —" pickup message was already sent within the last 30 minutes — skip the send-telegram step entirely and resume work directly.'
        : ' HANDOFF UX: This is a context handoff restart — your memory is intact via the handoff doc. CRITICAL: After reading the handoff document, your VERY FIRST tool call MUST be a Bash call running: cortextos bus send-telegram $CTX_TELEGRAM_CHAT_ID \'back — [what you were just working on]\' — replace the brackets with one brief plain-English sentence about your current state. Do this BEFORE restoring crons, BEFORE running heartbeat, BEFORE any other tool call. No cron IDs, no status report, no cold-boot phrasing. Do NOT send "Booting up... one moment" (skip AGENTS.md step 1 entirely).'
      : '';
    // SILENT AUTO-RESET UX: Tier 0 context auto-reset fires silently by design.
    // The agent should pick up work without any Telegram noise (no boot message,
    // no "back online" message). Crons, inbox, and memory still get restored.
    const silentUxOverride = isSilentRestart && !isHandoffRestart
      ? ' SILENT AUTO-RESET: This session was automatically reset by the daemon at the configured ctx_autoreset_threshold. Do NOT send any Telegram messages about booting, being back online, or restarting — the reset is internal and the user did not ask for it. Skip AGENTS.md step 1 (boot message) and step 14 (online status message) entirely. Restore crons, check inbox, pick up the highest-priority task silently.'
      : '';
    const onlineMessage = isHandoffRestart || isSilentRestart || !hasTelegram
      ? ''
      : ' After setting up crons, send a Telegram message to the user saying you are back online.';
    return `You are starting a new session. Current UTC time: ${nowUtc}.${rateLimitBlock} Read AGENTS.md and all bootstrap files listed there. Then restore your crons from config.json: CRITICAL DEDUP: Always call CronList BEFORE creating any cron. Also run 'cortextos bus list-crons $CTX_AGENT_NAME' to check daemon-managed crons. For each config.json entry, search BOTH the CronList output AND the bus list-crons output for its prompt text — if the prompt already appears in either, SKIP that cron entirely. For entries NOT already listed: for each entry with type "recurring" (or no type field), call CronCreate directly (do NOT use /loop — /loop will prompt the user about cloud scheduling which blocks boot in autonomous mode). Convert the interval to a cron expression: 1h→"0 */1 * * *", 2h→"0 */2 * * *", 4h→"0 */4 * * *", 6h→"0 */6 * * *", 12h→"0 */12 * * *", 24h→"0 0 * * *", Nm→"*/N * * * *". Pass recurring:true. For entries with type "once": compare fire_at against the current UTC time — if fire_at is in the future call CronCreate (one-shot, no recurring flag), if in the past delete that entry from config.json.${reminderBlock}${deliverablesBlock}${handoffBlock}${handoffUxOverride}${silentUxOverride}${onlineMessage}${onboardingAppend}`;
  }

  private buildContinuePrompt(): string {
    const nowUtc = new Date().toISOString();
    const reminderBlock = this.buildReminderBlock();
    const deliverablesBlock = this.buildDeliverablesBlock();
    const hasTelegram = !!(this.telegramApi && this.telegramChatId);
    const onlineNote = hasTelegram
      ? ' After restoring crons and checking inbox, send a Telegram message to the user saying you are back online.'
      : ' Telegram is not configured (UI-only) — do NOT run any send-telegram commands.';
    return `SESSION CONTINUATION: Your CLI process was restarted with --continue to reload configs. Current UTC time: ${nowUtc}. Your full conversation history is preserved. Re-read AGENTS.md and ALL bootstrap files listed there. Restore your crons from config.json ONLY if missing. CRITICAL DEDUP: Call CronList FIRST AND run 'cortextos bus list-crons $CTX_AGENT_NAME'. For each config.json entry, search BOTH the CronList output AND the bus list-crons output for its prompt text — if the prompt already appears in either, SKIP that cron. For entries NOT already listed: use CronCreate directly (do NOT use /loop — /loop will prompt about cloud scheduling which blocks autonomous boot). Convert interval to cron expression: 1h→"0 */1 * * *", 6h→"0 */6 * * *", 24h→"0 0 * * *", Nm→"*/N * * * *". Pass recurring:true for recurring entries, no recurring flag for once entries (only if fire_at is in the future). Rapid --continue restarts must not accumulate duplicates.${reminderBlock}${deliverablesBlock} Check inbox. Resume normal operations.${onlineNote}`;
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

  /**
   * Consume the .handoff-doc-path marker (written by the context watchdog or the
   * agent itself via `cortextos bus hard-restart --handoff-doc <path>`).
   * Returns a boot-prompt fragment pointing the new session at the handoff doc,
   * or an empty string if no marker exists.
   * The marker is unlinked after reading so it fires only once per restart.
   *
   * Fallback: if no marker exists, scan the agent's memory/handoffs/ directory
   * for any handoff doc written within the last hour and inject the most recent.
   */
  private consumeHandoffBlock(): string {
    const markerPath = join(this.env.ctxRoot, 'state', this.name, '.handoff-doc-path');

    // Primary path: explicit marker written by hard-restart or watchdog
    if (existsSync(markerPath)) {
      try {
        const { unlinkSync } = require('fs');
        const docPath = readFileSync(markerPath, 'utf-8').trim();
        unlinkSync(markerPath);
        if (docPath && existsSync(docPath)) {
          return ` CONTEXT HANDOFF: Before restoring crons or checking inbox, read the handoff document at ${docPath} to resume your prior session state.`;
        }
      } catch {
        // fall through to auto-scan
      }
    }

    // Fallback: auto-scan memory/handoffs/ for a recent (< 1 hour old) handoff doc
    try {
      const { readdirSync, statSync } = require('fs');
      const handoffsDir = join(this.env.agentDir, 'memory', 'handoffs');
      if (!existsSync(handoffsDir)) return '';
      const oneHourAgo = Date.now() - 60 * 60_000;
      const candidates = readdirSync(handoffsDir)
        .filter((f: string) => f.startsWith('handoff-') && f.endsWith('.md'))
        .map((f: string) => ({ name: f, path: join(handoffsDir, f), mtime: statSync(join(handoffsDir, f)).mtimeMs }))
        .filter((f: { name: string; path: string; mtime: number }) => f.mtime >= oneHourAgo)
        .sort((a: { mtime: number }, b: { mtime: number }) => b.mtime - a.mtime);
      if (candidates.length === 0) return '';
      const docPath = candidates[0].path;
      return ` CONTEXT HANDOFF (auto-detected): Before restoring crons or checking inbox, read the handoff document at ${docPath} to resume your prior session state.`;
    } catch {
      return '';
    }
  }

  /**
   * Check whether a "back —" Telegram pickup message was sent within the last
   * 30 minutes. Used to suppress the handoff-boot send-telegram instruction on
   * rapid cascade restarts where the previous session already sent the message.
   */
  private checkRecentBackMessage(): boolean {
    const outboundPath = join(this.env.ctxRoot, 'logs', this.name, 'outbound-messages.jsonl');
    if (!existsSync(outboundPath)) return false;
    try {
      const thirtyMinAgo = Date.now() - 30 * 60_000;
      const raw = readFileSync(outboundPath, 'utf-8').trim();
      if (!raw) return false;
      const lines = raw.split('\n').filter(Boolean);
      // Only scan the tail — "back —" messages live at the end
      for (const line of lines.slice(-30)) {
        try {
          const entry = JSON.parse(line);
          const ts = new Date(entry.timestamp || entry.archived_at || 0).getTime();
          if (ts >= thirtyMinAgo && (entry.text || '').startsWith('back —')) {
            return true;
          }
        } catch { /* skip malformed lines */ }
      }
    } catch { /* non-fatal — if unreadable, allow the message */ }
    return false;
  }

  /**
   * Consume the `.silent-restart` marker (written by the FastChecker Tier 0
   * auto-reset or the `cortextos bus auto-compact-agent` manual hatch).
   * Returns true when the marker was present — signaling the boot prompt
   * builder to suppress the "booting" and "back online" Telegram messages.
   * Unlinks the marker so the effect lasts exactly one restart.
   */
  private consumeSilentRestartMarker(): boolean {
    const markerPath = join(this.env.ctxRoot, 'state', this.name, '.silent-restart');
    if (!existsSync(markerPath)) return false;
    try {
      const { unlinkSync } = require('fs');
      unlinkSync(markerPath);
    } catch { /* ignore — we still treat it as silent */ }
    return true;
  }

  private startSessionTimer(): void {
    const DEFAULT_MAX_SESSION_S = 255600;
    // Node setTimeout uses int32 ms internally. Values > 2^31-1 (~24.8d) silently
    // coerce to 1ms, which combined with the BUG-048 reschedule loop below causes
    // an infinite tight loop. Clamp at the call site so any future misconfigured
    // max_session_seconds (e.g. a stray 3600000s = 1000h) cannot wedge the daemon.
    const MAX_SETTIMEOUT_MS = 2_147_483_647;
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
      }, Math.min(delayMs, MAX_SETTIMEOUT_MS));
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
   * Write a rotation event to the orch_rotation_events Supabase table.
   *
   * Fail-open: all errors are swallowed. This must NEVER block a restart.
   * Called fire-and-forget from sessionRefresh() and handleExit().
   */
  /**
   * Read Supabase credentials and resolve the agent's UUID from orch_agents.
   * Returns [url, key, agentUuid] or null if any step fails.
   * Shared by writeRotationEvent() and updateRotationResumeSuccess().
   */
  private async resolveSupabaseAgent(): Promise<[string, string, string] | null> {
    const envFile = join(this.env.agentDir, '.env');
    if (!existsSync(envFile)) return null;
    const envContent = readFileSync(envFile, 'utf-8');
    const url = envContent.match(/^SUPABASE_RGOS_URL=(.+)$/m)?.[1]?.trim();
    const key = envContent.match(/^SUPABASE_RGOS_SERVICE_KEY=(.+)$/m)?.[1]?.trim();
    if (!url || !key) return null;

    const lookupRes = await fetch(
      `${url}/rest/v1/orch_agents?select=id&title=ilike.${encodeURIComponent(this.name)}&limit=1`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } },
    );
    if (!lookupRes.ok) return null;
    const rows = (await lookupRes.json()) as Array<{ id: string }>;
    const agentId = rows[0]?.id;
    if (!agentId) return null;
    return [url, key, agentId];
  }

  private async writeRotationEvent(rotationType: string, reason: string): Promise<void> {
    try {
      const resolved = await this.resolveSupabaseAgent();
      if (!resolved) return;
      const [url, key, agentId] = resolved;

      // Compute session duration
      const sessionDurationMs = this.sessionStart
        ? Date.now() - this.sessionStart.getTime()
        : null;

      // Read context usage % from context_status.json if available
      let contextUsagePct: number | null = null;
      try {
        const statusPath = join(this.env.ctxRoot, 'state', this.name, 'context_status.json');
        if (existsSync(statusPath)) {
          const data = JSON.parse(readFileSync(statusPath, 'utf-8'));
          if (typeof data.used_percentage === 'number') {
            contextUsagePct = data.used_percentage;
          }
        }
      } catch { /* non-fatal */ }

      // Write to orch_rotation_events
      await fetch(`${url}/rest/v1/orch_rotation_events`, {
        method: 'POST',
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({
          agent_id: agentId,
          notes: JSON.stringify({
            rotation_type: rotationType,
            reason,
            session_duration_ms: sessionDurationMs,
            context_usage_pct: contextUsagePct,
          }),
        }),
      });
    } catch {
      /* swallow — must never break crash recovery */
    }
  }

  /**
   * Mark the most recent rotation event for this agent as successfully resumed.
   * Called after start() completes in sessionRefresh() and crash recovery.
   * Fail-open: all errors are swallowed — this must NEVER block a restart.
   */
  private async updateRotationResumeSuccess(): Promise<void> {
    try {
      const resolved = await this.resolveSupabaseAgent();
      if (!resolved) return;
      const [url, key, agentId] = resolved;

      // Find the most recent rotation event for this agent that has not yet been
      // marked as resumed (resume_success IS NULL = inserted by writeRotationEvent).
      const selectRes = await fetch(
        `${url}/rest/v1/orch_rotation_events?agent_id=eq.${agentId}&resume_success=is.null&order=rotation_at.desc&limit=1&select=id`,
        { headers: { apikey: key, Authorization: `Bearer ${key}` } },
      );
      if (!selectRes.ok) return;
      const rows = (await selectRes.json()) as Array<{ id: string }>;
      const eventId = rows[0]?.id;
      if (!eventId) return;

      // Mark it resumed
      await fetch(
        `${url}/rest/v1/orch_rotation_events?id=eq.${eventId}`,
        {
          method: 'PATCH',
          headers: {
            apikey: key,
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal',
          },
          body: JSON.stringify({
            resume_success: true,
            resume_at: new Date().toISOString(),
          }),
        },
      );
    } catch {
      /* swallow — must never break restart */
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
    kind: 'CRASH' | 'HALTED' | 'CRASH_LOOP' | 'PREMATURE_EXIT' | 'PREMATURE_EXIT_LOOP',
  ): void {
    try {
      const logDir = join(this.env.ctxRoot, 'logs', this.name);
      ensureDir(logDir);
      const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      let details: string;
      if (kind === 'HALTED') {
        details = `exit_code=${exitCode} crash_count=${this.crashCount} max_crashes=${this.maxCrashesPerDay}`;
      } else if (kind === 'PREMATURE_EXIT' || kind === 'PREMATURE_EXIT_LOOP') {
        // Premature exits are tracked in their own counter and do NOT touch
        // crashCount. Log the premature-exit counter instead so the file
        // tells a coherent story.
        details =
          `exit_code=${exitCode} premature_exits=${this.prematureExitTimestamps.length}` +
          ` window_s=${this.prematureExitWindowMs / 1000} backoff_s=${backoffMs / 1000}`;
      } else {
        details = `exit_code=${exitCode} crash_count=${this.crashCount} backoff_s=${backoffMs / 1000}`;
      }
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
      atomicWriteSync(crashFile, `${today}:${this.crashCount}`);
    } catch { /* ignore */ }
  }

  private notifyStatusChange(): void {
    if (this.onStatusChange) {
      this.onStatusChange(this.getStatus());
    }
  }

  /**
   * Reset the daily crash counter to zero and delete the persisted crash count
   * state file. Called by AgentManager after a health-triggered or
   * stale-heartbeat restart so the restarted agent is not penalised for
   * pre-restart crashes in the same day.
   */
  public resetCrashCount(): void {
    this.crashCount = 0;
    const crashFile = join(this.env.ctxRoot, 'logs', this.name, '.crash_count_today');
    try {
      if (existsSync(crashFile)) {
        unlinkSync(crashFile);
      }
    } catch { /* non-fatal — file may not exist */ }
  }

}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * How long to wait for a graceful (SIGTERM) exit after the /exit dance before
 * escalating to SIGKILL on a wedged child (#202). The full graceful path
 * (Ctrl-C + /exit + 5s) has already run by the time we get here.
 */
const HARD_KILL_GRACE_MS = 8000;

/** Max spawn attempts before declaring SPAWN-FAILED (gen-B spawn-verify). */
const MAX_SPAWN_ATTEMPTS = 3;
/** Base backoff between spawn retries (×2^(attempt-1) → 1s, 2s). */
const SPAWN_RETRY_BASE_MS = 1000;

/** True if `pid` is a live process. `process.kill(pid, 0)` only probes. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Collect all descendant pids of `pid` (children, grandchildren, …) by ppid.
 * Walks one `ps -axo pid,ppid` snapshot in-process (a single subprocess, not N
 * recursive pgreps) and follows the ppid tree. Used to reap own-process-group
 * children that a leader-group SIGKILL misses (#202): they are still ppid-
 * descendants of the leader until it dies, so a snapshot taken before the kill
 * captures them. Best-effort — returns [] if `ps` is unavailable.
 */
export function collectDescendants(pid: number): number[] {
  let rows: Array<[number, number]>;
  try {
    const out = execSync('ps -axo pid=,ppid=', { encoding: 'utf8' });
    rows = out.trim().split('\n')
      .map(l => l.trim().split(/\s+/).map(Number))
      .filter((r): r is [number, number] => r.length === 2 && r.every(n => Number.isInteger(n) && n > 0));
  } catch {
    return [];
  }
  const childrenOf = new Map<number, number[]>();
  for (const [p, pp] of rows) {
    const arr = childrenOf.get(pp);
    if (arr) arr.push(p); else childrenOf.set(pp, [p]);
  }
  const descendants: number[] = [];
  const stack = [pid];
  const seen = new Set<number>();
  while (stack.length) {
    const cur = stack.pop()!;
    for (const k of childrenOf.get(cur) ?? []) {
      if (seen.has(k)) continue; // guard against any cyclic ppid weirdness
      seen.add(k);
      descendants.push(k);
      stack.push(k);
    }
  }
  return descendants;
}

/**
 * Hard-kill a wedged PTY child AND its descendants (#202). node-pty spawns the
 * child as a session/group leader, so signalling the negative pid targets the
 * whole process group — this reaps grandchildren that a bare `kill(pid)` would
 * orphan (orphaned descendants are exactly the OS resource exhaustion this whole
 * class produced). Falls back to the single pid if the group signal is rejected
 * (e.g. the leader already reaped its group).
 */
export function hardKillProcessGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone between the liveness check and here — nothing to do.
    }
  }
}

/**
 * Classify a spawn failure into a coarse CLASS for fleet-wide alert dedup.
 * posix_spawnp / EAGAIN / ENOMEM all mean OS process/resource exhaustion — the
 * gen-B cause — and should collapse into one operator alert. Unknown errors
 * get a generic class so they still dedup per-class.
 */
export function classifySpawnFailure(err: unknown): string {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (msg.includes('posix_spawnp') || msg.includes('eagain') || msg.includes('enomem') || msg.includes('resource temporarily unavailable')) {
    return 'posix_spawnp';
  }
  if (msg.includes('no live process')) {
    // Our own verification failure — node-pty returned a corpse (the classic
    // gen-B shape); treat as the exhaustion class so it dedups with it.
    return 'posix_spawnp';
  }
  if (msg.includes('enoent')) return 'ENOENT';
  return 'spawn-error';
}
