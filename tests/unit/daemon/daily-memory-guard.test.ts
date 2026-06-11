import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { rotateOversizedDailyMemory, DAILY_MEMORY_CAP_BYTES } from '../../../src/daemon/daily-memory-guard.js';

describe('rotateOversizedDailyMemory', () => {
  let agentDir: string;
  const now = new Date('2026-06-11T16:00:00.000Z');
  const today = '2026-06-11';

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), 'memguard-'));
    mkdirSync(join(agentDir, 'memory'), { recursive: true });
  });

  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
  });

  const dailyPath = () => join(agentDir, 'memory', `${today}.md`);
  const archiveDir = () => join(agentDir, 'memory', 'archive');

  it('rotates a file over the cap: archives full content and leaves a small stub', () => {
    const big = 'x'.repeat(DAILY_MEMORY_CAP_BYTES + 1024);
    writeFileSync(dailyPath(), big, 'utf-8');

    const archivePath = rotateOversizedDailyMemory(agentDir, 'codex', undefined, undefined, now);

    expect(archivePath).not.toBeNull();
    // Archive holds the full original content
    expect(readFileSync(archivePath as string, 'utf-8')).toBe(big);
    // Daily path now holds only a small stub that points at the archive
    const stub = readFileSync(dailyPath(), 'utf-8');
    expect(stub.length).toBeLessThan(1024);
    expect(stub).toContain('codex — 2026-06-11');
    expect(stub).toContain('memory/archive/');
    // The boot read is now cheap
    expect(statSync(dailyPath()).size).toBeLessThanOrEqual(DAILY_MEMORY_CAP_BYTES);
  });

  it('leaves a file at or below the cap untouched', () => {
    const small = 'normal day notes\n';
    writeFileSync(dailyPath(), small, 'utf-8');

    const result = rotateOversizedDailyMemory(agentDir, 'codex', undefined, undefined, now);

    expect(result).toBeNull();
    expect(readFileSync(dailyPath(), 'utf-8')).toBe(small);
    expect(existsSync(archiveDir())).toBe(false);
  });

  it('is a no-op when no daily file exists', () => {
    const result = rotateOversizedDailyMemory(agentDir, 'codex', undefined, undefined, now);
    expect(result).toBeNull();
    expect(existsSync(dailyPath())).toBe(false);
  });

  it('respects a custom cap', () => {
    writeFileSync(dailyPath(), 'y'.repeat(200), 'utf-8');
    // 200 bytes is under the default cap but over this tiny custom cap
    const result = rotateOversizedDailyMemory(agentDir, 'codex', 100, undefined, now);
    expect(result).not.toBeNull();
    expect(readdirSync(archiveDir())).toHaveLength(1);
  });

  it('never throws and returns null on a missing agent dir', () => {
    expect(() => rotateOversizedDailyMemory('', 'codex')).not.toThrow();
    expect(rotateOversizedDailyMemory('', 'codex')).toBeNull();
    expect(rotateOversizedDailyMemory(join(agentDir, 'does-not-exist'), 'codex')).toBeNull();
  });
});
