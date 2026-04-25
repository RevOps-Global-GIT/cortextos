/**
 * Unit tests for hook-policy-check.ts and hook-policy-check-mcp.ts.
 *
 * Tests run the compiled dist/hooks/*.js as subprocesses — same execution path
 * as a live Claude Code session. Stdin carries the hook JSON payload;
 * stdout carries { decision: 'block', reason } on a violation.
 *
 * Motivation: A4 Phase 3 was reverted because spawn EBADF on Greg's Mac was
 * initially misdiagnosed as a hook false-positive. These tests provide a fast,
 * deterministic gate: "does the hook binary behave correctly in isolation?"
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HOOK_PATH = join(__dirname, '../../../dist/hooks/hook-policy-check.js');
const MCP_HOOK_PATH = join(__dirname, '../../../dist/hooks/hook-policy-check-mcp.js');

function runHook(
  hookPath: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  agent = 'dev',
): { decision: 'block' | 'allow'; reason?: string; exitCode: number } {
  const input = JSON.stringify({ tool_name: toolName, tool_input: toolInput });
  const result = spawnSync(process.execPath, [hookPath], {
    input,
    env: { ...process.env, CTX_AGENT_NAME: agent },
    encoding: 'utf-8',
    timeout: 5000,
  });

  const stdout = (result.stdout ?? '').trim();
  let decision: 'block' | 'allow' = 'allow';
  let reason: string | undefined;

  if (stdout) {
    try {
      const parsed = JSON.parse(stdout) as { decision?: string; reason?: string };
      if (parsed.decision === 'block') {
        decision = 'block';
        reason = parsed.reason;
      }
    } catch {
      // Non-JSON stdout → treat as allow
    }
  }

  return { decision, reason, exitCode: result.status ?? 0 };
}

function runPolicyCheck(
  command: string,
  agent = 'dev',
): ReturnType<typeof runHook> {
  return runHook(HOOK_PATH, 'Bash', { command }, agent);
}

// ---------------------------------------------------------------------------
// P1: External Telegram sends blocked for non-orchestrator agents
// ---------------------------------------------------------------------------

describe('hook-policy-check — P1: direct Telegram sends', () => {
  const chatId = '123456789'; // 9-digit numeric ID
  const cmd = (id: string) => `cortextos bus send-telegram ${id} "hello"`;

  it('blocks analyst sending Telegram to numeric chat ID', () => {
    const r = runPolicyCheck(cmd(chatId), 'analyst');
    expect(r.decision).toBe('block');
    expect(r.reason).toMatch(/orchestrator/i);
    expect(r.exitCode).toBe(0);
  });

  it('blocks dev agent sending Telegram to numeric chat ID', () => {
    const r = runPolicyCheck(cmd('987654321'), 'dev');
    expect(r.decision).toBe('block');
    expect(r.exitCode).toBe(0);
  });

  it('allows orchestrator to send Telegram (P1 exempt)', () => {
    const r = runPolicyCheck(cmd(chatId), 'orchestrator');
    expect(r.decision).toBe('allow');
  });

  it('allows unknown/unset CTX_AGENT_NAME (misconfigured env — fail open)', () => {
    const r = runPolicyCheck(cmd(chatId), 'unknown');
    expect(r.decision).toBe('allow');
  });

  it('allows send-message to orchestrator (internal routing, not Telegram)', () => {
    const r = runPolicyCheck('cortextos bus send-message orchestrator normal "hi"', 'analyst');
    expect(r.decision).toBe('allow');
  });

  it('does not block when chat ID is a short env var reference (unexpanded)', () => {
    // $CTX_TELEGRAM_CHAT_ID — variable reference, not a raw 8+ digit number
    const r = runPolicyCheck('cortextos bus send-telegram $CTX_TELEGRAM_CHAT_ID "hi"', 'dev');
    expect(r.decision).toBe('allow');
  });
});

// ---------------------------------------------------------------------------
// P2: Git push must target fork, not origin
// ---------------------------------------------------------------------------

describe('hook-policy-check — P2: git push target', () => {
  it('blocks git push origin main', () => {
    const r = runPolicyCheck('git push origin main');
    expect(r.decision).toBe('block');
    expect(r.reason).toMatch(/fork/i);
    expect(r.exitCode).toBe(0);
  });

  it('blocks bare git push (no explicit remote)', () => {
    const r = runPolicyCheck('git push');
    expect(r.decision).toBe('block');
  });

  it('allows git push fork <branch>', () => {
    const r = runPolicyCheck('git push fork feat/my-branch');
    expect(r.decision).toBe('allow');
  });

  it('allows git push fork --delete (branch deletion)', () => {
    const r = runPolicyCheck('git push fork --delete old-branch');
    expect(r.decision).toBe('allow');
  });

  it('does not trigger P2 on git status', () => {
    const r = runPolicyCheck('git status');
    expect(r.decision).toBe('allow');
  });

  it('does not trigger P2 on git diff', () => {
    const r = runPolicyCheck('git diff HEAD~1');
    expect(r.decision).toBe('allow');
  });

  it('does not false-positive on heredoc commit message containing push text', () => {
    // Heredoc bodies with "git push origin" in commit messages must not trigger P2.
    // The hook strips <<'MARKER'...content before matching.
    const lines = [
      "git commit -m \"$(cat <<'EOF'",
      'fix: important change',
      '',
      'Note: do NOT use git push origin',
      'EOF',
      ')"',
    ];
    const r = runPolicyCheck(lines.join('\n'));
    expect(r.decision).toBe('allow');
  });
});

// ---------------------------------------------------------------------------
// P4: Git staging discipline
// ---------------------------------------------------------------------------

describe('hook-policy-check — P4: git add discipline', () => {
  it('blocks git add -A', () => {
    const r = runPolicyCheck('git add -A');
    expect(r.decision).toBe('block');
    expect(r.reason).toMatch(/specific paths/i);
    expect(r.exitCode).toBe(0);
  });

  it('blocks git add .', () => {
    const r = runPolicyCheck('git add .');
    expect(r.decision).toBe('block');
  });

  it('blocks git add . with trailing whitespace', () => {
    const r = runPolicyCheck('git add .  ');
    expect(r.decision).toBe('block');
  });

  it('allows git add ./relative/path (not a catch-all)', () => {
    const r = runPolicyCheck('git add ./src/bus/task.ts');
    expect(r.decision).toBe('allow');
  });

  it('allows git add with specific file paths', () => {
    const r = runPolicyCheck('git add src/bus/task.ts src/types/index.ts');
    expect(r.decision).toBe('allow');
  });

  it('allows git add -f with specific path (force-add tracked file)', () => {
    const r = runPolicyCheck('git add -f orgs/revops-global/agents/dev/CLAUDE.md');
    expect(r.decision).toBe('allow');
  });

  it('does not false-positive on heredoc commit message mentioning staging examples', () => {
    // Commit messages documenting staging discipline should not self-trigger P4.
    const lines = [
      "git commit -m \"$(cat <<'EOF'",
      'docs: update CLAUDE.md with staging discipline',
      '',
      'Use specific paths, not catch-all staging.',
      'EOF',
      ')"',
    ];
    const r = runPolicyCheck(lines.join('\n'));
    expect(r.decision).toBe('allow');
  });
});

// ---------------------------------------------------------------------------
// Non-Bash tool calls — hook should pass through silently
// ---------------------------------------------------------------------------

describe('hook-policy-check — non-Bash tool calls pass through', () => {
  it('allows Read tool calls', () => {
    const r = runHook(HOOK_PATH, 'Read', { file_path: '/tmp/test.md' });
    expect(r.decision).toBe('allow');
  });

  it('allows Edit tool calls', () => {
    const r = runHook(HOOK_PATH, 'Edit', { file_path: '/tmp/test.md', old_string: 'a', new_string: 'b' });
    expect(r.decision).toBe('allow');
  });

  it('allows Glob tool calls', () => {
    const r = runHook(HOOK_PATH, 'Glob', { pattern: '**/*.ts' });
    expect(r.decision).toBe('allow');
  });
});

