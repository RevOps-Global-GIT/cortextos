/**
 * tests/unit/utils/locked-write-queue.test.ts
 *
 * Unit coverage for the serialized locked-write queue that prevents
 * cron-spawned create-task / kb-ingest writes from being dropped when a
 * non-owner session holds session.lock.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  enqueueLockedWrite,
  readLockedWrites,
  rewriteLockedWrites,
  clearLockedWrites,
  lockedWriteQueuePath,
  LOCKED_WRITE_MAX,
  type LockedWriteEntry,
} from '../../../src/utils/locked-write-queue.js';

function entry(n: number): LockedWriteEntry {
  return {
    ts: `2026-06-17T18:${String(n % 60).padStart(2, '0')}:00Z`,
    command: 'create-task',
    argv: ['bus', 'create-task', `task ${n}`, '--skip-brief-validation'],
    conflicting_pid: 4242,
  };
}

describe('locked-write-queue', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'cortextos-lwq-'));
  });

  afterEach(() => {
    try { rmSync(stateDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('returns [] when no queue file exists', () => {
    expect(readLockedWrites(stateDir)).toEqual([]);
  });

  it('enqueues and reads back entries in order', () => {
    expect(enqueueLockedWrite(stateDir, entry(1))).toBe(1);
    expect(enqueueLockedWrite(stateDir, entry(2))).toBe(2);
    const got = readLockedWrites(stateDir);
    expect(got.map(e => e.argv[2])).toEqual(['task 1', 'task 2']);
    expect(got[0].command).toBe('create-task');
    expect(got[0].conflicting_pid).toBe(4242);
  });

  it('persists the queue as one JSON object per line', () => {
    enqueueLockedWrite(stateDir, entry(1));
    enqueueLockedWrite(stateDir, entry(2));
    const raw = readFileSync(lockedWriteQueuePath(stateDir), 'utf-8').trim();
    const lines = raw.split('\n');
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
  });

  it('skips corrupt lines without throwing', () => {
    enqueueLockedWrite(stateDir, entry(1));
    // Append a garbage line directly.
    writeFileSync(
      lockedWriteQueuePath(stateDir),
      readFileSync(lockedWriteQueuePath(stateDir), 'utf-8') + 'not-json\n',
    );
    const got = readLockedWrites(stateDir);
    expect(got).toHaveLength(1);
    expect(got[0].argv[2]).toBe('task 1');
  });

  it('rewriteLockedWrites replaces contents and clears when empty', () => {
    enqueueLockedWrite(stateDir, entry(1));
    enqueueLockedWrite(stateDir, entry(2));
    rewriteLockedWrites(stateDir, [entry(9)]);
    expect(readLockedWrites(stateDir).map(e => e.argv[2])).toEqual(['task 9']);
    rewriteLockedWrites(stateDir, []);
    expect(existsSync(lockedWriteQueuePath(stateDir))).toBe(false);
  });

  it('clearLockedWrites is idempotent', () => {
    expect(() => clearLockedWrites(stateDir)).not.toThrow();
    enqueueLockedWrite(stateDir, entry(1));
    clearLockedWrites(stateDir);
    expect(readLockedWrites(stateDir)).toEqual([]);
    expect(() => clearLockedWrites(stateDir)).not.toThrow();
  });

  it('enforces LOCKED_WRITE_MAX by evicting oldest entries', () => {
    for (let i = 1; i <= LOCKED_WRITE_MAX + 5; i++) {
      enqueueLockedWrite(stateDir, entry(i));
    }
    const got = readLockedWrites(stateDir);
    expect(got).toHaveLength(LOCKED_WRITE_MAX);
    // Oldest 5 evicted: first surviving entry is #6.
    expect(got[0].argv[2]).toBe('task 6');
    expect(got[got.length - 1].argv[2]).toBe(`task ${LOCKED_WRITE_MAX + 5}`);
  });
});
