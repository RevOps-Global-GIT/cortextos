import { join, resolve } from 'path';
import type { CronDefinition } from '../types/index.js';
import { spawnCodexAsync, type SpawnCodexResult } from '../bus/spawn-codex.js';
import { mirrorReviewToRgos, type ReviewMirrorInput } from '../bus/rgos-mirror.js';

type SpawnCodexFn = typeof spawnCodexAsync;
type MirrorReviewFn = typeof mirrorReviewToRgos;

export interface CronFireDispatchOptions {
  agentName: string;
  frameworkRoot: string;
  org: string;
  injectAgent: (agentName: string, message: string) => boolean;
  spawnCodexImpl?: SpawnCodexFn;
  mirrorReviewImpl?: MirrorReviewFn;
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

  if (runner !== 'pty') {
    throw new Error(`cron "${cron.name}" has unsupported metadata.runner "${runner}"`);
  }

  const prompt = cron.prompt ?? `[cron] ${cron.name} fired`;
  const firedAt = (opts.now ?? (() => new Date()))().toISOString();
  const injection = `[CRON FIRED ${firedAt}] ${cron.name}: ${prompt}`;
  const injected = opts.injectAgent(opts.agentName, injection);
  if (!injected) {
    throw new Error(`injectAgent returned false for agent "${opts.agentName}" — agent may not be running`);
  }
}
