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
  metadata?: Record<string, unknown> | null;
}

export interface RgosTaskImportResult {
  imported: number;
  skipped: number;
  rows: number;
  reason?: string;
}

export interface RgosTaskReconcileResult {
  reconciled: number;
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

function localTwinId(row: RgosTaskRow): string {
  const busTaskId = row.metadata?.bus_task_id;
  return typeof busTaskId === 'string' && busTaskId.trim() ? busTaskId : row.id;
}

function materializeRow(paths: BusPaths, row: RgosTaskRow, agent?: string): boolean {
  if (!row.id || taskExists(paths, row.id)) return false;
  // Skip if a local twin already exists under the original bus task ID.
  // Bus-mirror rows use a UUIDv5 row.id but store the original ID in metadata.bus_task_id;
  // the local file is named by bus_task_id, so taskExists(row.id) misses it.
  const twinId = localTwinId(row);
  if (twinId !== row.id && taskExists(paths, twinId)) return false;
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

const TASK_SELECT = 'id,title,description,status,priority,assigned_to,created_by,result,created_at,updated_at,completed_at,due_date,blocked_by,goal_ancestry,metadata';

export async function importApprovedRgosTasks(paths: BusPaths, options: { agent?: string; limit?: number } = {}): Promise<RgosTaskImportResult> {
  const config = supabaseConfig();
  if (!config) return { imported: 0, skipped: 0, rows: 0, reason: 'supabase_not_configured' };
  const params = new URLSearchParams({
    status: 'eq.approved',
    // Exclude CLI-sourced rows (Cowork session messages auto-created by the Claude
    // CLI that reach orch_tasks as approved cards but are not dispatchable tasks).
    source: 'neq.cli',
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

function reconcileCompletedRow(paths: BusPaths, row: RgosTaskRow): boolean {
  if (row.status !== 'completed') return false;
  const id = localTwinId(row);
  const file = taskPath(paths, id);
  if (!existsSync(file)) return false;

  const task = JSON.parse(readFileSync(file, 'utf-8')) as Task;
  if (task.status !== 'pending' && task.status !== 'in_progress') return false;

  const completedAt = row.completed_at || row.updated_at || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  task.status = 'completed';
  task.updated_at = completedAt;
  task.completed_at = completedAt;
  if (row.result) task.result = row.result;
  task.meta = {
    ...(task.meta ?? {}),
    rgos: {
      ...((task.meta?.rgos && typeof task.meta.rgos === 'object') ? task.meta.rgos as Record<string, unknown> : {}),
      reconciled_at: new Date().toISOString(),
      source: 'supabase_orch_tasks',
      supabase_status: row.status,
      supabase_task_id: row.id,
    },
  };
  atomicWriteSync(file, JSON.stringify(task));
  return true;
}

export async function reconcileCompletedRgosTasks(
  paths: BusPaths,
  options: { agent?: string; limit?: number } = {},
): Promise<RgosTaskReconcileResult> {
  const config = supabaseConfig();
  if (!config) return { reconciled: 0, skipped: 0, rows: 0, reason: 'supabase_not_configured' };
  const params = new URLSearchParams({
    status: 'eq.completed',
    select: TASK_SELECT,
    order: 'updated_at.desc',
    limit: String(options.limit ?? 200),
  });
  if (options.agent) params.set('assigned_to', `eq.${options.agent}`);
  const rows = await fetchRows(`${config.url}/rest/v1/orch_tasks?${params.toString()}`, config);
  let reconciled = 0;
  let skipped = 0;
  for (const row of rows) {
    if (reconcileCompletedRow(paths, row)) reconciled++;
    else skipped++;
  }
  return { reconciled, skipped, rows: rows.length };
}

/**
 * Fetch every orch_tasks row currently in_progress in RGOS (optionally scoped
 * to a single assignee). Used by the daemon's reconciliation tick to find
 * orphaned claims — RGOS-native (Pattern B) rows that an agent claimed and
 * then died holding, leaving the row stuck in_progress forever.
 *
 * Returns [] when Supabase is not configured (never throws on missing config),
 * matching importApprovedRgosTasks' fail-soft behavior.
 */
export async function fetchInProgressRgosTasks(
  options: { agent?: string; limit?: number } = {},
): Promise<Array<{ id: string; assigned_to: string | null; updated_at: string | null; title: string }>> {
  const config = supabaseConfig();
  if (!config) return [];
  const params = new URLSearchParams({
    status: 'eq.in_progress',
    select: 'id,title,assigned_to,updated_at',
    order: 'updated_at.asc',
    limit: String(options.limit ?? 200),
  });
  if (options.agent) params.set('assigned_to', `eq.${options.agent}`);
  const rows = await fetchRows(`${config.url}/rest/v1/orch_tasks?${params.toString()}`, config);
  return rows.map((row) => ({
    id: row.id,
    title: row.title || row.id,
    assigned_to: row.assigned_to ?? null,
    updated_at: row.updated_at ?? null,
  }));
}

/**
 * Reset a single orch_tasks row back to `approved` so the next rgos-task-poll
 * re-claims it. Deliberately does NOT clobber assigned_to — the next claim
 * reassigns it. `approved` is the correct claimable target (importApprovedRgosTasks
 * queries status=eq.approved).
 *
 * Returns false when Supabase is not configured or on any failure — never
 * throws, so a reconciliation tick or a handleExit hook can call it
 * fire-and-forget without risk of an unhandled rejection.
 */
export async function resetRgosTaskToApproved(id: string, note?: string): Promise<boolean> {
  const config = supabaseConfig();
  if (!config) return false;
  try {
    const res = await withRetry(
      () => fetch(`${config.url}/rest/v1/orch_tasks?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: {
          apikey: config.key,
          Authorization: `Bearer ${config.key}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({ status: 'approved' }),
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
      console.warn(`[rgos-tasks] resetRgosTaskToApproved(${id}) failed: HTTP ${res.status}${note ? ` (${note})` : ''}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[rgos-tasks] resetRgosTaskToApproved(${id}) error: ${err instanceof Error ? err.message : String(err)}${note ? ` (${note})` : ''}`);
    return false;
  }
}

export function readImportedRgosTask(paths: BusPaths, id: string): Task | null {
  const file = taskPath(paths, id);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf-8')) as Task;
}
