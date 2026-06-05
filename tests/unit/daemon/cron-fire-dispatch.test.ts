import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchCronFire, extractSkillSlugsFromCronPrompt, type SpawnWorkerOptions, type SpawnWorkerResult } from '../../../src/daemon/cron-fire-dispatch.js';
import type { CronDefinition } from '../../../src/types/index.js';
import type { SpawnCodexResult } from '../../../src/bus/spawn-codex.js';

function cron(overrides: Partial<CronDefinition> = {}): CronDefinition {
  return {
    name: 'evening-review',
    prompt: 'Run evening review',
    schedule: '3 18 * * *',
    enabled: true,
    created_at: '2026-05-16T00:00:00.000Z',
    ...overrides,
  };
}

function result(ok = true): SpawnCodexResult {
  return {
    ok,
    status: ok ? 'success' : 'failed',
    outputPath: '/tmp/out.md',
    sidecarPath: '/tmp/out.json',
    output: 'done',
    stderr: '',
    exitCode: ok ? 0 : 1,
    timedOut: false,
    durationMs: 12,
    metadata: {
      ok,
      status: ok ? 'success' : 'failed',
      run_id: '20260516T000000Z-deadbeef',
      started_at: '2026-05-16T00:00:00.000Z',
      completed_at: '2026-05-16T00:00:00.012Z',
      duration_ms: 12,
      prompt_file: '/tmp/prompt.md',
      prompt_sha256: 'abc',
      prompt_chars: 10,
      artifact_path: '/tmp/out.md',
      sidecar_path: '/tmp/out.json',
      workdir: '/tmp',
      agent: 'codex',
      task_id: 'cron:orchestrator:evening-review',
      requester: 'orchestrator',
      reply_to: null,
      priority: 'cron',
      model: null,
      effort: null,
      mcp_config: null,
      sandbox: 'danger-full-access',
      exit_code: ok ? 0 : 1,
      exit_signal: null,
      exit: {
        code: ok ? 0 : 1,
        signal: null,
        timed_out: false,
      },
      timed_out: false,
      stdout_chars: 4,
      stdout: 'done',
      stderr: '',
      stderr_excerpt: null,
      output_collision_guard: 'created',
    },
  };
}

