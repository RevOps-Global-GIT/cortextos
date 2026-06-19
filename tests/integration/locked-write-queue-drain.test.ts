/**
 * tests/integration/locked-write-queue-drain.test.ts
 *
 * Regression for the analyst maintenance-loop defect (2026-06-17): a
 * cron-spawned run issuing `cortextos bus create-task` while a NON-OWNER
 * process holds `state/<agent>/session.lock` used to hard-fail and DROP the
 * write — the scheduled task never reached the kanban.
 *
 * Post-fix behaviour:
 *   - A non-owner create-task/kb-ingest is APPENDED to
 *     state/<agent>/locked-writes.jsonl and exits 0 (queued, not dropped).
 *   - When the legitimate owner session next runs a bus mutation (or runs
 *     `bus drain-locked-writes`), the queued write is replayed and the task is
 *     created — then the queue is emptied.
 *
 * Mirrors tests/integration/session-lock-dup-spawn.test.ts: overrides HOME so
 * resolvePaths() derives ctxRoot from the temp dir, and drives the compiled
 * CLI directly (suite skips when dist/cli.js is absent).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const REPO_ROOT = join(__dirname, '..', '..');
const DIST_CLI = join(REPO_ROOT, 'dist', 'cli.js');

const AGENT = 'alpha';
const INSTANCE = 'default';
const ORG = 'revops-global';

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [DIST_CLI, ...args], { env });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

function stateDir(homeDir: string): string {
  return join(homeDir, '.cortextos', INSTANCE, 'state', AGENT);
}

function seedSessionLock(homeDir: string, ownerPid: number): void {
  const sd = stateDir(homeDir);
  mkdirSync(sd, { recursive: true });
  writeFileSync(
    join(sd, 'session.lock'),
    JSON.stringify({
      agent: AGENT,
      instance_id: INSTANCE,
      owner_pid: ownerPid,
      pty_pid: ownerPid + 1,
      session_id: 'sess-lwq-test',
      started_at: '2026-06-17T18:00:00Z',
    }) + '\n',
  );
}

function lockedQueuePath(homeDir: string): string {
  return join(stateDir(homeDir), 'locked-writes.jsonl');
}

/** Count task files written under the org task dir (created by create-task). */
function countTaskFiles(homeDir: string): number {
  const taskDir = join(homeDir, '.cortextos', INSTANCE, 'orgs', ORG, 'tasks');
  if (!existsSync(taskDir)) return 0;
  return readdirSync(taskDir).filter(f => f.endsWith('.json')).length;
}

const nonOwnerEnv = (home: string): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    CTX_AGENT_NAME: AGENT,
    CTX_INSTANCE_ID: INSTANCE,
    CTX_ORG: ORG,
  };
  delete env.CTX_SESSION_OWNER_PID;
  delete env.CTX_LOCKED_DRAIN;
  // Disable RGOS mirror — isEnabled() gates on SUPABASE_RGOS_URL, so stripping
  // these prevents any live-store writes while keeping full local write coverage.
  delete env.SUPABASE_RGOS_URL;
  delete env.SUPABASE_RGOS_SERVICE_KEY;
  return env;
};

const ownerEnv = (home: string, ownerPid: number): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    CTX_AGENT_NAME: AGENT,
    CTX_INSTANCE_ID: INSTANCE,
    CTX_ORG: ORG,
    CTX_SESSION_OWNER_PID: String(ownerPid),
  };
  // Disable RGOS mirror — same isolation rationale as nonOwnerEnv.
  delete env.SUPABASE_RGOS_URL;
  delete env.SUPABASE_RGOS_SERVICE_KEY;
  return env;
};

const CREATE_TASK_ARGS = [
  'bus', 'create-task', 'Queued scheduled task',
  '--desc', 'from cron under held lock',
  '--skip-brief-validation',
  '--skip-dedup',
];

describe.skipIf(!existsSync(DIST_CLI))('locked-write-queue: queue + drain under non-owner lock', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'cortextos-lwq-int-'));
  });

  afterEach(() => {
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('queues a non-owner create-task instead of dropping it (exit 0, no task written yet)', async () => {
    seedSessionLock(tmpHome, process.pid); // owner is the vitest process (alive, != caller)

    const result = await runCli(CREATE_TASK_ARGS, nonOwnerEnv(tmpHome));

    // Not dropped: succeeds with a clear "queued" message, not a hard failure.
    expect(result.code).toBe(0);
    expect(result.stderr.toLowerCase()).toContain('queued');
    expect(result.stderr).toContain(String(process.pid));

    // The write is parked in the queue, and NO task was created directly.
    expect(existsSync(lockedQueuePath(tmpHome))).toBe(true);
    const queued = readFileSync(lockedQueuePath(tmpHome), 'utf-8').trim().split('\n');
    expect(queued).toHaveLength(1);
    const entry = JSON.parse(queued[0]);
    expect(entry.command).toBe('create-task');
    expect(entry.argv).toEqual(CREATE_TASK_ARGS);
    expect(countTaskFiles(tmpHome)).toBe(0);
  }, 30_000);

  it('owner drain-locked-writes replays the queued task and empties the queue', async () => {
    seedSessionLock(tmpHome, process.pid);

    // 1) Non-owner run queues the write.
    const queuedRes = await runCli(CREATE_TASK_ARGS, nonOwnerEnv(tmpHome));
    expect(queuedRes.code).toBe(0);
    expect(countTaskFiles(tmpHome)).toBe(0);

    // 2) Owner session drains — the queued create-task is replayed for real.
    const drainRes = await runCli(['bus', 'drain-locked-writes'], ownerEnv(tmpHome, process.pid));
    expect(drainRes.code).toBe(0);
    expect(drainRes.stdout.toLowerCase()).toContain('drained 1/1');

    // The task now exists and the queue is empty.
    expect(countTaskFiles(tmpHome)).toBe(1);
    expect(existsSync(lockedQueuePath(tmpHome))).toBe(false);
  }, 30_000);

  it('an owner mutation opportunistically drains the queue (auto-drain)', async () => {
    seedSessionLock(tmpHome, process.pid);

    // Queue one write as a non-owner.
    await runCli(CREATE_TASK_ARGS, nonOwnerEnv(tmpHome));
    expect(countTaskFiles(tmpHome)).toBe(0);

    // Owner runs an UNRELATED mutation; preAction auto-drains the queue first.
    const res = await runCli(['bus', 'update-heartbeat', 'online'], ownerEnv(tmpHome, process.pid));
    expect(res.stderr).not.toContain('is not the owner');

    // The queued create-task was replayed and the queue cleared.
    expect(countTaskFiles(tmpHome)).toBe(1);
    expect(existsSync(lockedQueuePath(tmpHome))).toBe(false);
  }, 30_000);

  it('still hard-fails a non-queueable mutation (heartbeat) under a non-owner lock', async () => {
    seedSessionLock(tmpHome, process.pid);

    const result = await runCli(['bus', 'update-heartbeat', 'online'], nonOwnerEnv(tmpHome));

    // Unchanged behaviour: non-zero exit naming the conflicting pid, no queue file.
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(String(process.pid));
    expect(result.stderr.toLowerCase()).toContain('session.lock');
    expect(existsSync(lockedQueuePath(tmpHome))).toBe(false);
  }, 30_000);
});
