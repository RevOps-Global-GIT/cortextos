/**
 * computer-use — bus command that dispatches a prompt to Codex on Greg's Mac
 * via SSH and the codex-dispatch.sh script, which runs Codex non-interactively
 * with the @Computer Use plugin.
 *
 * Usage (CLI):
 *   cortextos bus computer-use "take a screenshot and describe what you see"
 *   cortextos bus computer-use --no-plugin "just a regular Codex task"
 *   cortextos bus computer-use --workdir /path/to/repo "refactor this file"
 *   cortextos bus computer-use --timeout 120 "slow task"
 *
 * How it works:
 *   1. SSH to Greg's Mac (gregs-mac / 100.84.86.6 via Tailscale)
 *   2. Run ~/work/team-brain/scripts/codex-dispatch.sh with the prompt
 *   3. codex-dispatch.sh invokes `codex exec` with the Computer Use plugin
 *      reference ([@Computer Use](plugin://computer-use@openai-bundled))
 *   4. Codex runs the task non-interactively and writes the last message to stdout
 *   5. The result is returned and logged as a computer_use_task event
 *
 * Notes on Computer Use via SSH:
 *   Screen-capture and mouse tools require a macOS display session. When invoked
 *   over SSH, those specific calls fail gracefully and Codex falls back to shell
 *   commands. For most useful tasks (file ops, code, app control via shell) this
 *   works fine. Tasks needing actual screen pixels must be run in the Mac's GUI
 *   session (future: launchd wrapper).
 */

import { execFileSync } from 'child_process';

export interface ComputerUseOptions {
  /** Skip the @Computer Use plugin prefix — send a plain Codex prompt */
  noPlugin?: boolean;
  /** Working directory for Codex on the Mac */
  workdir?: string;
  /** Timeout in seconds (default: 300) */
  timeout?: number;
  /** SSH host (default: gregs-mac) */
  sshHost?: string;
  /** Path to codex-dispatch.sh on the Mac */
  dispatchScript?: string;
}

export interface ComputerUseResult {
  ok: boolean;
  output?: string;
  error?: string;
  durationMs: number;
}

const DEFAULT_SSH_HOST = 'gregs-mac';
const DEFAULT_DISPATCH_SCRIPT = '/Users/gregharned/work/team-brain/scripts/codex-dispatch.sh';

export async function computerUse(
  prompt: string,
  opts: ComputerUseOptions = {},
): Promise<ComputerUseResult> {
  const sshHost = opts.sshHost ?? DEFAULT_SSH_HOST;
  const dispatchScript = opts.dispatchScript ?? DEFAULT_DISPATCH_SCRIPT;
  const timeoutSec = opts.timeout ?? 300;
  const start = Date.now();

  // Build codex-dispatch.sh args
  const dispatchArgs: string[] = [dispatchScript];
  if (opts.noPlugin) dispatchArgs.push('--no-plugin');
  if (opts.workdir) dispatchArgs.push('--workdir', opts.workdir);
  dispatchArgs.push('--timeout', String(timeoutSec));
  dispatchArgs.push(prompt);

  // SSH command — single quoted args to avoid shell interpretation
  const sshArgs = [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ConnectTimeout=10',
    sshHost,
    ...dispatchArgs,
  ];

  try {
    const output = execFileSync('ssh', sshArgs, {
      timeout: (timeoutSec + 30) * 1000, // extra 30s for SSH overhead
      encoding: 'utf-8',
    });

    return {
      ok: true,
      output: output.trim(),
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: msg,
      durationMs: Date.now() - start,
    };
  }
}
