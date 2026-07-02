import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'fs';
import { basename, join } from 'path';
import { tmpdir, homedir } from 'os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnCodex, spawnCodexAsync } from '../../../src/bus/spawn-codex.js';

const previousCodexBin = process.env.CODEX_BIN;
const previousSessionOwnerPid = process.env.CTX_SESSION_OWNER_PID;

afterEach(() => {
  vi.useRealTimers();
  if (previousCodexBin === undefined) {
    delete process.env.CODEX_BIN;
  } else {
    process.env.CODEX_BIN = previousCodexBin;
  }
  if (previousSessionOwnerPid === undefined) {
    delete process.env.CTX_SESSION_OWNER_PID;
  } else {
    process.env.CTX_SESSION_OWNER_PID = previousSessionOwnerPid;
  }
});

function makeFakeCodex(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'spawn-codex-bin-'));
  const bin = join(dir, 'codex-fake');
  writeFileSync(bin, body, 'utf-8');
  chmodSync(bin, 0o755);
  process.env.CODEX_BIN = bin;
  return dir;
}

function makePrompt(text = 'Say OK and exit.'): { dir: string; prompt: string; agentsRoot: string } {
  const dir = mkdtempSync(join(tmpdir(), 'spawn-codex-test-'));
  const prompt = join(dir, 'prompt.md');
  const agentsRoot = join(dir, 'org');
  writeFileSync(prompt, text, 'utf-8');
  return { dir, prompt, agentsRoot };
}

