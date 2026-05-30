import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import type { CronDefinition } from '../types/index.js';
import { spawnCodexAsync, type SpawnCodexResult } from '../bus/spawn-codex.js';
import { mirrorReviewToRgos, type ReviewMirrorInput } from '../bus/rgos-mirror.js';
import { logImplicitInvocation } from '../bus/skill-instrument.js';

type SpawnCodexFn = typeof spawnCodexAsync;
type MirrorReviewFn = typeof mirrorReviewToRgos;
type LogImplicitInvocationFn = typeof logImplicitInvocation;

export interface SpawnWorkerOptions {
  workerName: string;
  dir: string;
  prompt: string;
  parent: string;
  model?: string;
  home?: string;
}

export interface SpawnWorkerResult {
  ok: boolean;
  exitCode: number | null;
}

type SpawnWorkerFn = (opts: SpawnWorkerOptions) => Promise<SpawnWorkerResult>;

export interface CronFireDispatchOptions {
  agentName: string;
  frameworkRoot: string;
  org: string;
  injectAgent: (agentName: string, message: string) => boolean;
  spawnCodexImpl?: SpawnCodexFn;
  spawnWorkerImpl?: SpawnWorkerFn;
  mirrorReviewImpl?: MirrorReviewFn;
  logImplicitInvocationImpl?: LogImplicitInvocationFn;
  now?: () => Date;
}

// Re-export for consumers that only need the async path
export { spawnCodexAsync };

function metadataString(cron: CronDefinition, key: string): string | undefined {
  const value = cron.metadata?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function metadataNumber(cron: CronDefinition, key: string): number | undefined {
  const value = cron.metadata?.[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function resolveOrgPath(frameworkRoot: string, org: string, pathValue: string): string {
  if (pathValue.startsWith('/')) return pathValue;
  if (pathValue.startsWith('orgs/')) return resolve(frameworkRoot, pathValue);
  return resolve(frameworkRoot, 'orgs', org, pathValue);
}

function isReviewType(value: string): value is ReviewMirrorInput['type'] {
  return value === 'morning' || value === 'evening' || value === 'weekly';
}

function reviewTypeForCron(cron: CronDefinition): ReviewMirrorInput['type'] | null {
  const explicit = metadataString(cron, 'review_type');
  if (explicit) return isReviewType(explicit) ? explicit : null;

  const name = cron.name.toLowerCase();
  if (!name.includes('review')) return null;
  if (name.includes('morning')) return 'morning';
  if (name.includes('evening')) return 'evening';
  if (name.includes('weekly')) return 'weekly';
  return null;
}

function reviewPeriodStart(type: ReviewMirrorInput['type'], periodEnd: string, fallbackStart: string): string {
  const end = new Date(periodEnd).getTime();
  if (!Number.isFinite(end)) return fallbackStart;

  const hours = type === 'weekly' ? 24 * 7
    : type === 'evening' ? 12
    : 24;
  return new Date(end - hours * 60 * 60 * 1000).toISOString();
}

function excerpt(value: string, maxChars = 4000): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}...` : trimmed;
}

const SKILL_SLUG_RE = '[a-z0-9][a-z0-9_-]{0,63}';

export function extractSkillSlugsFromCronPrompt(prompt: string | undefined): string[] {
  if (!prompt) return [];

  const slugs = new Set<string>();
  const addMatches = (re: RegExp, group = 1) => {
    for (const match of prompt.matchAll(re)) {
      const slug = match[group]?.toLowerCase();
      if (slug) slugs.add(slug);
    }
  };

  // Matches .claude/skills/<slug>/SKILL.md, plugins/.../skills/<slug>/SKILL.md,
  // and namespaced skill paths such as skills/.system/<slug>/SKILL.md.
  addMatches(new RegExp(`(?:^|[/\\\\])skills[/\\\\](?:\\.[a-z0-9_-]+[/\\\\])?(${SKILL_SLUG_RE})[/\\\\]SKILL\\.md\\b`, 'gi'));

  // Codex local skill command syntax, e.g. "$heartbeat".
  addMatches(new RegExp(`\\$(${SKILL_SLUG_RE})\\b`, 'gi'));

  // Plain-language cron prompts often say "read/use/follow the <slug> skill".
  addMatches(new RegExp(`\\b(?:read|use|load|follow|run)\\s+(?:the\\s+)?[\\\`'"]?(${SKILL_SLUG_RE})[\\\`'"]?\\s+skill\\b`, 'gi'));
  addMatches(new RegExp(`\\bskill\\s*[:=]\\s*[\\\`'"]?(${SKILL_SLUG_RE})[\\\`'"]?\\b`, 'gi'));

  return [...slugs].sort();
}

