import { NextRequest } from 'next/server';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { getTaskById } from '@/lib/data/tasks';
import { db } from '@/lib/db';
import { getFrameworkRoot, getCTXRoot, CTX_INSTANCE_ID, CTX_ROOT_REAL } from '@/lib/config';
import { syncAll } from '@/lib/sync';
import type { TaskStatus } from '@/lib/types';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

// Dashboard reads both local bus tasks and RGOS-native task rows. The local
// bus status enum uses pending, while RGOS exposes proposed/approved.
const VALID_STATUSES: TaskStatus[] = [
  'proposed',
  'pending',
  'approved',
  'in_progress',
  'blocked',
  'completed',
  'cancelled',
];
const BUS_SCRIPT_STATUSES = new Set<TaskStatus>([
  'pending',
  'in_progress',
  'blocked',
  'completed',
  'cancelled',
]);
const DASHBOARD_DIRECT_STATUSES = new Set<TaskStatus>(['proposed', 'approved']);
const VALID_PRIORITIES = ['urgent', 'high', 'normal', 'low'];

// Reject IDs that look like path traversal attempts
function isValidId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

// Agent names must be lowercase alphanumeric + underscore/hyphen.
// Used to guard against path traversal and shell metacharacters before
// passing values into bus shell scripts as positional arguments.
function isValidAgentName(name: string): boolean {
  return typeof name === 'string' && /^[a-z0-9_-]+$/.test(name) && name.length <= 64;
}

// Cap free-text fields (note, outputSummary) to a safe upper bound before
// forwarding them as positional args to bus scripts.
const MAX_FREE_TEXT_LEN = 2000;
function capText(value: unknown, max = MAX_FREE_TEXT_LEN): string {
  return String(value ?? '').slice(0, max);
}

