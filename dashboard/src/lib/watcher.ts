// cortextOS Dashboard - Chokidar file watcher singleton
// Monitors CTX_ROOT for JSON/JSONL changes, syncs to SQLite, emits SSE events.

import { EventEmitter } from 'events';
import { watch, type FSWatcher } from 'chokidar';
import fs from 'fs';
import path from 'path';
import { CTX_ROOT, getOrgs } from './config';
import { syncFile, syncAll } from './sync';
import { db } from './db';
import type { EventType, SSEEvent } from './types';

// ---------------------------------------------------------------------------
// globalThis singleton pattern (survives Next.js hot reloads)
// ---------------------------------------------------------------------------

const globalForWatcher = globalThis as unknown as {
  __cortextos_emitter: EventEmitter | undefined;
  __cortextos_watcher: FSWatcher | undefined;
};

export const emitter: EventEmitter =
  globalForWatcher.__cortextos_emitter ?? new EventEmitter();
emitter.setMaxListeners(100); // support many concurrent SSE clients

if (process.env.NODE_ENV !== 'production') {
  globalForWatcher.__cortextos_emitter = emitter;
}

// ---------------------------------------------------------------------------
// Watch path builder
// ---------------------------------------------------------------------------

function getWatchPaths(): string[] {
  const paths: string[] = [];
  const orgs = getOrgs();

  for (const org of orgs) {
    const orgBase = path.join(CTX_ROOT, 'orgs', org);
    paths.push(path.join(orgBase, 'tasks', '**', '*.json'));
    paths.push(path.join(orgBase, 'approvals', '**', '*.json'));
    paths.push(path.join(orgBase, 'analytics', 'events', '**', '*.jsonl'));
  }

  // Flat paths (not org-scoped)
  paths.push(path.join(CTX_ROOT, 'state', '*', 'heartbeat.json'));
  paths.push(path.join(CTX_ROOT, 'inbox', '**', '*.json'));

  return paths;
}

// ---------------------------------------------------------------------------
// File change handler
// ---------------------------------------------------------------------------

type WatchChangeType = 'change' | 'add' | 'remove';

function categorizeFilePath(filePath: string): SSEEvent['type'] {
  if (filePath.includes('/tasks/')) return 'task';
  if (filePath.includes('/approvals/')) return 'approval';
  if (filePath.includes('/heartbeat.json')) return 'heartbeat';
  if (filePath.includes('/analytics/events/')) return 'event';
  return 'sync';
}

function readJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function fallbackEvent(filePath: string, changeType: WatchChangeType): SSEEvent {
  return {
    type: categorizeFilePath(filePath),
    data: { filePath, changeType },
    timestamp: new Date().toISOString(),
  };
}

function normalizeEventType(value: unknown): SSEEvent['type'] {
  const type = typeof value === 'string' ? value : '';
  if (['action', 'message', 'task', 'approval', 'error', 'milestone', 'heartbeat', 'event', 'sync'].includes(type)) {
    return type as EventType | 'event' | 'sync';
  }
  return 'event';
}

