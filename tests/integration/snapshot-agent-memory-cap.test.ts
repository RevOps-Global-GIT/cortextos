/**
 * tests/integration/snapshot-agent-memory-cap.test.ts
 *
 * Regression for the context-bloat boot-loop failure class (2026-06-17):
 * agent daily memory files (memory/YYYY-MM-DD.md) balloon — mostly from
 * self-inflicted AUTO-SNAPSHOT/Session-Start spam — until loading them on boot
 * pushes context past ctx_autoreset_threshold, force-restarting the agent in a
 * 2-3min loop (hit orchestrator + codex-3).
 *
 * snapshot-agent.sh now caps/auto-rotates the daily memory ON WRITE: if today's
 * file exceeds DAILY_MEMORY_CAP_BYTES it archives the full file (history is
 * preserved) and replaces it with a lean stub before appending the snapshot
 * marker, so a freshly-rotated file can never re-trigger a boot-time restart.
 *
 * The script is driven directly with CTX_AGENT_DIR/CTX_FRAMEWORK_ROOT pointed
 * at a temp dir so the Neon-episode and Telegram side effects no-op.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';

const REPO_ROOT = join(__dirname, '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'snapshot-agent.sh');
const AGENT = 'testagent';

/** Today's date as the script computes it: `date -u +%Y-%m-%d`. */
function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function memoryFile(agentDir: string): string {
  return join(agentDir, 'memory', `${utcToday()}.md`);
}

function runSnapshot(agentDir: string, env: NodeJS.ProcessEnv = {}): void {
  execFileSync('bash', [SCRIPT, AGENT, '--silent', '--reason', 'unit-test'], {
    env: {
      ...process.env,
      CTX_AGENT_DIR: agentDir,
      CTX_FRAMEWORK_ROOT: join(agentDir, '_fwroot'), // nonexistent → Neon/secrets skipped
      CTX_ORG: 'revops-global',
      ...env,
    },
    stdio: 'ignore',
    timeout: 30_000,
  });
}

describe('snapshot-agent.sh: daily-memory cap/auto-rotate', () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), 'cortextos-memcap-'));
    mkdirSync(join(agentDir, 'memory'), { recursive: true });
  });

  afterEach(() => {
    try { rmSync(agentDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('rotates an oversized daily memory file (archives full, leaves a lean stub)', () => {
    const file = memoryFile(agentDir);
    // Build a >32KB file whose tail carries a recognizable marker line.
    const filler = Array.from({ length: 1200 }, (_, i) => `## AUTO-SNAPSHOT spam line ${i}`).join('\n');
    const tailMarker = 'TAIL-CONTINUITY-MARKER-XYZ';
    writeFileSync(file, `${filler}\n${tailMarker}\n`);
    const originalBytes = readFileSync(file).length;
    expect(originalBytes).toBeGreaterThan(32768);

    runSnapshot(agentDir);

    // File is now lean: well under the original, comfortably under the cap +
    // one snapshot block.
    const newBytes = readFileSync(file).length;
    expect(newBytes).toBeLessThan(32768);
    expect(newBytes).toBeLessThan(originalBytes);

    // Rotation stub markers + recent tail retained for continuity.
    const stub = readFileSync(file, 'utf-8');
    expect(stub).toContain('auto-rotated');
    expect(stub).toContain('Full history preserved');
    expect(stub).toContain(tailMarker);
    // The fresh snapshot marker was still appended after rotation.
    expect(stub).toContain('## AUTO-SNAPSHOT');

    // Full history preserved in archive/, never deleted.
    const archiveDir = join(agentDir, 'memory', 'archive');
    expect(existsSync(archiveDir)).toBe(true);
    const archived = readdirSync(archiveDir).filter(f => f.includes('-rotated-'));
    expect(archived).toHaveLength(1);
    const archivedContent = readFileSync(join(archiveDir, archived[0]), 'utf-8');
    expect(archivedContent.length).toBe(originalBytes);
    expect(archivedContent).toContain('AUTO-SNAPSHOT spam line 0');
  });

  it('does NOT rotate a small daily memory file (appends in place, no archive)', () => {
    const file = memoryFile(agentDir);
    writeFileSync(file, '## Session Start\n- small real note\n');

    runSnapshot(agentDir);

    const content = readFileSync(file, 'utf-8');
    expect(content).toContain('small real note');     // original kept
    expect(content).toContain('## AUTO-SNAPSHOT');     // marker appended
    expect(content).not.toContain('auto-rotated');     // no rotation
    expect(existsSync(join(agentDir, 'memory', 'archive'))).toBe(false);
  });

  it('honors a custom DAILY_MEMORY_CAP_BYTES threshold', () => {
    const file = memoryFile(agentDir);
    // ~5KB file — over a 1KB custom cap, under the 32KB default.
    writeFileSync(file, 'x'.repeat(5000) + '\n');
    expect(readFileSync(file).length).toBeGreaterThan(1024);

    runSnapshot(agentDir, { DAILY_MEMORY_CAP_BYTES: '1024' });

    expect(existsSync(join(agentDir, 'memory', 'archive'))).toBe(true);
    expect(readFileSync(file, 'utf-8')).toContain('auto-rotated');
  });
});
