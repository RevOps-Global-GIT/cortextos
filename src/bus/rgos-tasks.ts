import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { BusPaths, Priority, Task, TaskStatus } from '../types/index.js';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { withRetry, isTransientError } from '../utils/retry.js';

interface RgosTaskRow {
  id: string;
  title: string;
  description?: string | null;
  status?: string | null;
  priority?: string | null;
  assigned_to?: string | null;
  created_by?: string | null;
  result?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  completed_at?: string | null;
  due_date?: string | null;
  blocked_by?: string[] | null;
  goal_ancestry?: unknown;
}

export interface RgosTaskImportResult {
  imported: number;
  skipped: number;
  rows: number;
  reason?: string;
}

function supabaseConfig(): { url: string; key: string } | null {
  const url = (process.env.SUPABASE_RGOS_URL || process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = process.env.SUPABASE_RGOS_SERVICE_KEY || process.env.RGOS_SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key || process.env.BUS_RGOS_MIRROR_DISABLED === '1') return null;
  return { url, key };
}

function mapRgosPriority(value: string | null | undefined): Priority {
  if (value === 'low') return 'low';
  if (value === 'high') return 'high';
  return 'normal';
}

function mapRgosStatus(value: string | null | undefined): TaskStatus {
  if (value === 'in_progress' || value === 'completed' || value === 'blocked' || value === 'cancelled') return value;
  return 'pending';
}

function taskPath(paths: BusPaths, id: string): string {
  return join(paths.taskDir, `${id}.json`);
}

function taskExists(paths: BusPaths, id: string): boolean {
  return existsSync(taskPath(paths, id));
}

function materializeRow(paths: BusPaths, row: RgosTaskRow, agent?: string): boolean {
  if (!row.id || taskExists(paths, row.id)) return false;
  const now = new Date().toISOString();
  const createdAt = row.created_at || now;
  const updatedAt = row.updated_at || createdAt;
  const task: Task = {
    id: row.id,
    title: row.title || row.id,
    description: row.description || '',
    type: 'agent',
    needs_approval: false,
    status: mapRgosStatus(row.status),
    assigned_to: row.assigned_to || agent || '',
    created_by: row.created_by || 'rgos',
    org: process.env.CTX_ORG || 'revops-global',
    priority: mapRgosPriority(row.priority),
    project: '',
    kpi_key: null,
    created_at: createdAt,
    updated_at: updatedAt,
    completed_at: row.completed_at || null,
    due_date: row.due_date || null,
    archived: false,
    result: row.result || undefined,
    blocked_by: Array.isArray(row.blocked_by) ? row.blocked_by : undefined,
    meta: {
      rgos: {
        imported_at: now,
        source: 'supabase_orch_tasks',
        supabase_status: row.status || null,
        goal_ancestry: row.goal_ancestry ?? null,
      },
    },
  };
  ensureDir(paths.taskDir);
  atomicWriteSync(taskPath(paths, row.id), JSON.stringify(task));
  return true;
}

async function fetchRows(endpoint: string, config: { url: string; key: string }): Promise<RgosTaskRow[]> {
  const res = await withRetry(
    () => fetch(endpoint, {
      headers: {
        apikey: config.key,
        Authorization: `Bearer ${config.key}`,
      },
      signal: AbortSignal.timeout(15_000),
    }),
    {
      maxAttempts: 3,
      baseDelayMs: 500,
      maxDelayMs: 10_000,
      isRetryable: isTransientError,
    },
  );
  if (!res.ok) {
    throw new Error(`RGOS orch_tasks fetch failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  return await res.json() as RgosTaskRow[];
}

const TASK_SELECT = 'id,title,description,status,priority,assigned_to,created_by,result,created_at,updated_at,completed_at,due_date,blocked_by,goal_ancestry';

export async function importApprovedRgosTasks(paths: BusPaths, options: { agent?: string; limit?: number } = {}): Promise<RgosTaskImportResult> {
  const config = supabaseConfig();
  if (!config) return { imported: 0, skipped: 0, rows: 0, reason: 'supabase_not_configured' };
  const params = new URLSearchParams({
    status: 'eq.approved',
    select: TASK_SELECT,
    order: 'created_at.desc',
    limit: String(options.limit ?? 200),
  });
  if (options.agent) params.set('assigned_to', `eq.${options.agent}`);
  const rows = await fetchRows(`${config.url}/rest/v1/orch_tasks?${params.toString()}`, config);
  let imported = 0;
  let skipped = 0;
  for (const row of rows) {
    if (materializeRow(paths, row, options.agent)) imported++;
    else skipped++;
  }
  return { imported, skipped, rows: rows.length };
}

export async function importRgosTaskById(paths: BusPaths, id: string, agent?: string): Promise<boolean> {
  if (taskExists(paths, id)) return true;
  const config = supabaseConfig();
  if (!config) return false;
  const params = new URLSearchParams({
    id: `eq.${id}`,
    select: TASK_SELECT,
    limit: '1',
  });
  const rows = await fetchRows(`${config.url}/rest/v1/orch_tasks?${params.toString()}`, config);
  if (rows.length === 0) return false;
  const row = rows[0];
  if (agent && row.assigned_to && row.assigned_to !== agent) {
    throw new Error(`RGOS task ${id} is assigned to ${row.assigned_to}, not ${agent}`);
  }
  if (row.status && !['approved', 'proposed'].includes(row.status)) {
    throw new Error(`RGOS task ${id} is ${row.status}, not approved/proposed; cannot import for claim`);
  }
  materializeRow(paths, row, agent);
  return true;
}

export function readImportedRgosTask(paths: BusPaths, id: string): Task | null {
  const file = taskPath(paths, id);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf-8')) as Task;
}