// ---------------------------------------------------------------------------
// Stdin/parse edge cases
// ---------------------------------------------------------------------------

describe('hook-policy-check — stdin handling', () => {
  it('exits 0 silently on empty stdin (allow, no block decision)', () => {
    const result = spawnSync(process.execPath, [HOOK_PATH], {
      input: '',
      env: { ...process.env, CTX_AGENT_NAME: 'dev' },
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(result.status).toBe(0);
    expect((result.stdout ?? '').trim()).toBe('');
  });

  it('exits 0 silently on malformed JSON stdin', () => {
    const result = spawnSync(process.execPath, [HOOK_PATH], {
      input: 'not valid json',
      env: { ...process.env, CTX_AGENT_NAME: 'dev' },
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(result.status).toBe(0);
    expect((result.stdout ?? '').trim()).toBe('');
  });
});

// ---------------------------------------------------------------------------
// P3: MCP hook (hook-policy-check-mcp) — always blocks instantly calls
// ---------------------------------------------------------------------------

describe('hook-policy-check-mcp — P3: instantly MCP always blocked', () => {
  it('blocks mcp__rgos__instantly_activate_campaign', () => {
    const r = runHook(MCP_HOOK_PATH, 'mcp__rgos__instantly_activate_campaign', {}, 'orchestrator');
    expect(r.decision).toBe('block');
    expect(r.exitCode).toBe(0);
  });

  it('blocks mcp__rgos__instantly_pause_campaign', () => {
    const r = runHook(MCP_HOOK_PATH, 'mcp__rgos__instantly_pause_campaign', {}, 'dev');
    expect(r.decision).toBe('block');
  });

  it('exits 0 (block is communicated via stdout JSON, not non-zero exit)', () => {
    const r = runHook(MCP_HOOK_PATH, 'mcp__rgos__instantly_activate_campaign', {}, 'orchestrator');
    expect(r.exitCode).toBe(0);
  });
});
