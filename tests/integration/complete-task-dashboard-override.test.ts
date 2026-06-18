/**
 * tests/integration/complete-task-dashboard-override.test.ts
 *
 * Regression for the Greg-facing "CortextOS API 500: Failed to update task" bug
 * (2026-06-18): the dashboard "Mark Complete" action (PATCH /api/tasks/[id] →
 * complete-task.sh, with CTX_AGENT_NAME=dashboard and an empty result) was
 * hard-blocked by the AGENT proof-gate (task-validate scores an empty result
 * 4/10 regardless of mode → bus exits non-zero → generic 500).
 *
 * A human clicking "Mark Complete" is authoritative and must NOT be gated by the
 * agent proof-gate. complete-task.sh now appends --override ONLY when
 * CTX_AGENT_NAME=dashboard; agent completions stay gated.
 *
 * This drives the real complete-task.sh against a stub dist/cli.js that records
 * the argv it was invoked with, so we assert the flag is/ isn't forwarded.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';

const REPO_ROOT = join(__dirname, '..', '..');
const REAL_SCRIPT = join(REPO_ROOT, 'bus', 'complete-task.sh');

describe('complete-task.sh: dashboard human-completion proof-gate override', () => {
  let dir: string;
  let scriptPath: string;
  let argvDump: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cortextos-complete-gate-'));
    mkdirSync(join(dir, 'bus'), { recursive: true });
    mkdirSync(join(dir, 'dist'), { recursive: true });
    // Copy the real script so SCRIPT_DIR/../dist/cli.js resolves to our stub.
    scriptPath = join(dir, 'bus', 'complete-task.sh');
    copyFileSync(REAL_SCRIPT, scriptPath);
    chmodSync(scriptPath, 0o755);
    // Stub cli.js: record argv (minus node + path) to a file, exit 0.
    argvDump = join(dir, 'argv.txt');
    writeFileSync(
      join(dir, 'dist', 'cli.js'),
      `require('fs').writeFileSync(${JSON.stringify(argvDump)}, process.argv.slice(2).join(' '));\n`,
    );
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function run(agentName: string | undefined): string {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (agentName === undefined) delete env.CTX_AGENT_NAME;
    else env.CTX_AGENT_NAME = agentName;
    execFileSync('bash', [scriptPath, 'task_123', 'a result'], { env, stdio: 'pipe' });
    return existsSync(argvDump) ? readFileSync(argvDump, 'utf-8') : '';
  }

  it('appends --override for dashboard-initiated (human) completions', () => {
    const argv = run('dashboard');
    expect(argv).toContain('bus complete-task task_123');
    expect(argv).toContain('--override');
  });

  it('does NOT append --override for agent completions (agents stay gated)', () => {
    expect(run('dev')).not.toContain('--override');
    expect(run('analyst')).not.toContain('--override');
  });

  it('does NOT append --override when CTX_AGENT_NAME is unset', () => {
    expect(run(undefined)).not.toContain('--override');
  });

  it('still forwards the result argument', () => {
    expect(run('dashboard')).toContain('--result a result');
  });
});
