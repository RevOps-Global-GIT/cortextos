import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { AgentConfig, AgentStatus, CtxEnv } from '../types/index.js';
import { AgentPTY } from '../pty/agent-pty.js';
import { MessageDedup, injectMessage } from '../pty/inject.js';
import { ensureDir } from '../utils/atomic.js';
import { writeCortextosEnv } from '../utils/env.js';

type LogFn = (msg: string) => void;

/**
 * Manages a single agent's lifecycle.
 * Replaces agent-wrapper.sh for one agent.
 */
export class AgentProcess {
  readonly name: string;
  private env: CtxEnv;
  private config: AgentConfig;
  private pty: AgentPTY | null = null;
  private sessionTimer: ReturnType<typeof setTimeout> | null = null;
  private crashCount: number = 0;
  private maxCrashesPerDay: number = 10;
  private sessionStart: Date | null = null;
  private status: AgentStatus['status'] = 'stopped';
  private dedup: MessageDedup;
  private log: LogFn;
  private onStatusChange: ((status: AgentStatus) => void) | null = null;

  constructor(name: string, env: CtxEnv, config: AgentConfig, log?: LogFn) {
    this.name = name;
    this.env = env;
    this.config = config;
    if (config.max_crashes_per_day !== undefined) {
      this.maxCrashesPerDay = config.max_crashes_per_day;
    }
    this.dedup = new MessageDedup();
    this.log = log || ((msg) => console.log(`[${name}] ${msg}`));
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
    const prompt = mode === 'fresh'
      ? this.buildStartupPrompt()
      : this.buildContinuePrompt();

    this.log(`Starting in ${mode} mode`);
    this.status = 'starting';

    // Create PTY
    const logPath = join(this.env.ctxRoot, 'logs', this.name, 'stdout.log');
    ensureDir(join(this.env.ctxRoot, 'logs', this.name));
    this.log(`Log path: ${logPath}`);
    this.pty = new AgentPTY(this.env, this.config, logPath);

    // Handle exit
    this.pty.onExit((exitCode, signal) => {
      this.log(`Exited with code ${exitCode} signal ${signal}`);
      this.handleExit(exitCode);
    });

    try {
      await this.pty.spawn(mode, prompt);
      this.status = 'running';
      this.sessionStart = new Date();
      this.log(`Running (pid: ${this.pty.getPid()})`);

      // Start session timer
      this.startSessionTimer();

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
    this.log('Stopping...');
    this.clearSessionTimer();

    if (this.pty) {
      // Send graceful shutdown message
      try {
        this.pty.write('\x03'); // Ctrl-C
        await sleep(1000);
        this.pty.write('/exit\r');
        await sleep(3000);
      } catch {
        // Ignore write errors during shutdown
      }
      this.pty.kill();
      this.pty = null;
    }

    this.status = 'stopped';
    this.notifyStatusChange();
    this.log('Stopped');
  }

  /**
   * Restart with --continue (session refresh).
   */
  async sessionRefresh(): Promise<void> {
    this.log('Session refresh (--continue restart)');
    this.clearSessionTimer();

    if (this.pty) {
      try {
        this.pty.write('\x03'); // Ctrl-C
        await sleep(1000);
        this.pty.write('/exit\r');
        await sleep(3000);
      } catch {
        // Ignore
      }
      this.pty.kill();
      this.pty = null;
    }

    // Relaunch with continue mode
    const logPath = join(this.env.ctxRoot, 'logs', this.name, 'stdout.log');
    this.pty = new AgentPTY(this.env, this.config, logPath);

    this.pty.onExit((exitCode) => {
      this.handleExit(exitCode);
    });

    const prompt = this.buildContinuePrompt();
    await this.pty.spawn('continue', prompt);
    this.startSessionTimer();
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
    this.pty = null;
    this.clearSessionTimer();

    // Check crash limit
    this.crashCount++;
    const today = new Date().toISOString().split('T')[0];
    this.resetCrashCountIfNewDay(today);

    if (this.crashCount >= this.maxCrashesPerDay) {
      this.log(`HALTED: exceeded ${this.maxCrashesPerDay} crashes today`);
      this.status = 'halted';
      this.notifyStatusChange();
      return;
    }

    // Exponential backoff restart
    const backoff = Math.min(5000 * Math.pow(2, this.crashCount - 1), 300000);
    this.log(`Crash recovery: restart in ${backoff / 1000}s (crash #${this.crashCount})`);
    this.status = 'crashed';
    this.notifyStatusChange();

    setTimeout(() => {
      if (this.status === 'crashed') {
        this.start().catch(err => this.log(`Restart failed: ${err}`));
      }
    }, backoff);
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

    // Claude projects dir uses the absolute path with all slashes replaced by dashes
    // e.g. /Users/foo/agents/boss -> -Users-foo-agents-boss (leading slash becomes -)
    const convDir = join(
      process.env.HOME || '',
      '.claude',
      'projects',
      launchDir.replace(/\//g, '-'),
    );

    try {
      const files = require('fs').readdirSync(convDir);
      return files.some((f: string) => f.endsWith('.jsonl'));
    } catch {
      return false;
    }
  }

  private buildStartupPrompt(): string {
    const onboardedPath = join(this.env.ctxRoot, 'state', this.name, '.onboarded');
    const onboardingPath = join(this.env.agentDir, 'ONBOARDING.md');
    const heartbeatPath = join(this.env.ctxRoot, 'state', this.name, 'heartbeat.json');
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

    return `You are starting a new session. Read AGENTS.md and all bootstrap files listed there. Then read config.json and set up your crons using /loop for each entry in the crons array. After setting up crons, send a Telegram message to the user saying you are back online.${onboardingAppend}`;
  }

  private buildContinuePrompt(): string {
    return 'SESSION CONTINUATION: Your CLI process was restarted with --continue to reload configs. Your full conversation history is preserved. Re-read AGENTS.md and ALL bootstrap files listed there. Set up your crons from config.json using /loop. Check inbox. Resume normal operations.';
  }

  private startSessionTimer(): void {
    const maxSession = (this.config.max_session_seconds || 255600) * 1000;
    this.sessionTimer = setTimeout(() => {
      this.log(`Session timer fired after ${maxSession / 1000}s`);
      this.sessionRefresh().catch(err => this.log(`Session refresh failed: ${err}`));
    }, maxSession);
  }

  private clearSessionTimer(): void {
    if (this.sessionTimer) {
      clearTimeout(this.sessionTimer);
      this.sessionTimer = null;
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