describe('dispatchCronFire', () => {
  const originalSupabaseUrl = process.env.SUPABASE_RGOS_URL;
  const originalSupabaseKey = process.env.SUPABASE_RGOS_SERVICE_KEY;

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    delete process.env.SUPABASE_RGOS_URL;
    delete process.env.SUPABASE_RGOS_SERVICE_KEY;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalSupabaseUrl === undefined) {
      delete process.env.SUPABASE_RGOS_URL;
    } else {
      process.env.SUPABASE_RGOS_URL = originalSupabaseUrl;
    }
    if (originalSupabaseKey === undefined) {
      delete process.env.SUPABASE_RGOS_SERVICE_KEY;
    } else {
      process.env.SUPABASE_RGOS_SERVICE_KEY = originalSupabaseKey;
    }
    vi.clearAllMocks();
  });

  it('keeps default PTY cron injection behavior', async () => {
    const injectAgent = vi.fn().mockReturnValue(true);

    await dispatchCronFire(cron(), {
      agentName: 'orchestrator',
      frameworkRoot: '/repo',
      org: 'revops-global',
      injectAgent,
      now: () => new Date('2026-05-16T12:00:00.000Z'),
    });

    expect(injectAgent).toHaveBeenCalledWith(
      'orchestrator',
      '[CRON FIRED 2026-05-16T12:00:00.000Z] evening-review: Run evening review',
    );
  });

  it('extracts skill slugs from cron prompt skill references', () => {
    expect(extractSkillSlugsFromCronPrompt([
      'Read plugins/cortextos-agent-skills/skills/heartbeat/SKILL.md and follow it.',
      'Then use the comms skill.',
      'Also run $tasks.',
      'Open /home/codex/.claude/skills/.system/imagegen/SKILL.md.',
      'skill: event-logging',
    ].join(' '))).toEqual(['comms', 'event-logging', 'heartbeat', 'imagegen', 'tasks']);
  });

  it('logs cron skill references without blocking PTY dispatch', async () => {
    const injectAgent = vi.fn().mockReturnValue(true);
    const logImplicitInvocationImpl = vi.fn().mockResolvedValue(undefined);

    await dispatchCronFire(cron({
      prompt: 'Read plugins/cortextos-agent-skills/skills/heartbeat/SKILL.md, then use the tasks skill.',
    }), {
      agentName: 'codex-3',
      frameworkRoot: '/repo',
      org: 'revops-global',
      injectAgent,
      logImplicitInvocationImpl,
      now: () => new Date('2026-05-16T12:00:00.000Z'),
    });

    expect(injectAgent).toHaveBeenCalledWith(
      'codex-3',
      '[CRON FIRED 2026-05-16T12:00:00.000Z] evening-review: Read plugins/cortextos-agent-skills/skills/heartbeat/SKILL.md, then use the tasks skill.',
    );
    expect(logImplicitInvocationImpl).toHaveBeenCalledTimes(2);
    expect(logImplicitInvocationImpl).toHaveBeenCalledWith(
      'heartbeat',
      '/repo/orgs/revops-global/agents/codex-3',
      'codex-3',
      { source: 'cron' },
    );
    expect(logImplicitInvocationImpl).toHaveBeenCalledWith(
      'tasks',
      '/repo/orgs/revops-global/agents/codex-3',
      'codex-3',
      { source: 'cron' },
    );
  });

  it('logs cron skill references for spawn-codex target agent prompts', async () => {
    const spawnCodexImpl = vi.fn().mockResolvedValue(result(true));
    const logImplicitInvocationImpl = vi.fn().mockResolvedValue(undefined);

    await dispatchCronFire(cron({
      prompt: 'Follow the heartbeat skill.',
      metadata: {
        runner: 'spawn-codex',
        prompt_file: 'prompts/heartbeat.md',
        agent: 'codex',
      },
    }), {
      agentName: 'orchestrator',
      frameworkRoot: '/repo',
      org: 'revops-global',
      injectAgent: vi.fn(),
      spawnCodexImpl,
      logImplicitInvocationImpl,
    });

    expect(logImplicitInvocationImpl).toHaveBeenCalledWith(
      'heartbeat',
      '/repo/orgs/revops-global/agents/codex',
      'codex',
      { source: 'cron' },
    );
  });

  it('runs spawn-codex crons without injecting into the long-running PTY', async () => {
    const injectAgent = vi.fn();
    const spawnCodexImpl = vi.fn().mockResolvedValue(result(true));
    const mirrorReviewImpl = vi.fn().mockResolvedValue(undefined);

    await dispatchCronFire(cron({
      metadata: {
        runner: 'spawn-codex',
        prompt_file: 'prompts/evening-review.md',
        workdir: '.',
        agent: 'codex',
        timeout_seconds: 900,
        task_id: '755920d9',
        reply_to: '1778976581063-orchestrator-00ahy',
        model: 'gpt-5.4',
        effort: 'medium',
        sandbox: 'workspace-write',
      },
    }), {
      agentName: 'orchestrator',
      frameworkRoot: '/repo',
      org: 'revops-global',
      injectAgent,
      spawnCodexImpl,
      mirrorReviewImpl,
    });

    expect(injectAgent).not.toHaveBeenCalled();
    expect(spawnCodexImpl).toHaveBeenCalledWith('/repo/orgs/revops-global/prompts/evening-review.md', {
      agentName: 'codex',
      agentsRoot: '/repo/orgs/revops-global',
      workdir: '/repo/orgs/revops-global',
      timeout: 900,
      model: 'gpt-5.4',
      effort: 'medium',
      mcpConfig: undefined,
      sandbox: 'workspace-write',
      taskId: '755920d9',
      requester: 'orchestrator',
      replyTo: '1778976581063-orchestrator-00ahy',
      priority: 'cron',
    });
    expect(mirrorReviewImpl).toHaveBeenCalledWith(expect.objectContaining({
      runId: '20260516T000000Z-deadbeef',
      org: 'revops-global',
      type: 'evening',
      periodEnd: '2026-05-16T00:00:00.012Z',
      createdAt: '2026-05-16T00:00:00.012Z',
      summary: expect.objectContaining({
        daemon_spawn_codex: true,
        cron_name: 'evening-review',
        artifact_path: '/tmp/out.md',
        output_excerpt: 'done',
      }),
    }));
  });

  it('mirrors successful spawn-codex review crons into orch_reviews', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 201 }));
    process.env.SUPABASE_RGOS_URL = 'https://test.supabase.co';
    process.env.SUPABASE_RGOS_SERVICE_KEY = 'test-service-key';

    const spawnCodexImpl = vi.fn().mockResolvedValue(result(true));

    await dispatchCronFire(cron({
      name: 'evening-review',
      metadata: {
        runner: 'spawn-codex',
        prompt_file: 'prompts/evening-review.md',
        agent: 'codex',
      },
    }), {
      agentName: 'orchestrator',
      frameworkRoot: '/repo',
      org: 'revops-global',
      injectAgent: vi.fn(),
      spawnCodexImpl,
    });

    expect(fetch).toHaveBeenCalledWith(
      'https://test.supabase.co/rest/v1/orch_reviews',
      expect.objectContaining({
        method: 'POST',
        body: expect.any(String),
      }),
    );
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(body).toMatchObject({
      org_id: 'revops-global',
      type: 'evening',
      period_end: '2026-05-16T00:00:00.012Z',
    });
    expect(body.summary_json).toMatchObject({
      daemon_spawn_codex: true,
      cron_name: 'evening-review',
      artifact_path: '/tmp/out.md',
      output_excerpt: 'done',
    });
    expect(body.summary_json.narrative).toContain('Daemon-fired scoped Codex evening review completed.');
  });

  it('does not mirror non-review spawn-codex crons into orch_reviews', async () => {
    process.env.SUPABASE_RGOS_URL = 'https://test.supabase.co';
    process.env.SUPABASE_RGOS_SERVICE_KEY = 'test-service-key';

    await dispatchCronFire(cron({
      name: 'worker-monitor',
      metadata: {
        runner: 'spawn-codex',
        prompt_file: 'prompts/worker-monitor.md',
        agent: 'codex',
      },
    }), {
      agentName: 'orchestrator',
      frameworkRoot: '/repo',
      org: 'revops-global',
      injectAgent: vi.fn(),
      spawnCodexImpl: vi.fn().mockResolvedValue(result(true)),
    });

    expect(fetch).not.toHaveBeenCalled();
  });

  it('throws when a spawn-codex cron fails', async () => {
    await expect(dispatchCronFire(cron({
      metadata: { runner: 'spawn-codex', prompt_file: 'prompts/evening-review.md' },
    }), {
      agentName: 'orchestrator',
      frameworkRoot: '/repo',
      org: 'revops-global',
      injectAgent: vi.fn(),
      spawnCodexImpl: vi.fn().mockResolvedValue(result(false)),
    })).rejects.toThrow(/spawn-codex cron "evening-review" failed/);
  });

  it('defaults daemon spawn-codex crons to danger-full-access sandbox', async () => {
    const spawnCodexImpl = vi.fn().mockResolvedValue(result(true));

    await dispatchCronFire(cron({
      metadata: { runner: 'spawn-codex', prompt_file: 'prompts/evening-review.md' },
    }), {
      agentName: 'orchestrator',
      frameworkRoot: '/repo',
      org: 'revops-global',
      injectAgent: vi.fn(),
      spawnCodexImpl,
    });

    expect(spawnCodexImpl).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      sandbox: 'danger-full-access',
    }));
  });

  it('dispatches spawn-worker crons without injecting into PTY', async () => {
    const injectAgent = vi.fn();
    const spawnWorkerImpl = vi.fn().mockResolvedValue({ ok: true, exitCode: 0 } satisfies SpawnWorkerResult);

    await dispatchCronFire(cron({
      name: 'theta-wave',
      prompt: 'Run theta-wave now.',
      metadata: { runner: 'spawn-worker' },
    }), {
      agentName: 'orchestrator',
      frameworkRoot: '/repo',
      org: 'revops-global',
      injectAgent,
      spawnWorkerImpl,
    });

    expect(injectAgent).not.toHaveBeenCalled();
    expect(spawnWorkerImpl).toHaveBeenCalledWith({
      workerName: 'cron:orchestrator:theta-wave',
      dir: '/repo/orgs/revops-global/agents/orchestrator',
      prompt: 'Run theta-wave now.',
      parent: 'orchestrator',
      model: undefined,
      home: undefined,
    } satisfies SpawnWorkerOptions);
  });

  it('spawn-worker uses metadata.worker_name and metadata.agent when provided', async () => {
    const spawnWorkerImpl = vi.fn().mockResolvedValue({ ok: true, exitCode: 0 } satisfies SpawnWorkerResult);

    await dispatchCronFire(cron({
      name: 'theta-freshness-watchdog',
      prompt: 'Check freshness.',
      metadata: {
        runner: 'spawn-worker',
        worker_name: 'theta-freshness-1',
        agent: 'analyst',
        model: 'claude-haiku-4-5',
      },
    }), {
      agentName: 'orchestrator',
      frameworkRoot: '/repo',
      org: 'revops-global',
      injectAgent: vi.fn(),
      spawnWorkerImpl,
    });

    expect(spawnWorkerImpl).toHaveBeenCalledWith(expect.objectContaining({
      workerName: 'theta-freshness-1',
      dir: '/repo/orgs/revops-global/agents/analyst',
      model: 'claude-haiku-4-5',
    }));
  });

  it('throws when spawn-worker cron fails', async () => {
    await expect(dispatchCronFire(cron({
      name: 'theta-wave',
      metadata: { runner: 'spawn-worker' },
    }), {
      agentName: 'orchestrator',
      frameworkRoot: '/repo',
      org: 'revops-global',
      injectAgent: vi.fn(),
      spawnWorkerImpl: vi.fn().mockResolvedValue({ ok: false, exitCode: 1 } satisfies SpawnWorkerResult),
    })).rejects.toThrow(/spawn-worker cron "theta-wave" failed with exit code 1/);
  });

  it('skips spawn-codex when today\'s sidecar already exists (dedup guard)', async () => {
    const spawnCodexImpl = vi.fn().mockResolvedValue(result(true));
    const tmpRoot = mkdtempSync(join(tmpdir(), 'ctx-dedup-test-'));

    try {
      const outputDir = join(tmpRoot, 'orgs', 'revops-global', 'agents', 'codex', 'output');
      mkdirSync(outputDir, { recursive: true });
      // Simulate a prior run sidecar from the same day
      writeFileSync(
        join(outputDir, '2026-05-16-spawn-codex-evening-review-20260516T000000Z-deadbeef.json'),
        '{"status":"timed_out"}',
      );

      const ret = await dispatchCronFire(cron({
        metadata: {
          runner: 'spawn-codex',
          prompt_file: 'prompts/evening-review.md',
          agent: 'codex',
        },
      }), {
        agentName: 'orchestrator',
        frameworkRoot: tmpRoot,
        org: 'revops-global',
        injectAgent: vi.fn(),
        spawnCodexImpl,
        now: () => new Date('2026-05-16T12:00:00.000Z'),
      });

      expect(spawnCodexImpl).not.toHaveBeenCalled();
      expect(ret).toBeUndefined();
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('throws when spawn-worker prompt_file is not readable', async () => {
    await expect(dispatchCronFire(cron({
      name: 'theta-wave',
      metadata: { runner: 'spawn-worker', prompt_file: 'prompts/nonexistent.md' },
    }), {
      agentName: 'orchestrator',
      frameworkRoot: '/repo',
      org: 'revops-global',
      injectAgent: vi.fn(),
      spawnWorkerImpl: vi.fn(),
    })).rejects.toThrow(/spawn-worker prompt_file.*not readable/);
  });

});
