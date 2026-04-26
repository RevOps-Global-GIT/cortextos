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

import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { Task, InboxMessage } from '../types/index.js';

// ---------------------------------------------------------------------------
// UUIDv5 — deterministic UUID from bus ID (RFC 4122 §4.3, stdlib only)
// ---------------------------------------------------------------------------

// Fixed namespace (RFC 4122 DNS namespace — arbitrary but constant)
const UUID_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function nsBytes(): Buffer {
  return Buffer.from(UUID_NAMESPACE.replace(/-/g, ''), 'hex');
}

export function uuidv5(name: string): string {
  const hash = createHash('sha1')
    .update(nsBytes())
    .update(Buffer.from(name, 'utf-8'))
    .digest();
  // Take first 16 bytes, set version (5) and variant (RFC 4122) bits
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const h = hash.slice(0, 16).toString('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;
}

export function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

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
  // Transparently migrate any pre-v5 entries before attempting upsert
  migrateRetryQueueIds();
  // Remap raw bus constraint values (priority=normal, status=pending, etc.)
  migrateRetryQueueConstraints();
  // Convert raw bus IDs in reply_to_id to UUIDv5
  migrateRetryQueueReplyToId();
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
// One-shot migration: remap raw bus constraint values in the retry queue
// ---------------------------------------------------------------------------

// Valid RGOS enum values — anything outside these sets needs remapping.
const RGOS_VALID_PRIORITIES = new Set(['low', 'medium', 'high']);
const RGOS_VALID_STATUSES = new Set(['proposed', 'approved', 'in_progress', 'completed', 'cancelled', 'blocked', 'review']);

/**
 * Migrates any orch_tasks retry queue entries whose priority or status still
 * carry raw bus values (e.g. priority="normal", status="pending") that RGOS
 * rejects with a constraint violation.  Idempotent — entries already holding
 * valid RGOS enum values are untouched.
 *
 * Called automatically at the start of drainRetryQueue alongside
 * migrateRetryQueueIds so stale queued entries are transparently upgraded
 * before the next upsert attempt.
 */
export function migrateRetryQueueConstraints(): void {
  const qPath = retryQueuePath();
  if (!qPath) return;
  const entries = readRetryQueue(qPath);
  if (entries.length === 0) return;

  let changed = false;
  const migrated = entries.map(entry => {
    if (entry.table !== 'orch_tasks') return entry;

    const priority = entry.row.priority as string | undefined;
    const status = entry.row.status as string | undefined;

    const needsPriority = priority !== undefined && !RGOS_VALID_PRIORITIES.has(priority);
    const needsStatus = status !== undefined && !RGOS_VALID_STATUSES.has(status);

    if (!needsPriority && !needsStatus) return entry;

    changed = true;
    const newRow = { ...entry.row };
    if (needsPriority) newRow.priority = mapPriority(priority!);
    if (needsStatus) newRow.status = mapStatus(status!);
    return { ...entry, row: newRow };
  });

  if (!changed) return;

  try {
    writeFileSync(
      qPath,
      migrated.map(e => JSON.stringify(e)).join('\n') + '\n',
      { encoding: 'utf-8', mode: 0o600 },
    );
  } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// One-shot migration: rewrite old bus-format IDs in the retry queue to UUIDv5
// ---------------------------------------------------------------------------

/**
 * Migrates any retry queue entries that still carry raw bus IDs (non-UUID) in
 * their row.id field.  Idempotent — entries already holding a UUID are skipped.
 * Adds bus_task_id / bus_message_id to metadata/payload so the original bus ID
 * is not lost.
 *
 * Called automatically at the start of drainRetryQueue so old queued entries
 * are transparently upgraded before the next upsert attempt.
 */
export function migrateRetryQueueIds(): void {
  const qPath = retryQueuePath();
  if (!qPath) return;
  const entries = readRetryQueue(qPath);
  if (entries.length === 0) return;

  let changed = false;
  const migrated = entries.map(entry => {
    const id = entry.row.id as string | undefined;
    if (!id || isUuid(id)) return entry; // already a UUID or missing — skip

    changed = true;
    const newId = uuidv5(id);
    const newRow = { ...entry.row, id: newId } as Record<string, unknown>;

    if (entry.table === 'orch_tasks') {
      const meta = (newRow['metadata'] as Record<string, unknown> | undefined) ?? {};
      newRow['metadata'] = { bus_task_id: id, ...meta };
    } else {
      // cortex_messages: bus_message_id goes in payload
      const payload = (newRow['payload'] as Record<string, unknown> | undefined) ?? {};
      newRow['payload'] = { bus_message_id: id, ...payload };
    }

    return { ...entry, row: newRow };
  });

  if (!changed) return;

  try {
    writeFileSync(
      qPath,
      migrated.map(e => JSON.stringify(e)).join('\n') + '\n',
      { encoding: 'utf-8', mode: 0o600 },
    );
  } catch { /* best-effort */ }
}

/**
 * Migrates cortex_messages retry entries whose reply_to_id is a raw bus ID
 * (non-UUID) to UUIDv5, matching buildMessageRow's behavior.
 * Idempotent — entries with UUID or null reply_to_id are untouched.
 */
export function migrateRetryQueueReplyToId(): void {
  const qPath = retryQueuePath();
  if (!qPath) return;
  const entries = readRetryQueue(qPath);
  if (entries.length === 0) return;

  let changed = false;
  const migrated = entries.map(entry => {
    if (entry.table !== 'cortex_messages') return entry;
    const replyToId = entry.row.reply_to_id as string | null | undefined;
    if (!replyToId || isUuid(replyToId)) return entry; // already UUID or null — skip

    changed = true;
    return { ...entry, row: { ...entry.row, reply_to_id: uuidv5(replyToId) } };
  });

  if (!changed) return;

  try {
    writeFileSync(
      qPath,
      migrated.map(e => JSON.stringify(e)).join('\n') + '\n',
      { encoding: 'utf-8', mode: 0o600 },
    );
  } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Constraint maps — translate bus values to RGOS enum values
// ---------------------------------------------------------------------------

// RGOS orch_tasks.priority accepts: low | medium | high
const PRIORITY_MAP: Record<string, string> = {
  low: 'low',
  normal: 'medium',
  high: 'high',
  urgent: 'high',
};

// RGOS orch_tasks.status accepts: proposed | approved | in_progress | completed | cancelled | blocked | review
const STATUS_MAP: Record<string, string> = {
  pending: 'approved',
  in_progress: 'in_progress',
  completed: 'completed',
  cancelled: 'cancelled',
  blocked: 'blocked',
  review: 'review',
};

export function mapPriority(p: string): string {
  return PRIORITY_MAP[p] ?? 'medium';
}

export function mapStatus(s: string): string {
  return STATUS_MAP[s] ?? 'approved';
}

// ---------------------------------------------------------------------------
// Payload builders
// ---------------------------------------------------------------------------

export function buildTaskRow(task: Task): Record<string, unknown> {
  return {
    id: uuidv5(task.id),
    org_id: ORG_ID,
    title: task.title,
    description: task.description || null,
    status: mapStatus(task.status),
    priority: mapPriority(task.priority),
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
      bus_task_id: task.id,
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
    id: uuidv5(msg.id),
    org_id: ORG_ID,
    from_agent: msg.from,
    to_agent: msg.to,
    message_type: 'agent_message',
    subject: null,
    body: msg.text,
    payload: {
      bus_message_id: msg.id,
      priority: msg.priority,
      ...(msg.trace_id ? { trace_id: msg.trace_id } : {}),
    },
    thread_id: msg.trace_id ?? null,
    reply_to_id: msg.reply_to ? uuidv5(msg.reply_to) : null,
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