function parseData(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function eventRowToSSE(filePath: string, changeType: WatchChangeType): SSEEvent | null {
  const row = db
    .prepare(
      `SELECT id, timestamp, agent, org, type, category, severity, data, message, source_file
       FROM events
       WHERE source_file = ?
       ORDER BY timestamp DESC
       LIMIT 1`,
    )
    .get(filePath) as Record<string, unknown> | undefined;

  if (!row) return null;

  return {
    type: normalizeEventType(row.type),
    timestamp: row.timestamp as string,
    data: {
      ...parseData(row.data),
      id: row.id,
      agent: row.agent,
      org: row.org,
      category: row.category,
      severity: row.severity,
      message: row.message,
      source_file: row.source_file,
      filePath,
      changeType,
    },
  };
}

export function buildSSEEventForFileChange(
  filePath: string,
  changeType: WatchChangeType,
): SSEEvent {
  if (changeType === 'remove') return fallbackEvent(filePath, changeType);

  if (filePath.includes('/analytics/events/') && filePath.endsWith('.jsonl')) {
    return eventRowToSSE(filePath, changeType) ?? fallbackEvent(filePath, changeType);
  }

  if (filePath.includes('/tasks/') && filePath.endsWith('.json')) {
    const task = readJsonFile(filePath);
    if (task) {
      const title = typeof task.title === 'string' ? task.title : 'Untitled task';
      const status = typeof task.status === 'string' ? task.status : 'updated';
      const agent = typeof task.assigned_to === 'string'
        ? task.assigned_to
        : typeof task.assignee === 'string'
          ? task.assignee
          : '';
      const org = typeof task.org === 'string' ? task.org : '';
      return {
        type: 'task',
        timestamp: typeof task.updated_at === 'string'
          ? task.updated_at
          : typeof task.created_at === 'string'
            ? task.created_at
            : new Date().toISOString(),
        data: {
          id: task.id ?? path.basename(filePath, '.json'),
          agent,
          org,
          category: 'task',
          severity: 'info',
          message: `Task ${status}: ${title}`,
          filePath,
          changeType,
        },
      };
    }
  }

  if (filePath.includes('/approvals/') && filePath.endsWith('.json')) {
    const approval = readJsonFile(filePath);
    if (approval) {
      const title = typeof approval.title === 'string' ? approval.title : 'Approval';
      const status = typeof approval.status === 'string' ? approval.status : 'updated';
      return {
        type: 'approval',
        timestamp: typeof approval.resolved_at === 'string'
          ? approval.resolved_at
          : typeof approval.created_at === 'string'
            ? approval.created_at
            : new Date().toISOString(),
        data: {
          id: approval.id ?? path.basename(filePath, '.json'),
          agent: approval.requesting_agent ?? approval.agent ?? '',
          org: approval.org ?? '',
          category: approval.category ?? 'approval',
          severity: 'info',
          message: `Approval ${status}: ${title}`,
          filePath,
          changeType,
        },
      };
    }
  }

  if (filePath.includes('/state/') && filePath.endsWith('heartbeat.json')) {
    const heartbeat = readJsonFile(filePath);
    if (heartbeat) {
      const agent = path.basename(path.dirname(filePath));
      const status = typeof heartbeat.status === 'string' ? heartbeat.status : 'heartbeat';
      return {
        type: 'heartbeat',
        timestamp: typeof heartbeat.last_heartbeat === 'string'
          ? heartbeat.last_heartbeat
          : typeof heartbeat.timestamp === 'string'
            ? heartbeat.timestamp
            : new Date().toISOString(),
        data: {
          agent,
          org: heartbeat.org ?? '',
          category: 'heartbeat',
          severity: 'info',
          message: `${agent} heartbeat: ${status}`,
          filePath,
          changeType,
        },
      };
    }
  }

  return fallbackEvent(filePath, changeType);
}

function handleFileChange(
  filePath: string,
  changeType: WatchChangeType,
): void {
  console.log(`[watcher] ${changeType}: ${filePath}`);

  // Sync the changed file to SQLite (skip for deletions)
  if (changeType !== 'remove') {
    try {
      syncFile(filePath);
    } catch (err) {
      console.error(`[watcher] Sync failed for ${filePath}:`, err);
    }
  }

  emitter.emit('sse', buildSSEEventForFileChange(filePath, changeType));
}

// ---------------------------------------------------------------------------
// Watcher factory
// ---------------------------------------------------------------------------

function createWatcher(): FSWatcher {
  const watchPaths = getWatchPaths();

  if (watchPaths.length === 0) {
    console.warn(
      '[watcher] No paths to watch - CTX_ROOT may not have any orgs yet',
    );
  }

  const watcher = watch(watchPaths, {
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: {
      stabilityThreshold: 300,
      pollInterval: 100,
    },
  });

  watcher.on('add', (fp) => handleFileChange(fp, 'add'));
  watcher.on('change', (fp) => handleFileChange(fp, 'change'));
  watcher.on('unlink', (fp) => handleFileChange(fp, 'remove'));
  watcher.on('error', (error) => console.error('[watcher] Error:', error));

  console.log(
    `[watcher] Watching ${watchPaths.length} patterns under ${CTX_ROOT}`,
  );
  return watcher;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize the file watcher singleton.
 * Runs a full sync on first call, then starts watching for incremental changes.
 */
export function initWatcher(): FSWatcher {
  if (globalForWatcher.__cortextos_watcher) {
    return globalForWatcher.__cortextos_watcher;
  }

  console.log('[watcher] Running initial full sync...');
  syncAll();

  const watcher = createWatcher();

  if (process.env.NODE_ENV !== 'production') {
    globalForWatcher.__cortextos_watcher = watcher;
  }

  return watcher;
}

/**
 * Gracefully close the watcher.
 */
export function stopWatcher(): void {
  if (globalForWatcher.__cortextos_watcher) {
    globalForWatcher.__cortextos_watcher.close();
    globalForWatcher.__cortextos_watcher = undefined;
  }
}

/**
 * Subscribe to SSE events. Returns an unsubscribe function.
 */
export function onSSEEvent(
  handler: (event: SSEEvent) => void,
): () => void {
  emitter.on('sse', handler);
  return () => emitter.off('sse', handler);
}

// Graceful shutdown on process exit
if (typeof process !== 'undefined') {
  const shutdown = () => {
    stopWatcher();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
