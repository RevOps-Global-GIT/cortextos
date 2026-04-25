/**
 * rgos-mirror — fire-and-forget Supabase mirror for task and message writes.
 *
 * Called from createTask, updateTask, completeTask (task.ts) and
 * sendMessage (message.ts) after the local atomicWriteSync succeeds.
 * Never awaited by callers; a failing push goes to a local JSONL retry queue
 * and is drained asynchronously on the next successful write.
 *
 * Auth: SUPABASE_RGOS_SERVICE_KEY (service role JWT) + direct PostgREST.
 * Pattern matches analyst/prototype/sync_activity_to_supabase.py.
 *
 * Kill switch: BUS_RGOS_MIRROR_DISABLED=1 → immediate no-op.
 * Also no-ops when SUPABASE_RGOS_URL or SUPABASE_RGOS_SERVICE_KEY are absent.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { Task, InboxMessage } from '../types/index.js';

const ORG_ID = '00000000-0000-0000-0000-000000000001';
const RETRY_MAX = 500;
const MIRROR_SOURCE = 'cortextos_bus_mirror';

// Module-level drain lock — prevents parallel drain loops from stacking.
let draining = false;

// ---------------------------------------------------------------------------
// Kill switch + env checks
// ---------------------------------------------------------------------------

export function isEnabled(): boolean {
  if (process.env.BUS_RGOS_MIRROR_DISABLED === '1') return false;
  if (!process.env.SUPABASE_RGOS_URL) return false;
  if (!process.env.SUPABASE_RGOS_SERVICE_KEY) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Retry queue helpers
// ---------------------------------------------------------------------------

export interface RetryEntry {
  table: 'orch_tasks' | 'cortex_messages';
  row: Record<string, unknown>;
  ts: string;
}

export function retryQueuePath(): string | null {
  const ctxRoot = process.env.CTX_ROOT;
  const agentName = process.env.CTX_AGENT_NAME || process.env.CORTEXTOS_AGENT_NAME;
  if (!ctxRoot || !agentName) return null;
  return join(ctxRoot, 'state', agentName, 'mirror-retry.jsonl');
}

export function readRetryQueue(qPath: string): RetryEntry[] {
  if (!existsSync(qPath)) return [];
  try {
    return readFileSync(qPath, 'utf-8')
      .split('\n')
      .filter(l => l.trim())
      .map(l => JSON.parse(l) as RetryEntry);
  } catch {
    return [];
  }
}

export function enqueueRetry(entry: RetryEntry): void {
  const qPath = retryQueuePath();
  if (!qPath) return;
  try {
    mkdirSync(join(qPath, '..'), { recursive: true });
    const existing = readRetryQueue(qPath);
    existing.push(entry);
    // FIFO eviction: drop oldest entries if over cap
    const trimmed = existing.length > RETRY_MAX
      ? existing.slice(existing.length - RETRY_MAX)
      : existing;
    writeFileSync(qPath, trimmed.map(e => JSON.stringify(e)).join('\n') + '\n', {
      encoding: 'utf-8',
      mode: 0o600,
    });
  } catch {
    // Best-effort: never crash the caller over a retry queue write failure
  }
}

function clearRetryQueue(qPath: string): void {
  try {
    writeFileSync(qPath, '', { encoding: 'utf-8', mode: 0o600 });
  } catch {
    // Best-effort
  }
}

// ---------------------------------------------------------------------------
// PostgREST upsert
// ---------------------------------------------------------------------------

async function postgrestUpsert(
  table: 'orch_tasks' | 'cortex_messages',
  row: Record<string, unknown>,
): Promise<void> {
  const url = process.env.SUPABASE_RGOS_URL!;
  const serviceKey = process.env.SUPABASE_RGOS_SERVICE_KEY!;
  const endpoint = `${url}/rest/v1/${table}`;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'apikey': serviceKey,
      'Authorization': `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates',
    },
    body: JSON.stringify(row),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`PostgREST ${table} upsert failed ${res.status}: ${body.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// Retry drain (async, module-level concurrency lock)
// ---------------------------------------------------------------------------

export async function drainRetryQueue(): Promise<void> {
  if (draining) return; // Concurrency guard: only one drain loop at a time
  const qPath = retryQueuePath();
  if (!qPath) return;
  const entries = readRetryQueue(qPath);
  if (entries.length === 0) return;

  draining = true;
  try {
    const failed: RetryEntry[] = [];
    for (const entry of entries) {
      try {
        await postgrestUpsert(entry.table, entry.row);
      } catch {
        failed.push(entry);
      }
    }
    if (failed.length === 0) {
      clearRetryQueue(qPath);
    } else {
      try {
        writeFileSync(
          qPath,
          failed.map(e => JSON.stringify(e)).join('\n') + '\n',
          { encoding: 'utf-8', mode: 0o600 },
        );
      } catch { /* best-effort */ }
    }
  } finally {
    draining = false;
  }
}

