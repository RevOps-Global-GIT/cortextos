/**
 * spawn-codex — run a scoped Codex session locally and persist proof.
 *
 * This is the primitive for replacing long-running agent REPLs with bounded
 * jobs: a cron or dispatcher writes a prompt file, calls this command, records
 * the artifact + JSON sidecar, and exits.
 */

import { createHash } from 'crypto';
import { spawn, spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { basename, join, resolve } from 'path';
import {
  appendAgentLiveLog,
  createAgentLiveStateHandle,
  mirrorAgentLiveState,
  writeAgentLiveManifest,
} from './agent-live-state.js';
import { completeTask, findTaskFile, updateTask } from './task.js';
import { resolvePaths } from '../utils/paths.js';
import type { Task } from '../types/index.js';

export interface SpawnCodexOptions {
  workdir?: string;
  timeout?: number;
  agentName?: string;
  agentsRoot?: string;
  telegramChatId?: string;
  model?: string;
  effort?: string;
  mcpConfig?: string;
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  taskId?: string;
  requester?: string;
  replyTo?: string;
  priority?: string;
  // Controls whether the library auto-closes the originating bus task when
  // the run finishes. Default: true for spawnCodexAsync (the daemon path —
  // see applySpawnRunTaskLifecycle), opt-in for spawnCodex (the CLI path
  // already manages task status via bestEffortTaskStatus and we don't want
  // a double-write). Set to false to disable.
  taskAutoComplete?: boolean;
  // Optional override for the cortextOS instance id when resolving the bus
  // paths used to update the originating task. Falls back to CTX_INSTANCE_ID
  // env var, then 'default'.
  instanceId?: string;
  // Optional override for the org id when resolving the bus paths. Falls back
  // to CTX_ORG env var. When neither is set, lifecycle is skipped (no org →
  // no task dir to update).
  org?: string;
}

/**
 * Auto-close the originating bus task at the end of a scoped spawn-codex run.
 *
 * The orphan-task accumulation bug (task_1778985018875_01210010) traced to
 * the daemon's cron-fire-dispatch path: it calls `spawnCodexAsync` directly,
 * which used to leave the task in `in_progress` forever because the lifecycle
 * was only wired in the CLI shim (`bestEffortTaskStatus` in src/cli/bus.ts).
 *
 * This helper centralises the lifecycle so both paths converge:
 *   - On success: completeTask(...) records the result + artifact path,
 *     computes session cost, and closes any linked goal/loop.
 *   - On failure / timed_out: updateTask(... 'blocked') with a blocker_reason
 *     and next_proof_required, matching the schema expected by the dashboard
 *     and the `cannot transition to blocked without blocker context` guard
 *     in updateTask.
 *
 * Best-effort: every failure is swallowed. A bus-task lifecycle hiccup must
 * never break the spawn-codex run itself or its artifact persistence.
 *
 * Synthetic cron task ids of the form `cron:<agent>:<cron-name>` are markers
 * for cron metadata, not real bus tasks — we skip them (findTaskFile would
 * return null and updateTask would throw; the env doesn't need the catch).
 *
 * Caller-provided `wasAlreadyHandled` short-circuits the call so the CLI path
 * (which already flips the task to `completed`/`blocked` via updateTask
 * before this fires) doesn't get double-written.
 */
function applySpawnRunTaskLifecycle(opts: SpawnCodexOptions, metadata: SpawnCodexRunMetadata): void {
  if (opts.taskAutoComplete === false) return;
  const taskId = opts.taskId;
  if (!taskId || taskId.startsWith('cron:')) return;

  const instanceId = opts.instanceId ?? process.env.CTX_INSTANCE_ID ?? 'default';
  const org = opts.org ?? process.env.CTX_ORG;
  if (!org) return; // no org → no task dir; lifecycle has no target
  const agent = opts.agentName ?? process.env.CTX_AGENT_NAME ?? 'codex';

  let paths;
  try {
    paths = resolvePaths(agent, instanceId, org);
  } catch {
    return;
  }

  // Only act when the task actually exists on disk — synthetic / external
  // ids must not blow up the run.
  if (!findTaskFile(paths, taskId)) return;

  // Skip if the task is already in a terminal state. Otherwise re-running
  // completeTask would re-stamp completed_at and recompute cost — harmless
  // but noisy.
  try {
    const file = findTaskFile(paths, taskId)!;
    const task = JSON.parse(readFileSync(file, 'utf-8')) as Task;
    if (task.status === 'completed' || task.status === 'cancelled') return;
  } catch {
    return;
  }

  try {
    if (metadata.status === 'success') {
      const summary = [
        `spawn-codex run ${metadata.run_id} completed (exit ${metadata.exit_code}, ${(metadata.duration_ms / 1000).toFixed(1)}s).`,
        `Artifact: ${metadata.artifact_path}.`,
        `Sidecar: ${metadata.sidecar_path}.`,
      ].join(' ');
      completeTask(paths, taskId, summary);
    } else {
      const reason = metadata.status === 'timed_out'
        ? `spawn-codex run ${metadata.run_id} timed out after ${(metadata.duration_ms / 1000).toFixed(1)}s. stderr excerpt: ${metadata.stderr_excerpt || '(none)'}`
        : `spawn-codex run ${metadata.run_id} failed (exit ${metadata.exit_code}, ${(metadata.duration_ms / 1000).toFixed(1)}s). stderr excerpt: ${metadata.stderr_excerpt || '(none)'}`;
      updateTask(paths, taskId, 'blocked', {
        blocker: {
          blocker_reason: reason,
          next_proof_required: `Re-run spawn-codex with a fixed prompt or address the underlying ${metadata.status} cause; artifact at ${metadata.artifact_path}.`,
        },
      });
    }
  } catch {
    // Best-effort: do not surface lifecycle errors to the spawn caller.
  }
}

export interface SpawnCodexRunMetadata {
  ok: boolean;
  status: 'success' | 'failed' | 'timed_out';
  run_id: string;
  started_at: string;
  completed_at: string;
  duration_ms: number;
  prompt_file: string;
  prompt_sha256: string;
  prompt_chars: number;
  artifact_path: string;
  sidecar_path: string;
  workdir: string;
  agent: string | null;
  task_id: string | null;
  requester: string | null;
  reply_to: string | null;
  priority: string | null;
  model: string | null;
  effort: string | null;
  mcp_config: string | null;
  sandbox: string | null;
  exit_code: number | null;
  exit_signal: NodeJS.Signals | null;
  exit: {
    code: number | null;
    signal: NodeJS.Signals | null;
    timed_out: boolean;
  };
  timed_out: boolean;
  stdout_chars: number;
  stdout: string;
  stderr: string;
  stderr_excerpt: string | null;
  output_collision_guard: 'created' | 'renamed';
}

export interface SpawnCodexResult {
  ok: boolean;
  status: SpawnCodexRunMetadata['status'];
  outputPath: string;
  sidecarPath: string;
  output: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  metadata: SpawnCodexRunMetadata;
}

function codexBin(): string {
  return process.env.CODEX_BIN ?? 'codex';
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function slugFromPath(filePath: string): string {
  return basename(filePath)
    .replace(/\.(md|txt|prompt)$/i, '')
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'prompt';
}

function resolveOutputDir(agentsRoot?: string, agentName?: string): string {
  if (agentsRoot && agentName) {
    const dir = join(agentsRoot, 'agents', agentName, 'output');
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  const dir = join(process.cwd(), 'output');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function spawnEnv(opts: SpawnCodexOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };

  if (opts.agentName) {
    env.CTX_AGENT_NAME = opts.agentName;
    // Daemon-fired spawn-codex jobs run as a bounded child process, not as the
    // long-lived agent PTY. When the daemon is the caller, process.pid is the
    // same PID recorded in state/{agent}/session.lock, so forwarding it lets the
    // child perform normal bus mutations without weakening manual dup-session
    // rejection. Manual spawn-codex invocations still fail the lock check
    // because their process.pid will not match the daemon-owned lock.
    env.CTX_SESSION_OWNER_PID = process.env.CTX_SESSION_OWNER_PID ?? String(process.pid);
  }
  if (opts.agentsRoot && opts.agentName) {
    env.CTX_AGENT_DIR = join(opts.agentsRoot, 'agents', opts.agentName);
    env.CTX_ORG = basename(opts.agentsRoot);
  }

  return env;
}

function runId(startedAtMs: number, prompt: string): string {
  const timestamp = new Date(startedAtMs).toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  return `${timestamp}-${sha256(`${timestamp}:${prompt}`).slice(0, 8)}`;
}

function outputPaths(outputDir: string, suffix: string): { outputPath: string; sidecarPath: string; guard: 'created' | 'renamed' } {
  let outputPath = join(outputDir, `${suffix}.md`);
  let sidecarPath = join(outputDir, `${suffix}.json`);
  if (!existsSync(outputPath) && !existsSync(sidecarPath)) {
    return { outputPath, sidecarPath, guard: 'created' };
  }

  for (let i = 2; i < 1000; i += 1) {
    outputPath = join(outputDir, `${suffix}-${i}.md`);
    sidecarPath = join(outputDir, `${suffix}-${i}.json`);
    if (!existsSync(outputPath) && !existsSync(sidecarPath)) {
      return { outputPath, sidecarPath, guard: 'renamed' };
    }
  }

  throw new Error(`Could not allocate unique spawn-codex output path for ${suffix}`);
}

function readPrompt(promptFileOrDash: string): { prompt: string; promptPath: string } {
  if (promptFileOrDash === '-') {
    return { prompt: readFileSync(process.stdin.fd, 'utf-8'), promptPath: '-' };
  }

  const promptPath = resolve(promptFileOrDash);
  if (!existsSync(promptPath)) {
    throw new Error(`Prompt file not found: ${promptPath}`);
  }
  return { prompt: readFileSync(promptPath, 'utf-8'), promptPath };
}

export function spawnCodex(promptFileOrDash: string, opts: SpawnCodexOptions = {}): SpawnCodexResult {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const { prompt, promptPath } = readPrompt(promptFileOrDash);

  if (!prompt.trim()) {
    throw new Error('Prompt file is empty');
  }

  const timeoutSecs = opts.timeout ?? 300;
  const workdir = opts.workdir ?? process.cwd();
  const args = ['exec'];

  if (opts.model) {
    args.push('--model', opts.model);
  }
  if (opts.effort) {
    args.push('--effort', opts.effort);
  }
  if (opts.mcpConfig) {
    args.push('--mcp-config', opts.mcpConfig);
  }
  if (opts.sandbox) {
    args.push('--sandbox', opts.sandbox);
  }

  args.push(prompt);

  const run = spawnSync(codexBin(), args, {
    cwd: workdir,
    timeout: timeoutSecs * 1000,
    input: '',
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
    env: spawnEnv(opts),
  });

  const completedAtMs = Date.now();
  const durationMs = completedAtMs - startedAtMs;
  const stdout = (run.stdout ?? '').toString();
  const stderr = (run.stderr ?? '').toString();
  const timedOut = Boolean(run.error && (run.error as NodeJS.ErrnoException).code === 'ETIMEDOUT');
  const exitCode = typeof run.status === 'number' ? run.status : null;
  const exitSignal = run.signal ?? null;
  const ok = !timedOut && exitCode === 0;
  const status: SpawnCodexRunMetadata['status'] = timedOut ? 'timed_out' : ok ? 'success' : 'failed';
  const id = runId(startedAtMs, prompt);

  const date = new Date().toISOString().slice(0, 10);
  const slug = promptFileOrDash === '-' ? 'stdin' : slugFromPath(promptFileOrDash);
  const suffix = `${date}-spawn-codex-${slug}-${id}`;
  const outputDir = resolveOutputDir(opts.agentsRoot, opts.agentName);
  const { outputPath, sidecarPath, guard } = outputPaths(outputDir, suffix);
  const liveState = createAgentLiveStateHandle({
    ctxRoot: process.env.CTX_ROOT,
    org: process.env.CTX_ORG,
    agent: opts.agentName,
    taskId: opts.taskId,
  });

  const metadata: SpawnCodexRunMetadata = {
    ok,
    status,
    run_id: id,
    started_at: startedAt,
    completed_at: new Date(completedAtMs).toISOString(),
    duration_ms: durationMs,
    prompt_file: promptPath,
    prompt_sha256: sha256(prompt),
    prompt_chars: prompt.length,
    artifact_path: outputPath,
    sidecar_path: sidecarPath,
    workdir,
    agent: opts.agentName ?? null,
    task_id: opts.taskId ?? null,
    requester: opts.requester ?? null,
    reply_to: opts.replyTo ?? null,
    priority: opts.priority ?? null,
    model: opts.model ?? null,
    effort: opts.effort ?? null,
    mcp_config: opts.mcpConfig ?? null,
    sandbox: opts.sandbox ?? null,
    exit_code: exitCode,
    exit_signal: exitSignal,
    exit: {
      code: exitCode,
      signal: exitSignal,
      timed_out: timedOut,
    },
    timed_out: timedOut,
    stdout_chars: stdout.length,
    stdout,
    stderr,
    stderr_excerpt: stderr.trim() ? stderr.trim().slice(0, 1000) : null,
    output_collision_guard: guard,
  };

  const artifact = [
    `# Codex Output - ${slug}`,
    '',
    `**Status:** ${status}`,
    `**Spawned:** ${metadata.started_at}`,
    `**Completed:** ${metadata.completed_at}`,
    `**Duration:** ${(durationMs / 1000).toFixed(1)}s`,
    `**Task:** ${opts.taskId ?? 'none'}`,
    `**Requester:** ${opts.requester ?? 'none'}`,
    `**Model:** ${opts.model ?? 'default'}`,
    `**Effort:** ${opts.effort ?? 'default'}`,
    `**Sandbox:** ${opts.sandbox ?? 'default'}`,
    `**Workdir:** ${workdir}`,
    '',
    '## Prompt',
    '',
    prompt.length > 2000 ? `${prompt.slice(0, 2000)}\n\n_(truncated; see prompt file for full text)_` : prompt,
    '',
    '## Output',
    '',
    stdout.trim() || '(no stdout)',
    '',
    ...(stderr.trim() ? ['## Stderr', '', stderr.trim().slice(0, 4000)] : []),
  ].join('\n');

  writeFileSync(outputPath, `${artifact}\n`, 'utf-8');
  writeFileSync(sidecarPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf-8');
  if (liveState) {
    writeFileSync(liveState.files.log, `${stdout.trim() || '(no stdout)'}\n`, 'utf-8');
    writeAgentLiveManifest(liveState, { status, completed_at: metadata.completed_at });
    void mirrorAgentLiveState(liveState);
  }
  // CLI shim (src/cli/bus.ts) already flips the task via bestEffortTaskStatus,
  // so default opt-out here. Callers (e.g. cron-fire-dispatch via the async
  // variant below) can flip taskAutoComplete on explicitly if they want the
  // library to own the lifecycle.
  applySpawnRunTaskLifecycle({ ...opts, taskAutoComplete: opts.taskAutoComplete === true }, metadata);

  return {
    ok,
    status,
    outputPath,
    sidecarPath,
    output: stdout.trim(),
    stderr,
    exitCode,
    timedOut,
    durationMs,
    metadata,
  };
}

/**
 * Async variant of spawnCodex — identical behaviour but uses child_process.spawn
 * instead of spawnSync so the Node.js event loop is NOT blocked while Codex runs.
 *
 * Use this from the daemon (cron-fire-dispatch) where blocking the main event loop
 * causes fleet-wide stall watchdog false-positives and IPC timeouts.
 */
export async function spawnCodexAsync(promptFileOrDash: string, opts: SpawnCodexOptions = {}): Promise<SpawnCodexResult> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const { prompt, promptPath } = readPrompt(promptFileOrDash);

  if (!prompt.trim()) {
    throw new Error('Prompt file is empty');
  }

  const timeoutSecs = opts.timeout ?? 300;
  const workdir = opts.workdir ?? process.cwd();
  const args = ['exec'];
  const liveState = createAgentLiveStateHandle({
    ctxRoot: process.env.CTX_ROOT,
    org: process.env.CTX_ORG,
    agent: opts.agentName,
    taskId: opts.taskId,
  });
  if (liveState) {
    writeAgentLiveManifest(liveState, {
      status: 'running',
      started_at: startedAt,
      prompt_file: promptPath,
    });
    await mirrorAgentLiveState(liveState);
  }

  if (opts.model) args.push('--model', opts.model);
  if (opts.effort) args.push('--effort', opts.effort);
  if (opts.mcpConfig) args.push('--mcp-config', opts.mcpConfig);
  if (opts.sandbox) args.push('--sandbox', opts.sandbox);

  args.push(prompt);

  const { stdout, stderr, exitCode, exitSignal, timedOut } = await new Promise<{
    stdout: string;
    stderr: string;
    exitCode: number | null;
    exitSignal: NodeJS.Signals | null;
    timedOut: boolean;
  }>((resolve) => {
    let stdoutBuf = '';
    let stderrBuf = '';
    let settled = false;

    const child = spawn(codexBin(), args, {
      cwd: workdir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: spawnEnv(opts),
    });

    child.stdin.end('');
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    let lastMirrorAt = 0;
    const mirrorLive = () => {
      if (!liveState) return;
      const now = Date.now();
      if (now - lastMirrorAt < 2500) return;
      lastMirrorAt = now;
      void mirrorAgentLiveState(liveState);
    };
    child.stdout.on('data', (d: string) => {
      stdoutBuf += d;
      if (liveState) appendAgentLiveLog(liveState, d);
      mirrorLive();
    });
    child.stderr.on('data', (d: string) => {
      stderrBuf += d;
      if (liveState) appendAgentLiveLog(liveState, d);
      mirrorLive();
    });

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGTERM');
        resolve({ stdout: stdoutBuf, stderr: stderrBuf, exitCode: null, exitSignal: null, timedOut: true });
      }
    }, timeoutSecs * 1000);

    child.on('close', (code, signal) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({
          stdout: stdoutBuf,
          stderr: stderrBuf,
          exitCode: code,
          exitSignal: signal as NodeJS.Signals | null,
          timedOut: false,
        });
      }
    });

    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        stderrBuf += `\nspawn error: ${err.message}`;
        resolve({ stdout: stdoutBuf, stderr: stderrBuf, exitCode: null, exitSignal: null, timedOut: false });
      }
    });
  });

  const completedAtMs = Date.now();
  const durationMs = completedAtMs - startedAtMs;
  const ok = !timedOut && exitCode === 0;
  const status: SpawnCodexRunMetadata['status'] = timedOut ? 'timed_out' : ok ? 'success' : 'failed';
  const id = runId(startedAtMs, prompt);

  const date = new Date().toISOString().slice(0, 10);
  const slug = promptFileOrDash === '-' ? 'stdin' : slugFromPath(promptFileOrDash);
  const suffix = `${date}-spawn-codex-${slug}-${id}`;
  const outputDir = resolveOutputDir(opts.agentsRoot, opts.agentName);
  const { outputPath, sidecarPath, guard } = outputPaths(outputDir, suffix);

  const metadata: SpawnCodexRunMetadata = {
    ok, status, run_id: id, started_at: startedAt,
    completed_at: new Date(completedAtMs).toISOString(), duration_ms: durationMs,
    prompt_file: promptPath, prompt_sha256: sha256(prompt), prompt_chars: prompt.length,
    artifact_path: outputPath, sidecar_path: sidecarPath, workdir,
    agent: opts.agentName ?? null, task_id: opts.taskId ?? null,
    requester: opts.requester ?? null, reply_to: opts.replyTo ?? null,
    priority: opts.priority ?? null, model: opts.model ?? null,
    effort: opts.effort ?? null, mcp_config: opts.mcpConfig ?? null,
    sandbox: opts.sandbox ?? null, exit_code: exitCode, exit_signal: exitSignal,
    exit: { code: exitCode, signal: exitSignal, timed_out: timedOut },
    timed_out: timedOut, stdout_chars: stdout.length, stdout, stderr,
    stderr_excerpt: stderr.trim() ? stderr.trim().slice(0, 1000) : null,
    output_collision_guard: guard,
  };

  const artifact = [
    `# Codex Output - ${slug}`, '',
    `**Status:** ${status}`, `**Spawned:** ${metadata.started_at}`,
    `**Completed:** ${metadata.completed_at}`,
    `**Duration:** ${(durationMs / 1000).toFixed(1)}s`,
    `**Task:** ${opts.taskId ?? 'none'}`, `**Requester:** ${opts.requester ?? 'none'}`,
    `**Model:** ${opts.model ?? 'default'}`, `**Effort:** ${opts.effort ?? 'default'}`,
    `**Sandbox:** ${opts.sandbox ?? 'default'}`, `**Workdir:** ${workdir}`, '',
    '## Prompt', '',
    prompt.length > 2000 ? `${prompt.slice(0, 2000)}\n\n_(truncated; see prompt file for full text)_` : prompt,
    '', '## Output', '', stdout.trim() || '(no stdout)', '',
    ...(stderr.trim() ? ['## Stderr', '', stderr.trim().slice(0, 4000)] : []),
  ].join('\n');

  writeFileSync(outputPath, `${artifact}\n`, 'utf-8');
  writeFileSync(sidecarPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf-8');
  if (liveState) {
    writeAgentLiveManifest(liveState, { status, completed_at: metadata.completed_at });
    await mirrorAgentLiveState(liveState);
  }
  // Daemon path default: auto-close the originating task. cron-fire-dispatch
  // calls this without going through the CLI shim, so the lifecycle MUST be
  // owned here or the task stays in_progress forever (orphan-accumulation
  // bug, task_1778985018875_01210010).
  applySpawnRunTaskLifecycle({ ...opts, taskAutoComplete: opts.taskAutoComplete !== false }, metadata);

  return { ok, status, outputPath, sidecarPath, output: stdout.trim(), stderr, exitCode, timedOut, durationMs, metadata };
}
