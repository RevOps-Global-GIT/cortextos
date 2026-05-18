import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spawnSync } from 'child_process';
import { join } from 'path';

const HOOK = join(__dirname, '../../../dist/hooks/hook-env-write-guard.js');

function runHook(toolName: string, toolInput: Record<string, unknown>): { stdout: string; status: number } {
  const input = JSON.stringify({ tool_name: toolName, tool_input: toolInput });
  const result = spawnSync(process.execPath, [HOOK], {
    input,
    encoding: 'utf-8',
    timeout: 5000,
  });
  return { stdout: result.stdout || '', status: result.status ?? 1 };
}

describe('hook-env-write-guard — Write tool', () => {
  it('allows Write to non-env file', () => {
    const { stdout, status } = runHook('Write', { file_path: '/tmp/foo.ts', content: 'export default {}' });
    expect(status).toBe(0);
    expect(stdout).toBe(''); // no block decision
  });

  it('allows Write to .env with valid KEY=VALUE content', () => {
    const { stdout, status } = runHook('Write', {
      file_path: '/agents/dev/.env',
      content: 'BOT_TOKEN=abc123\nCHAT_ID=456789\n',
    });
    expect(status).toBe(0);
    expect(stdout).not.toContain('block');
  });

  it('blocks Write to .env with empty content', () => {
    const { stdout, status } = runHook('Write', {
      file_path: '/agents/dev/.env',
      content: '',
    });
    expect(status).toBe(0);
    const decision = JSON.parse(stdout.trim());
    expect(decision.decision).toBe('block');
    expect(decision.reason).toContain('empty');
  });

  it('blocks Write to secrets.env with only comments (no KEY=VALUE)', () => {
    const { stdout, status } = runHook('Write', {
      file_path: '/agents/dev/secrets.env',
      content: '# This is a comment\n# Another comment\n',
    });
    expect(status).toBe(0);
    const decision = JSON.parse(stdout.trim());
    expect(decision.decision).toBe('block');
    expect(decision.reason).toContain('no parseable KEY=VALUE');
  });

  it('blocks Write to activity-channel.env with plain text (no KEY=VALUE)', () => {
    const { stdout, status } = runHook('Write', {
      file_path: '/orgs/revops-global/activity-channel.env',
      content: 'this is not an env file\njust some text\nand more text\n',
    });
    expect(status).toBe(0);
    const decision = JSON.parse(stdout.trim());
    expect(decision.decision).toBe('block');
  });

  it('allows Write to .env.example with valid KEY=VALUE', () => {
    const { stdout, status } = runHook('Write', {
      file_path: '/templates/agent/.env.example',
      content: 'BOT_TOKEN=your_token_here\nCHAT_ID=your_chat_id\n',
    });
    expect(status).toBe(0);
    expect(stdout).not.toContain('block');
  });
});

describe('hook-env-write-guard — Edit tool', () => {
  it('allows Edit to non-env file', () => {
    const { stdout, status } = runHook('Edit', {
      file_path: '/src/utils/env.ts',
      old_string: 'foo',
      new_string: 'bar',
    });
    expect(status).toBe(0);
    expect(stdout).toBe('');
  });

  it('allows short Edit to .env (single-line replacement)', () => {
    const { stdout, status } = runHook('Edit', {
      file_path: '/agents/dev/.env',
      old_string: 'BOT_TOKEN=old',
      new_string: 'BOT_TOKEN=new123',
    });
    expect(status).toBe(0);
    expect(stdout).not.toContain('block');
  });

  it('blocks multi-line Edit to .env with no KEY=VALUE pairs', () => {
    const { stdout, status } = runHook('Edit', {
      file_path: '/agents/dev/.env',
      old_string: 'BOT_TOKEN=abc\nCHAT_ID=123\nALLOWED_USER=greg',
      new_string: 'this is not env\ncontent at all\njust broken text',
    });
    expect(status).toBe(0);
    const decision = JSON.parse(stdout.trim());
    expect(decision.decision).toBe('block');
  });

  it('allows multi-line Edit to .env with valid KEY=VALUE', () => {
    const { stdout, status } = runHook('Edit', {
      file_path: '/agents/dev/.env',
      old_string: 'BOT_TOKEN=old\nCHAT_ID=old\nALLOWED_USER=old',
      new_string: 'BOT_TOKEN=new\nCHAT_ID=456\nALLOWED_USER=greg',
    });
    expect(status).toBe(0);
    expect(stdout).not.toContain('block');
  });
});