describe('spawnCodex', () => {
  it('writes an artifact and JSON sidecar for successful runs', () => {
    makeFakeCodex('#!/usr/bin/env bash\nprintf "fake codex ok\\n"\n');
    const { prompt, agentsRoot } = makePrompt();

    const result = spawnCodex(prompt, {
      agentsRoot,
      agentName: 'codex',
      taskId: 'task-123',
      requester: 'orchestrator',
      sandbox: 'danger-full-access',
      timeout: 5,
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe('success');
    expect(result.output).toContain('fake codex ok');
    expect(result.outputPath).toContain('/agents/codex/output/');
    expect(readFileSync(result.outputPath, 'utf-8')).toContain('fake codex ok');

    const sidecar = JSON.parse(readFileSync(result.sidecarPath, 'utf-8'));
    expect(sidecar.ok).toBe(true);
    expect(sidecar.task_id).toBe('task-123');
    expect(sidecar.requester).toBe('orchestrator');
    expect(sidecar.sandbox).toBe('danger-full-access');
    expect(sidecar.prompt_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(sidecar.artifact_path).toBe(result.outputPath);
    expect(sidecar.run_id).toMatch(/^\d{8}T\d{6}Z-[a-f0-9]{8}$/);
    expect(sidecar.exit).toEqual({ code: 0, signal: null, timed_out: false });
    expect(sidecar.stdout).toContain('fake codex ok');
    expect(sidecar.stderr).toBe('');
    expect(sidecar.output_collision_guard).toBe('created');
  });

  it('sets target agent identity env for the spawned Codex process', () => {
    makeFakeCodex(`#!/usr/bin/env bash
printf 'agent=%s\\n' "$CTX_AGENT_NAME"
printf 'dir=%s\\n' "$CTX_AGENT_DIR"
printf 'org=%s\\n' "$CTX_ORG"
`);
    const { prompt, agentsRoot } = makePrompt();

    const result = spawnCodex(prompt, {
      agentsRoot,
      agentName: 'dev',
      timeout: 5,
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain('agent=dev');
    expect(result.output).toContain(`dir=${join(agentsRoot, 'agents', 'dev')}`);
    expect(result.output).toContain(`org=${basename(agentsRoot)}`);
  });

  it('forwards session ownership proof for daemon-spawned target agents', () => {
    delete process.env.CTX_SESSION_OWNER_PID;
    makeFakeCodex(`#!/usr/bin/env bash
printf 'owner=%s\\n' "$CTX_SESSION_OWNER_PID"
`);
    const { prompt, agentsRoot } = makePrompt();

    const result = spawnCodex(prompt, {
      agentsRoot,
      agentName: 'analyst',
      timeout: 5,
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain(`owner=${process.pid}`);
  });

  it('preserves an inherited session ownership proof from an agent PTY', () => {
    process.env.CTX_SESSION_OWNER_PID = '424242';
    makeFakeCodex(`#!/usr/bin/env bash
printf 'owner=%s\\n' "$CTX_SESSION_OWNER_PID"
`);
    const { prompt, agentsRoot } = makePrompt();

    const result = spawnCodex(prompt, {
      agentsRoot,
      agentName: 'analyst',
      timeout: 5,
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain('owner=424242');
  });

  it('writes failure metadata when codex exits non-zero', () => {
    makeFakeCodex('#!/usr/bin/env bash\nprintf "partial output\\n"\nprintf "boom\\n" >&2\nexit 7\n');
    const { prompt, agentsRoot } = makePrompt();

    const result = spawnCodex(prompt, { agentsRoot, agentName: 'codex', timeout: 5 });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.exitCode).toBe(7);
    expect(readFileSync(result.outputPath, 'utf-8')).toContain('partial output');

    const sidecar = JSON.parse(readFileSync(result.sidecarPath, 'utf-8'));
    expect(sidecar.ok).toBe(false);
    expect(sidecar.exit_code).toBe(7);
    expect(sidecar.exit.code).toBe(7);
    expect(sidecar.stdout).toContain('partial output');
    expect(sidecar.stderr).toContain('boom');
    expect(sidecar.stderr_excerpt).toContain('boom');
  });

  it('does not overwrite an existing artifact when two runs share the same prompt slug', () => {
    makeFakeCodex('#!/usr/bin/env bash\nprintf "same slug\\n"\n');
    const { prompt, agentsRoot } = makePrompt();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-16T12:34:56.789Z'));

    const first = spawnCodex(prompt, { agentsRoot, agentName: 'codex', timeout: 5 });
    writeFileSync(first.outputPath, 'sentinel\n', 'utf-8');
    const second = spawnCodex(prompt, { agentsRoot, agentName: 'codex', timeout: 5 });

    expect(existsSync(first.outputPath)).toBe(true);
    expect(readFileSync(first.outputPath, 'utf-8')).toBe('sentinel\n');
    expect(second.outputPath).not.toBe(first.outputPath);
    const sidecar = JSON.parse(readFileSync(second.sidecarPath, 'utf-8'));
    expect(sidecar.output_collision_guard).toBe('renamed');
  });

  it('reports missing prompt files before spawning codex', () => {
    makeFakeCodex('#!/usr/bin/env bash\nprintf "should not run\\n"\n');
    expect(() => spawnCodex('/tmp/not-a-real-prompt-file.md')).toThrow(/Prompt file not found/);
  });
});

// Lifecycle helper closes the orphan-accumulation gap on the spawnCodexAsync
// path (cron-fire-dispatch / daemon callers). See applySpawnRunTaskLifecycle
// in src/bus/spawn-codex.ts for the rationale and the original orphan
// evidence under task_1778985018875_01210010.
describe('spawnCodexAsync — bus task auto-lifecycle (orphan-accumulation fix)', () => {
  let homeOverride: string;
  let prevHome: string | undefined;
  let prevInstance: string | undefined;
  let prevOrg: string | undefined;
  let prevAgent: string | undefined;
  let taskDir: string;

  function writeTask(taskId: string, opts: { status?: string; assigned_to?: string } = {}): void {
    const task = {
      id: taskId,
      title: 'spawn-codex lifecycle fixture',
      description: '',
      type: 'agent',
      needs_approval: false,
      status: opts.status ?? 'in_progress',
      assigned_to: opts.assigned_to ?? 'codex',
      created_by: 'orchestrator',
      org: 'test-org',
      priority: 'normal',
      project: '',
      kpi_key: null,
      created_at: new Date(Date.now() - 60_000).toISOString(),
      updated_at: new Date(Date.now() - 60_000).toISOString(),
      completed_at: null,
      due_date: null,
      archived: false,
      meta: { cost_snapshot_start: 0 },
    };
    writeFileSync(join(taskDir, `${taskId}.json`), JSON.stringify(task));
  }

  function readTask(taskId: string): any {
    return JSON.parse(readFileSync(join(taskDir, `${taskId}.json`), 'utf-8'));
  }

  beforeEach(() => {
    homeOverride = mkdtempSync(join(tmpdir(), 'spawn-codex-home-'));
    prevHome = process.env.HOME;
    prevInstance = process.env.CTX_INSTANCE_ID;
    prevOrg = process.env.CTX_ORG;
    prevAgent = process.env.CTX_AGENT_NAME;
    process.env.HOME = homeOverride;
    process.env.CTX_INSTANCE_ID = 'default';
    process.env.CTX_ORG = 'test-org';
    process.env.CTX_AGENT_NAME = 'codex';
    taskDir = join(homeOverride, '.cortextos', 'default', 'orgs', 'test-org', 'tasks');
    mkdirSync(taskDir, { recursive: true });
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevInstance === undefined) delete process.env.CTX_INSTANCE_ID; else process.env.CTX_INSTANCE_ID = prevInstance;
    if (prevOrg === undefined) delete process.env.CTX_ORG; else process.env.CTX_ORG = prevOrg;
    if (prevAgent === undefined) delete process.env.CTX_AGENT_NAME; else process.env.CTX_AGENT_NAME = prevAgent;
    try { rmSync(homeOverride, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('successful async run auto-completes the originating bus task', async () => {
    makeFakeCodex('#!/usr/bin/env bash\nprintf "fake codex ok\\n"\n');
    const { prompt, agentsRoot } = makePrompt();
    const taskId = 'task_lifecycle_success_001';
    writeTask(taskId);

    const result = await spawnCodexAsync(prompt, {
      agentsRoot,
      agentName: 'codex',
      taskId,
      timeout: 5,
    });
    expect(result.ok).toBe(true);

    const task = readTask(taskId);
    expect(task.status).toBe('completed');
    expect(task.result).toContain('spawn-codex run');
    expect(task.result).toContain(result.outputPath);
    expect(task.completed_at).toBeTruthy();
  });

  it('failed async run transitions the originating bus task to blocked with reason', async () => {
    makeFakeCodex('#!/usr/bin/env bash\nprintf "boom\\n" >&2\nexit 7\n');
    const { prompt, agentsRoot } = makePrompt();
    const taskId = 'task_lifecycle_failure_001';
    writeTask(taskId);

    const result = await spawnCodexAsync(prompt, {
      agentsRoot,
      agentName: 'codex',
      taskId,
      timeout: 5,
    });
    expect(result.ok).toBe(false);

    const task = readTask(taskId);
    expect(task.status).toBe('blocked');
    expect(task.meta?.blocker?.blocker_reason).toContain('spawn-codex run');
    expect(task.meta?.blocker?.blocker_reason).toContain('exit 7');
    expect(task.meta?.blocker?.next_proof_required).toBeTruthy();
  });

  it('synthetic cron:<agent>:<name> task ids are skipped (no real task to update)', async () => {
    makeFakeCodex('#!/usr/bin/env bash\nprintf "fake codex ok\\n"\n');
    const { prompt, agentsRoot } = makePrompt();

    // No real task on disk for the synthetic id — lifecycle MUST be a no-op
    // (not throw) on the well-known cron:<agent>:<name> marker shape.
    const result = await spawnCodexAsync(prompt, {
      agentsRoot,
      agentName: 'codex',
      taskId: 'cron:codex:probe-loop',
      timeout: 5,
    });
    expect(result.ok).toBe(true);
    expect(result.metadata.task_id).toBe('cron:codex:probe-loop');
  });

  it('async run without taskId leaves the bus task system untouched', async () => {
    makeFakeCodex('#!/usr/bin/env bash\nprintf "fake codex ok\\n"\n');
    const { prompt, agentsRoot } = makePrompt();
    const result = await spawnCodexAsync(prompt, {
      agentsRoot,
      agentName: 'codex',
      timeout: 5,
    });
    expect(result.ok).toBe(true);
    expect(result.metadata.task_id).toBeNull();
  });

  it('taskAutoComplete=false disables the lifecycle even when taskId is set', async () => {
    makeFakeCodex('#!/usr/bin/env bash\nprintf "fake codex ok\\n"\n');
    const { prompt, agentsRoot } = makePrompt();
    const taskId = 'task_lifecycle_optout_001';
    writeTask(taskId);

    const result = await spawnCodexAsync(prompt, {
      agentsRoot,
      agentName: 'codex',
      taskId,
      taskAutoComplete: false,
      timeout: 5,
    });
    expect(result.ok).toBe(true);

    const task = readTask(taskId);
    expect(task.status).toBe('in_progress'); // unchanged
    expect(task.completed_at).toBeNull();
  });

  it('already-completed task is not re-stamped (idempotent)', async () => {
    makeFakeCodex('#!/usr/bin/env bash\nprintf "fake codex ok\\n"\n');
    const { prompt, agentsRoot } = makePrompt();
    const taskId = 'task_lifecycle_already_done_001';
    writeTask(taskId, { status: 'completed' });
    const before = readTask(taskId);

    await spawnCodexAsync(prompt, {
      agentsRoot,
      agentName: 'codex',
      taskId,
      timeout: 5,
    });

    const after = readTask(taskId);
    expect(after.status).toBe('completed');
    expect(after.updated_at).toBe(before.updated_at); // not re-stamped
  });
});

// spawnCodex (sync, CLI path) opts OUT of the auto-lifecycle by default to
// avoid double-writing what the CLI shim's bestEffortTaskStatus already does.
describe('spawnCodex — CLI path defaults to no auto-lifecycle (CLI owns it)', () => {
  let homeOverride: string;
  let prevHome: string | undefined;
  let prevInstance: string | undefined;
  let prevOrg: string | undefined;
  let prevAgent: string | undefined;
  let taskDir: string;

  beforeEach(() => {
    homeOverride = mkdtempSync(join(tmpdir(), 'spawn-codex-home-sync-'));
    prevHome = process.env.HOME;
    prevInstance = process.env.CTX_INSTANCE_ID;
    prevOrg = process.env.CTX_ORG;
    prevAgent = process.env.CTX_AGENT_NAME;
    process.env.HOME = homeOverride;
    process.env.CTX_INSTANCE_ID = 'default';
    process.env.CTX_ORG = 'test-org';
    process.env.CTX_AGENT_NAME = 'codex';
    taskDir = join(homeOverride, '.cortextos', 'default', 'orgs', 'test-org', 'tasks');
    mkdirSync(taskDir, { recursive: true });
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevInstance === undefined) delete process.env.CTX_INSTANCE_ID; else process.env.CTX_INSTANCE_ID = prevInstance;
    if (prevOrg === undefined) delete process.env.CTX_ORG; else process.env.CTX_ORG = prevOrg;
    if (prevAgent === undefined) delete process.env.CTX_AGENT_NAME; else process.env.CTX_AGENT_NAME = prevAgent;
    try { rmSync(homeOverride, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('default sync call does NOT auto-complete (CLI shim owns the status flip)', () => {
    makeFakeCodex('#!/usr/bin/env bash\nprintf "fake codex ok\\n"\n');
    const { prompt, agentsRoot } = makePrompt();
    const taskId = 'task_sync_default_optout_001';
    writeFileSync(join(taskDir, `${taskId}.json`), JSON.stringify({
      id: taskId, title: 't', description: '', type: 'agent', needs_approval: false,
      status: 'in_progress', assigned_to: 'codex', created_by: 'orchestrator', org: 'test-org',
      priority: 'normal', project: '', kpi_key: null,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      completed_at: null, due_date: null, archived: false, meta: { cost_snapshot_start: 0 },
    }));

    const result = spawnCodex(prompt, { agentsRoot, agentName: 'codex', taskId, timeout: 5 });
    expect(result.ok).toBe(true);

    const after = JSON.parse(readFileSync(join(taskDir, `${taskId}.json`), 'utf-8'));
    expect(after.status).toBe('in_progress'); // CLI shim, not library, owns this
  });

  it('explicit taskAutoComplete=true on sync call DOES close the task', () => {
    makeFakeCodex('#!/usr/bin/env bash\nprintf "fake codex ok\\n"\n');
    const { prompt, agentsRoot } = makePrompt();
    const taskId = 'task_sync_optin_001';
    writeFileSync(join(taskDir, `${taskId}.json`), JSON.stringify({
      id: taskId, title: 't', description: '', type: 'agent', needs_approval: false,
      status: 'in_progress', assigned_to: 'codex', created_by: 'orchestrator', org: 'test-org',
      priority: 'normal', project: '', kpi_key: null,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      completed_at: null, due_date: null, archived: false, meta: { cost_snapshot_start: 0 },
    }));

    const result = spawnCodex(prompt, { agentsRoot, agentName: 'codex', taskId, taskAutoComplete: true, timeout: 5 });
    expect(result.ok).toBe(true);

    const after = JSON.parse(readFileSync(join(taskDir, `${taskId}.json`), 'utf-8'));
    expect(after.status).toBe('completed');
  });
});
