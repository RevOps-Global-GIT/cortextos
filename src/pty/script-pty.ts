/**
 * ScriptPTY — runs a Node.js script as the agent process instead of Claude Code.
 *
 * Designed for thin bridge agents (e.g. mac-codex) that need zero Claude Code
 * overhead: set config.runtime = 'script' and config.script_path = 'scripts/foo.js'.
 * The script receives all CTX_* environment variables and runs in the agent's
 * working directory. It owns its own event loop and should never exit (daemon
 * handles crash recovery and restart on unexpected exit).
 *
 * The script_path may be absolute or relative to the framework root.
 */

import { join } from 'path';
import type { AgentConfig, CtxEnv } from '../types/index.js';
import { AgentPTY } from './agent-pty.js';

export class ScriptPTY extends AgentPTY {
  private scriptAbsPath: string;

  constructor(env: CtxEnv, config: AgentConfig, logPath?: string) {
    super(env, config, logPath);
    const scriptPath = config.script_path ?? '';
    this.scriptAbsPath = scriptPath.startsWith('/')
      ? scriptPath
      : join(env.frameworkRoot, scriptPath);
  }

  protected getBinaryName(): string {
    return 'node';
  }

  protected buildClaudeArgs(_mode: 'fresh' | 'continue', _prompt: string): string[] {
    return [this.scriptAbsPath];
  }
}