// Reset the drain lock — exported for tests only
export function _resetDrainLock(): void {
  draining = false;
}

// ---------------------------------------------------------------------------
// Payload builders
// ---------------------------------------------------------------------------

export function buildTaskRow(task: Task): Record<string, unknown> {
  return {
    id: task.id,
    org_id: ORG_ID,
    title: task.title,
    description: task.description || null,
    status: task.status,
    priority: task.priority,
    assigned_to: task.assigned_to,
    created_by: task.created_by,
    parent_task_id: null,
    result: task.result ?? null,
    result_links: null,
    goal_ancestry: null,
    tokens_cost: null,
    created_at: task.created_at,
    updated_at: task.updated_at,
    completed_at: task.completed_at ?? null,
    due_date: task.due_date ?? null,
    project_id: null,
    metadata: {
      org: task.org,
      project: task.project || null,
      meta: task.meta ?? null,
      blocked_by: task.blocked_by ?? [],
      blocks: task.blocks ?? [],
      kpi_key: task.kpi_key,
      type: task.type,
      needs_approval: task.needs_approval,
    },
    source: MIRROR_SOURCE,
    source_thread_ref: null,
  };
}

export function buildMessageRow(msg: InboxMessage): Record<string, unknown> {
  return {
    id: msg.id,
    org_id: ORG_ID,
    from_agent: msg.from,
    to_agent: msg.to,
    message_type: 'agent_message',
    subject: null,
    body: msg.text,
    payload: {
      priority: msg.priority,
      ...(msg.trace_id ? { trace_id: msg.trace_id } : {}),
    },
    thread_id: msg.trace_id ?? null,
    reply_to_id: msg.reply_to ?? null,
    read_at: null,
    created_at: msg.timestamp,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Mirror a task write to Supabase orch_tasks. Fire-and-forget — never awaited
 * by callers. Failures queue to JSONL retry, drained on next success.
 */
export async function mirrorTaskToRgos(
  task: Task,
  _event: 'create' | 'update' | 'complete',
): Promise<void> {
  if (!isEnabled()) return;
  const row = buildTaskRow(task);
  try {
    await postgrestUpsert('orch_tasks', row);
    // Async drain: never await, never block the write path
    setImmediate(() => drainRetryQueue().catch(() => undefined));
  } catch {
    enqueueRetry({ table: 'orch_tasks', row, ts: new Date().toISOString() });
  }
}

/**
 * Mirror a message write to Supabase cortex_messages. Fire-and-forget.
 */
export async function mirrorMessageToRgos(msg: InboxMessage): Promise<void> {
  if (!isEnabled()) return;
  const row = buildMessageRow(msg);
  try {
    await postgrestUpsert('cortex_messages', row);
    setImmediate(() => drainRetryQueue().catch(() => undefined));
  } catch {
    enqueueRetry({ table: 'cortex_messages', row, ts: new Date().toISOString() });
  }
}
