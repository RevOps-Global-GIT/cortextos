import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { reconcileAgentOpsMirror, repairAgentOpsMirror } from '../../../src/bus/agentops-mirror-reconcile.js';
import { uuidv5 } from '../../../src/bus/rgos-mirror.js';
import type { BusPaths, Task } from '../../../src/types/index.js';

function makePaths(root: string): BusPaths {
  return {
    ctxRoot: root,
    inbox: join(root, 'inbox', 'codex'),
    inflight: join(root, 'inflight', 'codex'),
    processed: join(root, 'processed', 'codex'),
    logDir: join(root, 'logs', 'codex'),
    stateDir: join(root, 'state', 'codex'),
    taskDir: join(root, 'orgs', 'revops-global', 'tasks'),
    approvalDir: join(root, 'orgs', 'revops-global', 'approvals'),
    analyticsDir: join(root, 'orgs', 'revops-global', 'analytics'),
    deliverablesDir: join(root, 'orgs', 'revops-global', 'deliverables'),
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task_cancelled_001',
    title: 'Cancelled card should mirror',
    description: '',
    type: 'agent',
    needs_approval: false,
    status: 'cancelled',
    assigned_to: 'codex',
    created_by: 'orchestrator',
    org: 'revops-global',
    priority: 'high',
    project: '',
    kpi_key: null,
    created_at: '2026-06-03T10:00:00Z',
    updated_at: '2026-06-03T10:05:00Z',
    completed_at: null,
    due_date: null,
    archived: false,
    ...overrides,
  };
}

