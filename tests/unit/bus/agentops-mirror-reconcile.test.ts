import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { reconcileAgentOpsMirror } from '../../../src/bus/agentops-mirror-reconcile.js';
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
      expect.objectContaining({ kind: 'agent_active', id: 'cortextos-codex', live: true, mirror: false }),
    ]));
  });
});
