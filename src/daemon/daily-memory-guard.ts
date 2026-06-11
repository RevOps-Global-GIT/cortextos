import { existsSync, renameSync, statSync, writeFileSync } from 'fs';
import { basename, join } from 'path';
import { ensureDir } from '../utils/atomic.js';

/**
 * Default cap for a daily memory file before it is rotated at session start.
 * ~30K tokens — orders of magnitude above a normal day's notes (a few KB), so
 * the guard only ever fires on pathological growth.
 */
export const DAILY_MEMORY_CAP_BYTES = 120 * 1024;

/**
 * Boot-loop guard (card d30fe222): the session-start checklist reads today's
 * daily memory file whole. When that file balloons (codex hit 452KB / ~115K
 * tokens), a *fresh* session boots at or above the context-handoff threshold and
 * cannot make progress before tripping a restart — an exhaustion loop the
 * Tier-0/Tier-2 boot-window guards in fast-checker cannot escape, because the
 * problem is the boot payload itself, not a stale status reading.
 *
 * If today's daily memory exceeds `capBytes`, archive it under memory/archive/
 * and leave a small stub pointing at the archive so the boot read stays cheap.
 * The agent keeps appending to the same daily path; nothing downstream changes.
 *
 * Best-effort and side-effect-isolated: returns the archive path when a rotation
 * happened, otherwise null. Never throws — any failure is reported via `log` and
 * swallowed so it can never block an agent start.
 */
export function rotateOversizedDailyMemory(
  agentDir: string,
  agentName: string,
  capBytes: number = DAILY_MEMORY_CAP_BYTES,
  log?: (msg: string) => void,
  now: Date = new Date(),
): string | null {
  try {
    if (!agentDir) return null;
    const memoryDir = join(agentDir, 'memory');
    if (!existsSync(memoryDir)) return null;
    const today = now.toISOString().slice(0, 10);
    const dailyPath = join(memoryDir, `${today}.md`);
    let size = 0;
    try {
      size = statSync(dailyPath).size;
    } catch {
      return null; // no daily file yet → nothing to guard
    }
    if (size <= capBytes) return null;

    const archiveDir = join(memoryDir, 'archive');
    ensureDir(archiveDir);
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    const archivePath = join(archiveDir, `${today}-full-${stamp}.md`);
    renameSync(dailyPath, archivePath);
    const sizeKb = Math.round(size / 1024);
    const stub =
      `# ${agentName} — ${today}\n\n` +
      `> Auto-rotated at session start: the prior daily memory reached ${sizeKb}KB, ` +
      `large enough to exhaust the context window when read whole during the boot ` +
      `checklist. Full prior content preserved at memory/archive/${basename(archivePath)}.\n`;
    writeFileSync(dailyPath, stub, 'utf-8');
    log?.(
      `Boot guard: rotated oversized daily memory (${sizeKb}KB > ${Math.round(capBytes / 1024)}KB cap) → archive/${basename(archivePath)}`,
    );
    return archivePath;
  } catch (err) {
    log?.(`Boot guard: daily-memory size check failed (non-fatal): ${err}`);
    return null;
  }
}