function agentDirFor(opts: CronFireDispatchOptions, agentName: string): string {
  return resolve(opts.frameworkRoot, 'orgs', opts.org, 'agents', agentName);
}

function logCronSkillInvocations(
  prompt: string | undefined,
  opts: CronFireDispatchOptions,
  targetAgent: string,
): void {
  const slugs = extractSkillSlugsFromCronPrompt(prompt);
  if (slugs.length === 0) return;

  const logger = opts.logImplicitInvocationImpl ?? logImplicitInvocation;
  const agentDir = agentDirFor(opts, targetAgent);
  void Promise.all(
    slugs.map(slug => logger(slug, agentDir, targetAgent, { source: 'cron' })),
  ).catch(() => undefined);
}

async function spawnWorkerDefault(opts: SpawnWorkerOptions): Promise<SpawnWorkerResult> {
  const args = [
    'bus', 'spawn-worker', opts.workerName,
    '--dir', opts.dir,
    '--prompt', opts.prompt,
    '--parent', opts.parent,
  ];
  if (opts.model) args.push('--model', opts.model);
  if (opts.home) args.push('--home', opts.home);
  const result = spawnSync('cortextos', args, { stdio: 'pipe', timeout: 30_000 });
  return { ok: result.status === 0, exitCode: result.status };
}

async function mirrorSpawnCodexReview(
  cron: CronDefinition,
  opts: CronFireDispatchOptions,
  result: SpawnCodexResult,
): Promise<void> {
  const type = reviewTypeForCron(cron);
  if (!type) return;

  const periodEnd = result.metadata.completed_at;
  const mirrorReview = opts.mirrorReviewImpl ?? mirrorReviewToRgos;
  await mirrorReview({
    runId: result.metadata.run_id,
    org: opts.org,
    type,
    periodStart: reviewPeriodStart(type, periodEnd, result.metadata.started_at),
    periodEnd,
    createdAt: periodEnd,
    summary: {
      narrative: `Daemon-fired scoped Codex ${type} review completed. Artifact: ${result.outputPath}`,
      daemon_spawn_codex: true,
      cron_name: cron.name,
      status: result.status,
      agent: result.metadata.agent,
      task_id: result.metadata.task_id,
      requester: result.metadata.requester,
      priority: result.metadata.priority,
      artifact_path: result.outputPath,
      sidecar_path: result.sidecarPath,
      prompt_file: result.metadata.prompt_file,
      prompt_sha256: result.metadata.prompt_sha256,
      duration_ms: result.durationMs,
      model: result.metadata.model,
      effort: result.metadata.effort,
      sandbox: result.metadata.sandbox,
      exit_code: result.exitCode,
      output_excerpt: excerpt(result.output),
      stderr_excerpt: result.metadata.stderr_excerpt,
    },
  });
}