function nowIsoSeconds(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

async function updateTaskJsonStatus(sourceFile: string, status: TaskStatus, note?: string): Promise<void> {
  const fsPromises = await import('fs/promises');
  const raw = await fsPromises.default.readFile(sourceFile, 'utf-8');
  const taskData = JSON.parse(raw) as Record<string, unknown>;
  taskData.status = status;
  const now = nowIsoSeconds();
  taskData.updated_at = now;
  if (status === 'completed') taskData.completed_at = now;
  if (status !== 'completed' && taskData.completed_at) taskData.completed_at = null;
  if (note) taskData.notes = taskData.notes ? `${taskData.notes}\n${note}` : note;

  const tmp = `${sourceFile}.tmp`;
  await fsPromises.default.writeFile(tmp, JSON.stringify(taskData, null, 2) + '\n');
  await fsPromises.default.rename(tmp, sourceFile);
}

function patchCachedTaskStatus(id: string, status: TaskStatus, note?: string): void {
  const now = nowIsoSeconds();
  try {
    db.prepare(
      `UPDATE tasks
       SET status = ?, updated_at = ?, completed_at = CASE WHEN ? = 'completed' THEN ? WHEN completed_at IS NOT NULL THEN NULL ELSE completed_at END,
           notes = CASE WHEN ? IS NOT NULL AND ? != '' THEN COALESCE(notes || char(10) || ?, ?) ELSE notes END
       WHERE id = ?`,
    ).run(status, now, status, now, note ?? null, note ?? '', note ?? '', note ?? '', id);
  } catch {
    // The SQLite cache is best-effort; the source file or RGOS row remains authoritative.
  }
}

function rgosConfig(): { url: string; key: string } | null {
  const url = (process.env.SUPABASE_RGOS_URL || process.env.RGOS_SUPABASE_URL || process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key =
    process.env.SUPABASE_RGOS_SERVICE_KEY ||
    process.env.RGOS_SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    '';
  if (!url || !key || process.env.BUS_RGOS_MIRROR_DISABLED === '1') return null;
  return { url, key };
}

async function patchRgosTaskStatus(id: string, status: TaskStatus, outputSummary?: string, blockedBy?: string): Promise<boolean> {
  const config = rgosConfig();
  if (!config) return false;
  const now = nowIsoSeconds();
  const patch: Record<string, unknown> = {
    status,
    updated_at: now,
  };
  if (status === 'completed') {
    patch.completed_at = now;
    if (outputSummary) patch.result = capText(outputSummary);
  } else {
    patch.completed_at = null;
  }
  if (blockedBy) patch.blocked_by = [blockedBy];

  const patchBy = async (field: 'id' | 'metadata->>bus_task_id') => {
    const endpoint = new URL(`${config.url}/rest/v1/orch_tasks`);
    endpoint.searchParams.set('select', 'id');
    endpoint.searchParams.set(field, `eq.${id}`);
    const res = await fetch(endpoint.toString(), {
      method: 'PATCH',
      headers: {
        apikey: config.key,
        Authorization: `Bearer ${config.key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(patch),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`RGOS task patch failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    const rows = await res.json().catch(() => []) as Array<{ id?: string }>;
    return rows.length > 0;
  };

  if (await patchBy('id')) return true;
  return await patchBy('metadata->>bus_task_id');
}

// ---------------------------------------------------------------------------
// GET /api/tasks/[id] - Get a single task by ID
// ---------------------------------------------------------------------------

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  if (!isValidId(id)) {
    return Response.json({ error: 'Invalid task ID' }, { status: 400 });
  }

  try {
    const task = getTaskById(id);
    if (!task) {
      return Response.json({ error: 'Task not found' }, { status: 404 });
    }

    // Enrich with outputs from the source JSON file (outputs are not synced to SQLite)
    if (task.source_file && fs.existsSync(task.source_file)) {
      try {
        const raw = JSON.parse(fs.readFileSync(task.source_file, 'utf-8'));
        if (Array.isArray(raw.outputs)) {
          task.outputs = raw.outputs;
        }
      } catch { /* non-fatal — outputs are optional */ }
    }

    return Response.json(task, {
      headers: {
        'X-CortexOS-Instance': CTX_INSTANCE_ID,
        'X-CortexOS-Root': CTX_ROOT_REAL,
      },
    });
  } catch (err) {
    console.error('[api/tasks/[id]] GET error:', err);
    return Response.json({ error: 'Failed to fetch task' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/tasks/[id] - Delete a task
// ---------------------------------------------------------------------------

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  if (!isValidId(id)) {
    return Response.json({ error: 'Invalid task ID' }, { status: 400 });
  }

  const task = getTaskById(id);
  if (!task) {
    return Response.json({ error: 'Task not found' }, { status: 404 });
  }

  // Delete the task file directly
  const fs = await import('fs/promises');
  const path = await import('path');
  const ctxRoot = getCTXRoot();
  const taskDir = task.org
    ? path.default.join(ctxRoot, 'orgs', task.org, 'tasks')
    : path.default.join(ctxRoot, 'tasks');
  const taskFile = path.default.join(taskDir, `${id}.json`);

  try {
    await fs.default.unlink(taskFile);
    try { syncAll(); } catch { /* best-effort */ }
    return Response.json({ success: true });
  } catch (err) {
    console.error('[api/tasks/[id]] DELETE error:', err);
    return Response.json({ error: 'Failed to delete task' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// PUT /api/tasks/[id] - Edit task fields (title, description, assignee, priority)
// ---------------------------------------------------------------------------

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isValidId(id)) {
    return Response.json({ error: 'Invalid task ID' }, { status: 400 });
  }

  const task = getTaskById(id);
  if (!task) {
    return Response.json({ error: 'Task not found' }, { status: 404 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { title, description, assignee, priority } = body as {
    title?: string;
    description?: string;
    assignee?: string;
    priority?: string;
  };

  if (title !== undefined && (!title || title.trim().length === 0)) {
    return Response.json({ error: 'Title cannot be empty' }, { status: 400 });
  }
  if (priority !== undefined && !VALID_PRIORITIES.includes(priority)) {
    return Response.json({ error: 'Invalid priority' }, { status: 400 });
  }
  if (assignee !== undefined && !isValidAgentName(assignee)) {
    return Response.json({ error: 'Invalid assignee' }, { status: 400 });
  }

  // Read and update the task JSON file directly
  const fs = await import('fs/promises');
  const path = await import('path');
  const ctxRoot = getCTXRoot();
  const taskDir = task.org
    ? path.default.join(ctxRoot, 'orgs', task.org, 'tasks')
    : path.default.join(ctxRoot, 'tasks');
  const taskFile = path.default.join(taskDir, `${id}.json`);

  try {
    const raw = await fs.default.readFile(taskFile, 'utf-8');
    const taskData = JSON.parse(raw);

    const oldAssignee = taskData.assigned_to;
    if (title !== undefined) taskData.title = title.trim();
    if (description !== undefined) taskData.description = description;
    if (assignee !== undefined) taskData.assigned_to = assignee;
    if (priority !== undefined) taskData.priority = priority;
    taskData.updated_at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

    const tmp = taskFile + '.tmp';
    await fs.default.writeFile(tmp, JSON.stringify(taskData, null, 2) + '\n');
    await fs.default.rename(tmp, taskFile);

    // Notify new assignee if changed. assignee was validated against the
    // agent-name whitelist above, and the message body is capped before it
    // is passed as a positional arg to the bus script (which quotes "$3").
    if (assignee && assignee !== oldAssignee && assignee !== 'human' && assignee !== 'user' && isValidAgentName(assignee)) {
      try {
        const notifyMsg = capText(`Task reassigned to you: [${id}] ${taskData.title}`);
        spawnSync(
          'bash',
          [
            path.join(getFrameworkRoot(), 'bus', 'send-message.sh'),
            assignee,
            'normal',
            notifyMsg,
          ],
          { timeout: 5000, stdio: 'pipe', env: { ...process.env, CTX_FRAMEWORK_ROOT: getFrameworkRoot(), CTX_ROOT: getCTXRoot(), CTX_INSTANCE_ID: process.env.CTX_INSTANCE_ID ?? 'default', CTX_AGENT_NAME: 'dashboard', CTX_ORG: task?.org || '' } },
        );
      } catch { /* non-fatal */ }
    }

    try { syncAll(); } catch { /* best-effort */ }
    return Response.json({ success: true });
  } catch (err) {
    console.error('[api/tasks/[id]] PUT error:', err);
    return Response.json({ error: 'Failed to update task' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// PATCH /api/tasks/[id] - Update task status via bus scripts
//
// Body: { status, note?, blockedBy?, outputSummary? }
// - status=completed -> delegates to complete-task.sh
// - other statuses   -> delegates to update-task.sh
// ---------------------------------------------------------------------------

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  if (!isValidId(id)) {
    return Response.json({ error: 'Invalid task ID' }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { status, note, blockedBy, outputSummary } = body as {
    status?: string;
    note?: string;
    blockedBy?: string;
    outputSummary?: string;
  };

  if (!status || !VALID_STATUSES.includes(status as TaskStatus)) {
    return Response.json(
      { error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` },
      { status: 400 },
    );
  }
  const nextStatus = status as TaskStatus;

  // blockedBy is forwarded as a positional arg to update-task.sh. It should
  // either be absent or match the agent-name / task-id shape. Reject anything
  // containing shell metacharacters or path traversal.
  if (blockedBy !== undefined && blockedBy !== null && blockedBy !== '') {
    if (typeof blockedBy !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(blockedBy) || blockedBy.length > 128) {
      return Response.json({ error: 'Invalid blockedBy' }, { status: 400 });
    }
  }

  // Look up task's org to pass CTX_ORG to bus script
  const task = getTaskById(id);

  const frameworkRoot = getFrameworkRoot();
  const env = {
    ...process.env,
    CTX_FRAMEWORK_ROOT: frameworkRoot,
    CTX_ROOT: getCTXRoot(),
    CTX_INSTANCE_ID: process.env.CTX_INSTANCE_ID ?? 'default',
    CTX_AGENT_NAME: 'dashboard',
    CTX_ORG: task?.org || '',
  };

  try {
    let spawnResult;
    if (!task?.source_file) {
      const patched = await patchRgosTaskStatus(id, nextStatus, outputSummary, blockedBy);
      if (!patched) {
        throw new Error('Task has no local source file and RGOS is not configured or row was not found');
      }
      patchCachedTaskStatus(id, nextStatus, note);
      spawnResult = { status: 0, stdout: 'ok', stderr: '' };
    } else if (DASHBOARD_DIRECT_STATUSES.has(nextStatus)) {
      await updateTaskJsonStatus(task.source_file, nextStatus, note);
      try {
        await patchRgosTaskStatus(id, nextStatus, outputSummary, blockedBy);
      } catch {
        // Best-effort: local JSON remains authoritative for local bus tasks.
      }
      spawnResult = { status: 0, stdout: 'ok', stderr: '' };
    } else if (status === 'completed') {
      // Use complete-task.sh for completion (handles additional side effects).
      // summaryArg is capped and passed as a positional arg; the bus script
      // quotes "$2" and exec's node directly, so no shell interpolation occurs.
      const summaryArg = capText(outputSummary);
      spawnResult = spawnSync(
        'bash',
        [path.join(frameworkRoot, 'bus', 'complete-task.sh'), id, summaryArg],
        { encoding: 'utf-8', timeout: 10000, env, stdio: 'pipe' },
      );
    } else if (BUS_SCRIPT_STATUSES.has(nextStatus)) {
      // Use update-task.sh for other status changes. All args are positional
      // and bounded; blockedBy was validated above, id/status are whitelisted.
      const args: string[] = [id, nextStatus];
      if (note) args.push(capText(note));
      if (blockedBy) args.push(String(blockedBy));

      spawnResult = spawnSync(
        'bash',
        [path.join(frameworkRoot, 'bus', 'update-task.sh'), ...args],
        { encoding: 'utf-8', timeout: 10000, env, stdio: 'pipe' },
      );
    } else {
      throw new Error(`Unsupported status transition: ${nextStatus}`);
    }
    if (spawnResult.status !== 0) {
      throw new Error(spawnResult.stderr || spawnResult.stdout || 'Script failed');
    }

    // Notify the task creator when a task is completed or status changes significantly.
    // This is how agents find out their blocked tasks can be unblocked.
    if (task?.source_file) {
      try {
        const fs = await import('fs/promises');
        const raw = await fs.default.readFile(task.source_file, 'utf-8');
        const taskData = JSON.parse(raw);
        const createdBy: string | undefined = taskData.created_by;
        // Only notify agents (not 'dashboard', 'human', etc.) and only when
        // the recipient name passes the agent-name whitelist — prevents
        // passing crafted names into the bus CLI.
        const agentNames = new Set(['dashboard', 'human', 'user']);
        if (createdBy && !agentNames.has(createdBy) && isValidAgentName(createdBy)) {
          const rawMsg = status === 'completed'
            ? `Human task completed by user: [${id}] ${task.title} - you can now unblock your work`
            : `Task status updated to ${nextStatus}: [${id}] ${task.title}`;
          const msg = capText(rawMsg);
          spawnSync(
            'node',
            [
              path.join(frameworkRoot, 'dist', 'cli.js'),
              'bus', 'send-message', createdBy, 'normal', msg,
            ],
            { timeout: 5000, stdio: 'pipe', env },
          );
        }
      } catch { /* non-fatal */ }
    }

    // Trigger sync so subsequent reads reflect the update
    try {
      syncAll();
    } catch {
      // Sync is best-effort
    }

    return Response.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[api/tasks/[id]] PATCH error:', message);
    return Response.json(
      { error: 'Failed to update task' },
      { status: 500 },
    );
  }
}
