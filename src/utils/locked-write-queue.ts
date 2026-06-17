import { existsSync, readFileSync, unlinkSync } from 'fs';
import { appendFileSync } from 'fs';
import { join } from 'path';
import { ensureDir, atomicWriteSync } from './atomic.js';

/**
 * Serialized queue for bus writes that could not run because the agent's
 * `state/<agent>/session.lock` was held by a non-owner process.
 *
 * Bug we are fixing: when a cron fires a run for agent X while a different
 * process owns X's session.lock, that run's `cortextos bus create-task` /
 * `kb-ingest` calls hit `verifySessionOwnership()` and were dropped — the CLI
 * exited non-zero, but the WORK vanished. Scheduled tasks never reached the
 * kanban and KB ingests were silently lost (observed on 13+ analyst
 * maintenance-loop runs, May→Jun 2026).
 *
 * Mechanism: instead of dropping the write, the CLI appends the original
 * argv to `state/<agent>/locked-writes.jsonl`. The next time the agent's
 * legitimate owner session runs a bus mutation, it drains this queue by
 * re-invoking each queued command (which now passes the ownership check),
 * so no scheduled write is lost. See `drainLockedWrites()` in
 * `src/cli/bus.ts` and `verifySessionOwnership()` in `src/utils/session-lock.ts`.
 */
export interface LockedWriteEntry {
  /** ISO timestamp when the write was queued. */
  ts: string;
  /** Bus subcommand that was blocked (e.g. 'create-task', 'kb-ingest'). */
  command: string;
  /**
   * The argv to replay, relative to the CLI entrypoint — i.e.
   * `process.argv.slice(2)`, which begins with 'bus'. Replaying is
   * `execFileSync(node, [cli.js, ...argv])`.
   */
  argv: string[];
  /** owner_pid that held the lock when this write was blocked (for diagnosis). */
  conflicting_pid: number;
}

const LOCKED_WRITE_FILENAME = 'locked-writes.jsonl';

/**
 * Cap the queue so a permanently-stuck lock cannot grow the file unbounded.
 * Mirrors the RETRY_MAX bound on the RGOS mirror retry queue. When the cap is
 * exceeded the OLDEST entries are evicted (with a warning) — newest writes win.
 */
export const LOCKED_WRITE_MAX = 200;

export function lockedWriteQueuePath(stateDir: string): string {
  return join(stateDir, LOCKED_WRITE_FILENAME);
}

/**
 * Read all queued locked-writes, skipping any corrupt lines. Returns [] when
 * the queue file is absent or empty.
 */
export function readLockedWrites(stateDir: string): LockedWriteEntry[] {
  const p = lockedWriteQueuePath(stateDir);
  if (!existsSync(p)) return [];
  const out: LockedWriteEntry[] = [];
  for (const line of readFileSync(p, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as LockedWriteEntry;
      if (parsed && typeof parsed.command === 'string' && Array.isArray(parsed.argv)) {
        out.push(parsed);
      }
    } catch {
      /* skip corrupt line */
    }
  }
  return out;
}

/**
 * Append a blocked write to the queue. Enforces the LOCKED_WRITE_MAX cap by
 * rewriting the file with only the newest entries when the cap is exceeded.
 * Returns the queue depth after the append.
 */
export function enqueueLockedWrite(stateDir: string, entry: LockedWriteEntry): number {
  ensureDir(stateDir);
  const p = lockedWriteQueuePath(stateDir);
  const existing = readLockedWrites(stateDir);
  existing.push(entry);
  if (existing.length > LOCKED_WRITE_MAX) {
    const dropped = existing.length - LOCKED_WRITE_MAX;
    console.warn(
      `[locked-write-queue] WARN: queue at cap (${LOCKED_WRITE_MAX}); evicting ${dropped} oldest ` +
      `entr${dropped === 1 ? 'y' : 'ies'} — data loss`,
    );
    const trimmed = existing.slice(existing.length - LOCKED_WRITE_MAX);
    atomicWriteSync(p, trimmed.map(e => JSON.stringify(e)).join('\n') + '\n');
    return trimmed.length;
  }
  appendFileSync(p, JSON.stringify(entry) + '\n');
  return existing.length;
}

/**
 * Replace the queue contents with `entries` (used after a partial drain to
 * persist the writes that still failed). Removes the file when empty.
 */
export function rewriteLockedWrites(stateDir: string, entries: LockedWriteEntry[]): void {
  const p = lockedWriteQueuePath(stateDir);
  if (entries.length === 0) {
    clearLockedWrites(stateDir);
    return;
  }
  ensureDir(stateDir);
  atomicWriteSync(p, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
}

/**
 * Remove the queue file. Idempotent — safe when no queue exists.
 */
export function clearLockedWrites(stateDir: string): void {
  try { unlinkSync(lockedWriteQueuePath(stateDir)); } catch { /* ignore */ }
}