describe('reconcileAgentOpsMirror', () => {
  const originalUrl = process.env.SUPABASE_RGOS_URL;
  const originalKey = process.env.SUPABASE_RGOS_SERVICE_KEY;
  const originalFrameworkRoot = process.env.CTX_FRAMEWORK_ROOT;
  const originalCtxRoot = process.env.CTX_ROOT;
  let root: string;
  let paths: BusPaths;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalUrl === undefined) delete process.env.SUPABASE_RGOS_URL;
    else process.env.SUPABASE_RGOS_URL = originalUrl;
    if (originalKey === undefined) delete process.env.SUPABASE_RGOS_SERVICE_KEY;
    else process.env.SUPABASE_RGOS_SERVICE_KEY = originalKey;
    if (originalFrameworkRoot === undefined) delete process.env.CTX_FRAMEWORK_ROOT;
    else process.env.CTX_FRAMEWORK_ROOT = originalFrameworkRoot;
    if (originalCtxRoot === undefined) delete process.env.CTX_ROOT;
    else process.env.CTX_ROOT = originalCtxRoot;
    rmSync(root, { recursive: true, force: true });
  });

  it('detects cancelled task and stopped-agent drift against mirror rows', async () => {
    root = mkdtempSync(join(tmpdir(), 'agentops-reconcile-'));
    paths = makePaths(root);
    process.env.SUPABASE_RGOS_URL = 'https://test.supabase.co';
    process.env.SUPABASE_RGOS_SERVICE_KEY = 'test-service-key';
    process.env.CTX_FRAMEWORK_ROOT = root;

    mkdirSync(paths.taskDir, { recursive: true });
    const task = makeTask();
    writeFileSync(join(paths.taskDir, `${task.id}.json`), JSON.stringify(task), 'utf-8');

    mkdirSync(join(root, 'orgs', 'revops-global', 'agents', 'codex'), { recursive: true });
    mkdirSync(join(root, 'state', 'codex'), { recursive: true });
    writeFileSync(join(root, 'state', 'codex', 'heartbeat.json'), JSON.stringify({
      agent: 'codex',
      status: 'online',
      last_heartbeat: new Date().toISOString(),
    }), 'utf-8');

    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/rest/v1/orch_tasks')) {
        return {
          ok: true,
          json: async () => [{
            id: uuidv5(task.id),
            status: 'blocked',
            title: task.title,
            metadata: { bus_task_id: task.id },
          }],
        };
      }
      if (u.includes('/rest/v1/orch_agents')) {
        return {
          ok: true,
          json: async () => [{
            role_id: 'cortextos-codex',
            is_active: false,
          }],
        };
      }
      if (u.includes('/rest/v1/orch_agent_heartbeats')) {
        return { ok: true, json: async () => [] };
      }
      return { ok: true, json: async () => [] };
    }));

    const result = await reconcileAgentOpsMirror(paths, { org: 'revops-global' });

    expect(result.drift_count).toBe(2);
    expect(result.drifts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'task_status', id: task.id, live: 'cancelled', mirror: 'blocked' }),
      expect.objectContaining({
        kind: 'agent_active',
        id: 'cortextos-codex',
        live: true,
        mirror: expect.objectContaining({ is_active: false }),
      }),
    ]));
  });

  it('plans a dry-run repair without writing mirror rows and audits crons', async () => {
    root = mkdtempSync(join(tmpdir(), 'agentops-repair-dry-run-'));
    paths = makePaths(root);
    process.env.SUPABASE_RGOS_URL = 'https://test.supabase.co';
    process.env.SUPABASE_RGOS_SERVICE_KEY = 'test-service-key';
    process.env.CTX_FRAMEWORK_ROOT = root;
    process.env.CTX_ROOT = root;

    mkdirSync(paths.taskDir, { recursive: true });
    const task = makeTask({ status: 'in_progress' });
    writeFileSync(join(paths.taskDir, `${task.id}.json`), JSON.stringify(task), 'utf-8');

    mkdirSync(join(root, 'orgs', 'revops-global', 'agents', 'codex'), { recursive: true });
    mkdirSync(join(root, 'state', 'codex'), { recursive: true });
    writeFileSync(join(root, 'state', 'codex', 'heartbeat.json'), JSON.stringify({
      agent: 'codex',
      status: 'online',
      last_heartbeat: new Date().toISOString(),
    }), 'utf-8');

    mkdirSync(join(root, '.cortextOS', 'state', 'agents', 'codex'), { recursive: true });
    writeFileSync(join(root, '.cortextOS', 'state', 'agents', 'codex', 'crons.json'), JSON.stringify({
      updated_at: '2026-06-03T15:00:00Z',
      crons: [{
        name: 'heartbeat',
        prompt: 'heartbeat',
        schedule: '*/30 * * * *',
        enabled: true,
        created_at: '2026-06-03T15:00:00Z',
      }],
    }), 'utf-8');

    const writes: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method && init.method !== 'GET') writes.push(`${init.method} ${url}`);
      const u = String(url);
      if (u.includes('/rest/v1/orch_tasks')) {
        return { ok: true, json: async () => [] };
      }
      if (u.includes('/rest/v1/orch_agents')) {
        return { ok: true, json: async () => [] };
      }
      if (u.includes('/rest/v1/orch_agent_heartbeats')) {
        return { ok: true, json: async () => [] };
      }
      return { ok: true, json: async () => [] };
    }));

    const result = await repairAgentOpsMirror(paths, { org: 'revops-global', dryRun: true });

    expect(result.ok).toBe(true);
    expect(result.dry_run).toBe(true);
    expect(result.before.drift_count).toBe(2);
    expect(result.planned_tasks).toBe(1);
    expect(result.planned_agents).toBe(1);
    expect(result.repaired_tasks).toBe(0);
    expect(result.repaired_agents).toBe(0);
    expect(result.crons.live_crons).toBe(1);
    expect(result.crons.enabled_crons).toBe(1);
    expect(result.crons.note).toContain('enumerated only');
    expect(writes).toEqual([]);
  });

  it('does not recreate orch_agents rows for decommissioned source dirs', async () => {
    root = mkdtempSync(join(tmpdir(), 'agentops-decommissioned-agent-'));
    paths = makePaths(root);
    process.env.SUPABASE_RGOS_URL = 'https://test.supabase.co';
    process.env.SUPABASE_RGOS_SERVICE_KEY = 'test-service-key';
    process.env.CTX_FRAMEWORK_ROOT = root;
    process.env.CTX_ROOT = root;

    mkdirSync(paths.taskDir, { recursive: true });
    mkdirSync(join(root, 'config'), { recursive: true });
    writeFileSync(join(root, 'config', 'enabled-agents.json'), JSON.stringify({
      'orgo-1': {
        org: 'revops-global',
        enabled: false,
        decommissioned: true,
        status: 'deleted',
      },
    }), 'utf-8');
    mkdirSync(join(root, 'orgs', 'revops-global', 'agents', 'orgo-1'), { recursive: true });
    mkdirSync(join(root, 'state', 'orgo-1'), { recursive: true });
    writeFileSync(join(root, 'state', 'orgo-1', '.decommissioned'), JSON.stringify({
      agent: 'orgo-1',
      decommissioned_at: '2026-06-12T17:13:00Z',
      reason: 'retired',
    }), 'utf-8');

    const writes: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method && init.method !== 'GET') writes.push(`${init.method} ${url}`);
      return { ok: true, json: async () => [] };
    }));

    const result = await repairAgentOpsMirror(paths, { org: 'revops-global' });

    expect(result.ok).toBe(true);
    expect(result.before.live_agents).toBe(0);
    expect(result.before.drift_count).toBe(0);
    expect(result.planned_agents).toBe(0);
    expect(result.repaired_agents).toBe(0);
    expect(result.after?.drift_count).toBe(0);
    expect(writes).toEqual([]);
  });

  it('repairs task and agent mirror drift then reports the after count', async () => {
    root = mkdtempSync(join(tmpdir(), 'agentops-repair-'));
    paths = makePaths(root);
    process.env.SUPABASE_RGOS_URL = 'https://test.supabase.co';
    process.env.SUPABASE_RGOS_SERVICE_KEY = 'test-service-key';
    process.env.CTX_FRAMEWORK_ROOT = root;
    process.env.CTX_ROOT = root;

    mkdirSync(paths.taskDir, { recursive: true });
    const task = makeTask({ status: 'cancelled' });
    writeFileSync(join(paths.taskDir, `${task.id}.json`), JSON.stringify(task), 'utf-8');

    mkdirSync(join(root, 'orgs', 'revops-global', 'agents', 'codex'), { recursive: true });
    mkdirSync(join(root, 'state', 'codex'), { recursive: true });
    writeFileSync(join(root, 'state', 'codex', 'heartbeat.json'), JSON.stringify({
      agent: 'codex',
      status: 'online',
      last_heartbeat: new Date().toISOString(),
    }), 'utf-8');

    let taskMirrorStatus = 'blocked';
    let agentMirrorActive = false;
    const writes: string[] = [];

    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (init?.method && init.method !== 'GET') writes.push(`${init.method} ${u}`);

      if (u.includes('/rest/v1/orch_tasks') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body ?? '{}')) as { status?: string };
        taskMirrorStatus = body.status ?? taskMirrorStatus;
        return { ok: true, json: async () => [] };
      }
      if (u.includes('/rest/v1/orch_agents') && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body ?? '{}')) as { is_active?: boolean };
        agentMirrorActive = body.is_active ?? agentMirrorActive;
        return { ok: true, text: async () => '' };
      }
      if (u.includes('/realtime/v1/api/broadcast')) {
        return { ok: true, json: async () => [] };
      }
      if (u.includes('/rest/v1/orch_tasks') && u.includes('metadata-%3E%3Ebus_task_id')) {
        return {
          ok: true,
          json: async () => [{
            id: uuidv5(task.id),
            updated_at: '2026-06-03T10:05:00Z',
          }],
        };
      }
      if (u.includes('/rest/v1/orch_tasks')) {
        return {
          ok: true,
          json: async () => [{
            id: uuidv5(task.id),
            status: taskMirrorStatus,
            title: task.title,
            metadata: { bus_task_id: task.id },
          }],
        };
      }
      if (u.includes('/rest/v1/orch_agents')) {
        return {
          ok: true,
          json: async () => [{
            role_id: 'cortextos-codex',
            is_active: agentMirrorActive,
          }],
        };
      }
      if (u.includes('/rest/v1/orch_agent_heartbeats')) {
        return { ok: true, json: async () => [] };
      }
      return { ok: true, json: async () => [] };
    }));

    const result = await repairAgentOpsMirror(paths, { org: 'revops-global' });

    expect(result.ok).toBe(true);
    expect(result.before.drift_count).toBe(2);
    expect(result.after?.drift_count).toBe(0);
    expect(result.repaired_tasks).toBe(1);
    expect(result.repaired_agents).toBe(1);
    expect(result.failures).toEqual([]);
    expect(writes).toEqual(expect.arrayContaining([
      expect.stringContaining('POST https://test.supabase.co/rest/v1/orch_tasks'),
      expect.stringContaining('PATCH https://test.supabase.co/rest/v1/orch_agents'),
    ]));
  });
});
