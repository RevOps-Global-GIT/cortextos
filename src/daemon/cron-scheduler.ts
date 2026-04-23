/**
 * Daemon-side cron scheduler.
 *
 * Owns timing for every agent's recurring and one-shot crons so Claude Code's
 * in-session CronCreate state never needs to be rebuilt on a hard-restart.
 * On each tick the daemon evaluates every attached agent's schedule and
 * injects the cron prompt into the agent's PTY when it is due. Claude receives
 * the injected message the same way it receives any other inbox item — zero
 * tool calls, zero context burned on cron restoration.
 *
 * Sources of truth:
 *   - config.json `crons[]`                  — static cron specs per agent
 *   - state/<agent>/cron-state.json          — last_fire timestamps (persists)
 *
 * Fire flow (per tick):
 *   1. Skip agents with stale lifecycle generations or not-running state
 *   2. For each cron where now >= nextFireAt:
 *      a. If agent not idle → defer up to MAX_DEFER_MS, then force-inject
 *      b. Inject prompt via ManagedAgent.inject
 *      c. updateCronFire() → advance nextFireAt (or remove if once-type)
 *
 * Hot reload:
 *   - fs.watch on each agent's config.json
 *   - On change, rebuild schedule for that agent (preserving last_fire)
 *
 * Crash recovery:
 *   - Scheduler state is fully derived from disk on every attach/reload
 *   - Daemon restart → re-attach → overdue interval crons fire on next tick
 *     (cron-expression catch-up is intentionally NOT implemented — time-anchored
 *     fires like "0 7 * * *" are evaluated from max(last_fire, now) so we never
 *     stampede missed fires after a long outage)
 */

import { readFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { watch as chokidarWatch, type FSWatcher as ChokidarFSWatcher } from 'chokidar';
import { CronExpressionParser } from 'cron-parser';
import type { AgentConfig, CronEntry } from '../types/index.js';
import { readCronState, updateCronFire, parseDurationMs } from '../bus/cron-state.js';

export type LogFn = (msg: string) => void;

/**
 * Minimal interface the scheduler needs from an agent. AgentProcess implements
 * this in Phase 2; tests implement it with a fake.
 */
export interface ManagedAgent {
  readonly name: string;
  /** Absolute path to `state/<name>/` (holds cron-state.json, last_idle.flag, ...) */
  readonly stateDir: string;
  /** Absolute path to the agent's config.json (for hot reload). */
  readonly configPath: string;
  /** IANA timezone for cron expression evaluation. Undefined → UTC. */
  readonly timezone?: string;
  /** Monotonic lifecycle generation. Bumped on every AgentProcess.start(). */
  readonly generation: number;
  /** True when the PTY is up and writable. */
  isRunning(): boolean;
  /** True when the agent has finished its boot turn and is between messages. */
  isIdle(): boolean;
  /** Inject a prompt. Returns false if the write failed. */
  inject(message: string): boolean;
}

interface ScheduledCron {
  entry: CronEntry;
  /** Epoch ms at which this cron is next due. */
  nextFireAt: number;
  /** When the scheduler first saw the cron due but the agent was busy. */
  deferStart: number | null;
}

interface AgentSchedule {
  agent: ManagedAgent;
  crons: ScheduledCron[];
  watcher: ChokidarFSWatcher | null;
  attachedGeneration: number;
}

const DEFAULT_TICK_MS = 30_000;
const DEFAULT_MAX_DEFER_MS = 15 * 60_000;

export interface CronSchedulerOptions {
  /** Tick interval in ms (default 30_000). */
  tickMs?: number;
  /** Max time a busy agent can defer a cron before force-injection (default 15m). */
  maxDeferMs?: number;
  /** Injected logger (defaults to console). */
  log?: LogFn;
  /** Injected clock for tests. */
  now?: () => number;
}

export class CronScheduler {
  private readonly agents = new Map<string, AgentSchedule>();
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private readonly tickMs: number;
  private readonly maxDeferMs: number;
  private readonly log: LogFn;
  private readonly now: () => number;

  constructor(opts: CronSchedulerOptions = {}) {
    this.tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
    this.maxDeferMs = opts.maxDeferMs ?? DEFAULT_MAX_DEFER_MS;
    this.log = opts.log ?? ((m) => console.log(`[cron-sched] ${m}`));
    this.now = opts.now ?? (() => Date.now());
  }

  /** Begin the background tick loop. Idempotent. */
  start(): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => this.tick(), this.tickMs);
    // Don't keep the event loop alive just for the scheduler — the daemon
    // process owns lifecycle through its own signal handlers.
    this.tickTimer.unref?.();
    this.log(`Started (tick=${this.tickMs}ms, maxDefer=${this.maxDeferMs}ms)`);
  }

  /** Stop ticking and release all watchers. */
  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    for (const sched of this.agents.values()) {
      sched.watcher?.close();
    }
    this.agents.clear();
    this.log('Stopped');
  }

  /**
   * Register an agent. Idempotent — re-attaching with a fresh generation
   * replaces the previous schedule without losing last_fire records (those
   * live in cron-state.json on disk).
   */
  attachAgent(agent: ManagedAgent): void {
    this.detachAgent(agent.name);

    const config = this.loadConfig(agent.configPath);
    const crons = this.buildSchedule(agent, config);

    // chokidar with polling avoids the inotify max_user_instances cap that
    // fs.watch was hitting on this host. Config.json changes are rare so a
    // 5s poll is more than fast enough.
    let watcher: ChokidarFSWatcher | null = null;
    try {
      watcher = chokidarWatch(agent.configPath, {
        persistent: false,
        usePolling: true,
        interval: 5_000,
        awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
      });
      watcher.on('change', () => this.reload(agent.name));
      watcher.on('error', (err) => this.log(`[${agent.name}] config watch error: ${err}`));
    } catch (err) {
      this.log(`[${agent.name}] config.json watch failed: ${err}`);
      watcher = null;
    }

    this.agents.set(agent.name, {
      agent,
      crons,
      watcher,
      attachedGeneration: agent.generation,
    });

    this.log(`[${agent.name}] attached (${crons.length} crons, gen=${agent.generation})`);
  }

  /** Unregister an agent (on AgentProcess.stop()). Safe to call on unknown names. */
  detachAgent(name: string): void {
    const sched = this.agents.get(name);
    if (!sched) return;
    sched.watcher?.close();
    this.agents.delete(name);
    this.log(`[${name}] detached`);
  }

  /**
   * Rebuild an agent's schedule from the current config.json. Called on file
   * change and by `bus add-cron`/`bus remove-cron`. Preserves last_fire via
   * cron-state.json so a reload never double-fires or resets timers.
   */
  reload(name: string): void {
    const sched = this.agents.get(name);
    if (!sched) return;
    const config = this.loadConfig(sched.agent.configPath);
    sched.crons = this.buildSchedule(sched.agent, config);
    this.log(`[${name}] schedule reloaded (${sched.crons.length} crons)`);
  }

  /**
   * Run one scheduling pass. Public for tests; the tick timer calls it as well.
   */
  tick(): void {
    const now = this.now();

    for (const sched of this.agents.values()) {
      // A new AgentProcess lifecycle (fresh session after hard-restart) is
      // expected to call attachAgent() on start(). If the current generation
      // ran ahead of the attached one without a re-attach, ignore the agent
      // until re-attachment arrives.
      if (sched.agent.generation !== sched.attachedGeneration) {
        continue;
      }
      if (!sched.agent.isRunning()) continue;

      const toRemove: ScheduledCron[] = [];

      for (const cron of sched.crons) {
        if (now < cron.nextFireAt) continue;

        const agentName = sched.agent.name;

        // Idle-aware injection with bounded deferral.
        if (!sched.agent.isIdle()) {
          if (cron.deferStart === null) {
            cron.deferStart = now;
            this.log(`[${agentName}] cron "${cron.entry.name}": deferring (agent busy)`);
            continue;
          }
          if (now - cron.deferStart < this.maxDeferMs) {
            continue;
          }
          this.log(
            `[${agentName}] cron "${cron.entry.name}": force-injecting after ${Math.round((now - cron.deferStart) / 60_000)}m busy defer`,
          );
        }

        // Wake gate: if defined, evaluate before firing. Skip this tick
        // (without advancing last_fire) if the gate says wake:false.
        if (cron.entry.wake_gate && !this.evaluateWakeGate(agentName, cron.entry)) {
          cron.deferStart = null;
          continue;
        }

        // Attempt the inject. A failed write keeps nextFireAt so we retry
        // on the next tick instead of silently skipping a fire.
        const ok = sched.agent.inject(cron.entry.prompt);
        if (!ok) {
          this.log(`[${agentName}] cron "${cron.entry.name}": inject failed, retrying next tick`);
          continue;
        }

        try {
          updateCronFire(sched.agent.stateDir, cron.entry.name, cron.entry.interval);
        } catch (err) {
          this.log(`[${agentName}] cron "${cron.entry.name}": updateCronFire failed: ${err}`);
        }
        this.log(`[${agentName}] cron "${cron.entry.name}": fired`);

        cron.deferStart = null;
        if (cron.entry.type === 'once') {
          toRemove.push(cron);
        } else {
          const next = this.computeNextFire(cron.entry, now, sched.agent.timezone);
          if (isNaN(next)) {
            this.log(`[${agentName}] cron "${cron.entry.name}": next-fire computation failed, removing from schedule`);
            toRemove.push(cron);
          } else {
            cron.nextFireAt = next;
          }
        }
      }

      if (toRemove.length > 0) {
        sched.crons = sched.crons.filter((c) => !toRemove.includes(c));
      }
    }
  }

  /** Visible for tests. */
  getSchedule(name: string): ScheduledCron[] | undefined {
    return this.agents.get(name)?.crons;
  }

  /** Visible for tests. */
  hasAgent(name: string): boolean {
    return this.agents.has(name);
  }

  // ---------- internals ----------

  private loadConfig(configPath: string): AgentConfig {
    try {
      return JSON.parse(readFileSync(configPath, 'utf-8')) as AgentConfig;
    } catch (err) {
      this.log(`loadConfig failed for ${configPath}: ${err}`);
      return {};
    }
  }

  private buildSchedule(agent: ManagedAgent, config: AgentConfig): ScheduledCron[] {
    const entries = config.crons ?? [];
    if (entries.length === 0) return [];

    const seen = new Set<string>();
    const valid: CronEntry[] = [];
    for (const e of entries) {
      if (!e.name) {
        this.log(`[${agent.name}] skipping entry with missing name`);
        continue;
      }
      if (seen.has(e.name)) {
        this.log(`[${agent.name}] skipping duplicate cron name "${e.name}"`);
        continue;
      }
      if (!e.prompt) {
        this.log(`[${agent.name}] skipping cron "${e.name}" with empty prompt`);
        continue;
      }
      if (!e.interval && !e.cron && !e.fire_at) {
        this.log(`[${agent.name}] skipping cron "${e.name}" with no interval/cron/fire_at`);
        continue;
      }
      seen.add(e.name);
      valid.push(e);
    }

    const state = readCronState(agent.stateDir);
    const now = this.now();
    const scheduled: ScheduledCron[] = [];

    for (const entry of valid) {
      // Once-type: fire exactly at fire_at. Expired entries are dropped from
      // the schedule; config.json cleanup is the caller's responsibility.
      if (entry.type === 'once' || entry.fire_at) {
        if (!entry.fire_at) {
          this.log(`[${agent.name}] skipping once cron "${entry.name}" without fire_at`);
          continue;
        }
        const fireAt = Date.parse(entry.fire_at);
        if (isNaN(fireAt)) {
          this.log(`[${agent.name}] skipping once cron "${entry.name}" with invalid fire_at`);
          continue;
        }
        if (fireAt < now) {
          this.log(`[${agent.name}] once cron "${entry.name}" expired (${entry.fire_at}), dropping`);
          continue;
        }
        scheduled.push({ entry, nextFireAt: fireAt, deferStart: null });
        continue;
      }

      // Recurring: anchor on last_fire if we have one, otherwise on now.
      const lastFireRecord = state.crons.find((r) => r.name === entry.name);
      const base = lastFireRecord ? Date.parse(lastFireRecord.last_fire) : NaN;
      const nextFireAt = this.computeNextFire(
        entry,
        isNaN(base) ? now : base,
        agent.timezone,
      );
      if (isNaN(nextFireAt)) {
        this.log(`[${agent.name}] cron "${entry.name}" has no valid interval/cron, skipping`);
        continue;
      }
      scheduled.push({ entry, nextFireAt, deferStart: null });
    }

    return scheduled;
  }

  /**
   * Evaluate a wake_gate shell command. Returns true if the cron should fire,
   * false if it should be skipped this tick.
   *
   * Skip conditions (fail-open on any unexpected behaviour):
   *   - exit code 1 (explicit gate-closed signal)
   *   - exit code 0 AND stdout contains {"wake":false}
   *
   * On timeout (5s), error, or any other outcome: returns true (fire normally).
   */
  private evaluateWakeGate(agentName: string, entry: CronEntry): boolean {
    const gate = entry.wake_gate;
    if (!gate) return true;

    try {
      const result = spawnSync('sh', ['-c', gate], {
        timeout: 5_000,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // Timeout or signal: fail-open
      if (result.signal || result.error) {
        this.log(`[${agentName}] cron "${entry.name}": wake_gate error/timeout, firing anyway`);
        return true;
      }

      const stdout = (result.stdout ?? '').trim();
      const shouldSkip =
        result.status === 1 ||
        (result.status === 0 && stdout.includes('"wake":false'));

      if (shouldSkip) {
        this.log(`[${agentName}] cron "${entry.name}": wake_gate blocked fire`);
        // Best-effort activity log (non-blocking, ignore errors)
        spawnSync('cortextos', [
          'bus', 'log-event', 'cron', 'cron_skipped', 'info',
          '--meta', JSON.stringify({ name: entry.name, reason: 'wake_gate', agent: agentName }),
        ], { timeout: 3_000, stdio: 'ignore' });
        return false;
      }

      return true;
    } catch {
      // Any unexpected error: fail-open
      this.log(`[${agentName}] cron "${entry.name}": wake_gate evaluation threw, firing anyway`);
      return true;
    }
  }

  /**
   * Resolve the next fire time for a cron entry.
   * - `cron` expression wins over `interval`.
   * - Cron expressions are always evaluated from max(base, now) — we do not
   *   stampede missed time-anchored fires after an outage.
   * - Intervals fire `base + interval`, clamped to now (so overdue interval
   *   crons fire on the very next tick).
   */
  private computeNextFire(entry: CronEntry, base: number, timezone?: string): number {
    const now = this.now();

    if (entry.cron) {
      try {
        const iter = CronExpressionParser.parse(entry.cron, {
          currentDate: new Date(Math.max(base, now)),
          tz: timezone,
        });
        return iter.next().getTime();
      } catch {
        return NaN;
      }
    }

    if (entry.interval) {
      const ms = parseDurationMs(entry.interval);
      if (isNaN(ms)) return NaN;
      return Math.max(base + ms, now);
    }

    return NaN;
  }
}
