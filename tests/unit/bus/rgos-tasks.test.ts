import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { makeBusPaths, makeTempDir } from '../../setup';
import { importApprovedRgosTasks, importRgosTaskById, readImportedRgosTask, reconcileCompletedRgosTasks } from '../../../src/bus/rgos-tasks';

describe('rgos-tasks import helpers', () => {
  let tmpDir: string;
  let oldEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmpDir = makeTempDir('rgos-tasks-test-');
    oldEnv = { ...process.env };
    process.env.SUPABASE_RGOS_URL = 'https://rgos.example.test';
    process.env.SUPABASE_RGOS_SERVICE_KEY = 'service-key';
    process.env.CTX_ORG = 'revops-global';
  });

  afterEach(() => {
    process.env = oldEnv;
    vi.unstubAllGlobals();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('imports approved Supabase backlog rows as local pending bus tasks', async () => {
    const paths = makeBusPaths(tmpDir, 'codex');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{
        id: 'abc39b97-96f6-410a-87a6-fa4ead610d0e',
        title: 'Fully validate Live Activity Surface end-to-end',
        description: 'Inspect current RGOS/AgentOps Live Activity surface.',
        status: 'approved',
        priority: 'high',
        assigned_to: 'codex',
        created_by: 'orchestrator',
        created_at: '2026-05-26T17:08:00Z',
        updated_at: '2026-05-26T17:08:00Z',
      }],
    }));

    const result = await importApprovedRgosTasks(paths, { agent: 'codex' });

    expect(result).toEqual({ imported: 1, skipped: 0, rows: 1 });
    const task = readImportedRgosTask(paths, 'abc39b97-96f6-410a-87a6-fa4ead610d0e');
    expect(task?.status).toBe('pending');
    expect(task?.assigned_to).toBe('codex');
    expect(task?.priority).toBe('high');
    expect(task?.meta?.rgos).toMatchObject({
      source: 'supabase_orch_tasks',
      supabase_status: 'approved',
    });
  });

  it('imports a single approved UUID task so claim-task can operate locally', async () => {
    const paths = makeBusPaths(tmpDir, 'codex');
    const id = '5253f733-da6a-4491-8f22-618cedb56a19';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{
        id,
        title: 'Fix false Orgo VM Exec capability warning',
        status: 'approved',
        priority: 'medium',
        assigned_to: 'codex',
        created_at: '2026-05-26T14:48:00Z',
        updated_at: '2026-05-26T14:48:00Z',
      }],
    }));

    await expect(importRgosTaskById(paths, id, 'codex')).resolves.toBe(true);
    expect(existsSync(join(paths.taskDir, `${id}.json`))).toBe(true);
    const task = JSON.parse(readFileSync(join(paths.taskDir, `${id}.json`), 'utf-8'));
    expect(task.status).toBe('pending');
    expect(task.priority).toBe('normal');
  });

  it('rejects importing a task assigned to another agent for claim', async () => {
    const paths = makeBusPaths(tmpDir, 'codex');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{
        id: '5253f733-da6a-4491-8f22-618cedb56a19',
        title: 'Other owner task',
        status: 'approved',
        assigned_to: 'dev',
      }],
    }));

    await expect(importRgosTaskById(paths, '5253f733-da6a-4491-8f22-618cedb56a19', 'codex'))
      .rejects.toThrow(/assigned to dev, not codex/);
  });

  it('reconciles completed RGOS rows back to pending local bus twins', async () => {
    const paths = makeBusPaths(tmpDir, 'codex');
    mkdirSync(paths.taskDir, { recursive: true });
    const busTaskId = 'task_1781197912707_47270437';
    writeFileSync(join(paths.taskDir, `${busTaskId}.json`), JSON.stringify({
      id: busTaskId,
      title: 'Local twin left pending',
      description: '',
      type: 'agent',
      needs_approval: false,
      status: 'pending',
      assigned_to: 'codex',
      created_by: 'orchestrator',
      org: 'revops-global',
      priority: 'normal',
      project: '',
      kpi_key: null,
      created_at: '2026-06-12T03:00:00Z',
      updated_at: '2026-06-12T03:00:00Z',
      completed_at: null,
      due_date: null,
      archived: false,
    }), 'utf-8');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{
        id: 'ac3bb605-c9ba-4510-8f7e-18288f90cbd8',
        title: 'Local twin left pending',
        status: 'completed',
        assigned_to: 'codex',
        result: 'Completed from RGOS',
        updated_at: '2026-06-12T03:30:00Z',
        completed_at: '2026-06-12T03:30:00Z',
        metadata: { bus_task_id: busTaskId },
      }],
    }));

    const result = await reconcileCompletedRgosTasks(paths, { agent: 'codex' });

    expect(result).toEqual({ reconciled: 1, skipped: 0, rows: 1 });
    const task = JSON.parse(readFileSync(join(paths.taskDir, `${busTaskId}.json`), 'utf-8'));
    expect(task.status).toBe('completed');
    expect(task.completed_at).toBe('2026-06-12T03:30:00Z');
    expect(task.result).toBe('Completed from RGOS');
    expect(task.meta.rgos).toMatchObject({
      source: 'supabase_orch_tasks',
      supabase_status: 'completed',
      supabase_task_id: 'ac3bb605-c9ba-4510-8f7e-18288f90cbd8',
    });
    expect(existsSync(join(paths.taskDir, 'ac3bb605-c9ba-4510-8f7e-18288f90cbd8.json'))).toBe(false);
  });
});