export async function dispatchCronFire(cron: CronDefinition, opts: CronFireDispatchOptions): Promise<SpawnCodexResult | void> {
  const runner = metadataString(cron, 'runner') ?? 'pty';

  if (runner === 'spawn-codex') {
    const promptFile = metadataString(cron, 'prompt_file');
    if (!promptFile) {
      throw new Error(`cron "${cron.name}" metadata.runner=spawn-codex requires metadata.prompt_file`);
    }

    const targetAgent = metadataString(cron, 'agent') ?? metadataString(cron, 'target_agent') ?? opts.agentName;
    logCronSkillInvocations(cron.prompt, opts, targetAgent);
    const workdir = metadataString(cron, 'workdir');
    const timeout = metadataNumber(cron, 'timeout_seconds');
    const resolvedPrompt = resolveOrgPath(opts.frameworkRoot, opts.org, promptFile);
    const resolvedWorkdir = workdir ? resolveOrgPath(opts.frameworkRoot, opts.org, workdir) : undefined;
    // Use spawnCodexAsync so the daemon event loop is NOT blocked while Codex
    // runs (which can take 50–120 s). spawnSync here caused fleet-wide watchdog
    // false-positives and IPC timeouts (root-cause: 2026-05-17 audit M2).
    // opts.spawnCodexImpl allows test injection; production uses spawnCodexAsync.
    const spawnFn = opts.spawnCodexImpl ?? spawnCodexAsync;
    const result = await spawnFn(resolvedPrompt, {
      agentName: targetAgent,
      agentsRoot: join(opts.frameworkRoot, 'orgs', opts.org),
      workdir: resolvedWorkdir,
      timeout,
      model: metadataString(cron, 'model'),
      effort: metadataString(cron, 'effort'),
      mcpConfig: metadataString(cron, 'mcp_config'),
      sandbox: (metadataString(cron, 'sandbox') as 'read-only' | 'workspace-write' | 'danger-full-access' | undefined) ?? 'danger-full-access',
      taskId: metadataString(cron, 'task_id') ?? `cron:${opts.agentName}:${cron.name}`,
      requester: opts.agentName,
      replyTo: metadataString(cron, 'reply_to'),
      priority: metadataString(cron, 'priority') ?? 'cron',
    });

    if (!result.ok) {
      throw new Error(`spawn-codex cron "${cron.name}" failed with status ${result.status}; artifact: ${result.outputPath}`);
    }
    await mirrorSpawnCodexReview(cron, opts, result);
    return result;
  }

  if (runner === 'spawn-worker') {
    const workerName = metadataString(cron, 'worker_name') ?? `cron:${opts.agentName}:${cron.name}`;

    let prompt: string;
    const promptFile = metadataString(cron, 'prompt_file');
    if (promptFile) {
      const resolvedFile = resolveOrgPath(opts.frameworkRoot, opts.org, promptFile);
      try {
        prompt = readFileSync(resolvedFile, 'utf-8');
      } catch (err) {
        throw new Error(
          `cron "${cron.name}" spawn-worker prompt_file "${resolvedFile}" not readable: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else {
      prompt = cron.prompt ?? `[cron] ${cron.name} fired`;
    }

    const targetAgent = metadataString(cron, 'agent') ?? metadataString(cron, 'target_agent') ?? opts.agentName;
    logCronSkillInvocations(prompt, opts, targetAgent);

    const workdir = metadataString(cron, 'workdir');
    const resolvedWorkdir = workdir
      ? resolveOrgPath(opts.frameworkRoot, opts.org, workdir)
      : agentDirFor(opts, targetAgent);

    const spawnFn = opts.spawnWorkerImpl ?? spawnWorkerDefault;
    const result = await spawnFn({
      workerName,
      dir: resolvedWorkdir,
      prompt,
      parent: opts.agentName,
      model: metadataString(cron, 'model'),
      home: metadataString(cron, 'home'),
    });

    if (!result.ok) {
      throw new Error(
        `spawn-worker cron "${cron.name}" failed with exit code ${result.exitCode}`,
      );
    }
    return;
  }

  if (runner !== 'pty') {
    throw new Error(`cron "${cron.name}" has unsupported metadata.runner "${runner}"`);
  }

  const prompt = cron.prompt ?? `[cron] ${cron.name} fired`;
  logCronSkillInvocations(prompt, opts, opts.agentName);
  const firedAt = (opts.now ?? (() => new Date()))().toISOString();
  const injection = `[CRON FIRED ${firedAt}] ${cron.name}: ${prompt}`;
  const injected = opts.injectAgent(opts.agentName, injection);
  if (!injected) {
    throw new Error(`injectAgent returned false for agent "${opts.agentName}" — agent may not be running`);
  }
}
