import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ---------------------------------------------------------------------------
// Mock global fetch so no real network calls are made.
// ---------------------------------------------------------------------------
const fetchSpy = vi.fn();
vi.stubGlobal('fetch', fetchSpy);

import { logImplicitInvocation, SUBCOMMAND_SKILL_MAP } from '../../../src/bus/skill-instrument';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakeAgentDir(root: string, sbUrl = 'https://sb.example.com', sbKey = 'test-key'): string {
  const agentDir = join(root, 'agent');
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, '.env'),
    `BOT_TOKEN=x\nSUPABASE_RGOS_URL=${sbUrl}\nSUPABASE_RGOS_SERVICE_KEY=${sbKey}\n`,
  );
  return agentDir;
}

/** Make fetch return a minimal ok response for every call. */
function mockFetchOk() {
  fetchSpy.mockResolvedValue({
    ok: true,
    json: async () => [],
  });
}

describe('SUBCOMMAND_SKILL_MAP', () => {
  it('maps the 5 canonical bus commands to skill slugs', () => {
    expect(SUBCOMMAND_SKILL_MAP['update-heartbeat']).toBe('heartbeat');
    expect(SUBCOMMAND_SKILL_MAP['create-approval']).toBe('approvals');
    expect(SUBCOMMAND_SKILL_MAP['log-event']).toBe('event-logging');
    expect(SUBCOMMAND_SKILL_MAP['send-message']).toBe('comms');
    expect(SUBCOMMAND_SKILL_MAP['create-task']).toBe('tasks');
  });
});

describe('logImplicitInvocation', () => {
  let tmpRoot: string;
  const originalSupabaseUrl = process.env.SUPABASE_RGOS_URL;
  const originalRgosSupabaseUrl = process.env.RGOS_SUPABASE_URL;
  const originalSupabaseKey = process.env.SUPABASE_RGOS_SERVICE_KEY;
  const originalRgosSupabaseKey = process.env.RGOS_SUPABASE_SERVICE_KEY;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'skill-instrument-'));
    fetchSpy.mockReset();
    mockFetchOk();
    delete process.env.SUPABASE_RGOS_URL;
    delete process.env.RGOS_SUPABASE_URL;
    delete process.env.SUPABASE_RGOS_SERVICE_KEY;
    delete process.env.RGOS_SUPABASE_SERVICE_KEY;
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    if (originalSupabaseUrl === undefined) delete process.env.SUPABASE_RGOS_URL;
    else process.env.SUPABASE_RGOS_URL = originalSupabaseUrl;
    if (originalRgosSupabaseUrl === undefined) delete process.env.RGOS_SUPABASE_URL;
    else process.env.RGOS_SUPABASE_URL = originalRgosSupabaseUrl;
    if (originalSupabaseKey === undefined) delete process.env.SUPABASE_RGOS_SERVICE_KEY;
    else process.env.SUPABASE_RGOS_SERVICE_KEY = originalSupabaseKey;
    if (originalRgosSupabaseKey === undefined) delete process.env.RGOS_SUPABASE_SERVICE_KEY;
    else process.env.RGOS_SUPABASE_SERVICE_KEY = originalRgosSupabaseKey;
  });

  it('inserts a row for heartbeat skill', async () => {
    const agentDir = makeFakeAgentDir(tmpRoot);
    await logImplicitInvocation('heartbeat', agentDir, 'dev');

    const insertCall = fetchSpy.mock.calls.find(
      ([url]: [string]) => url.includes('/orch_skill_invocations'),
    );
    expect(insertCall).toBeDefined();
    const body = JSON.parse(insertCall[1].body);
    expect(body.skill_slug).toBe('heartbeat');
    expect(body.source).toBe('bus_implicit');
    expect(body.succeeded).toBe(true);
    expect(body.agent_role).toBe('dev');
  });

  it('inserts a row for approvals skill', async () => {
    const agentDir = makeFakeAgentDir(tmpRoot);
    await logImplicitInvocation('approvals', agentDir, 'orchestrator');

    const insertCall = fetchSpy.mock.calls.find(
      ([url]: [string]) => url.includes('/orch_skill_invocations'),
    );
    expect(insertCall).toBeDefined();
    const body = JSON.parse(insertCall[1].body);
    expect(body.skill_slug).toBe('approvals');
  });

  it('inserts a row for event-logging skill', async () => {
    const agentDir = makeFakeAgentDir(tmpRoot);
    await logImplicitInvocation('event-logging', agentDir, 'analyst');

    const insertCall = fetchSpy.mock.calls.find(
      ([url]: [string]) => url.includes('/orch_skill_invocations'),
    );
    expect(insertCall).toBeDefined();
    const body = JSON.parse(insertCall[1].body);
    expect(body.skill_slug).toBe('event-logging');
  });

  it('inserts a row for comms skill', async () => {
    const agentDir = makeFakeAgentDir(tmpRoot);
    await logImplicitInvocation('comms', agentDir, 'dev');

    const insertCall = fetchSpy.mock.calls.find(
      ([url]: [string]) => url.includes('/orch_skill_invocations'),
    );
    expect(insertCall).toBeDefined();
    const body = JSON.parse(insertCall[1].body);
    expect(body.skill_slug).toBe('comms');
  });

  it('inserts a row for tasks skill', async () => {
    const agentDir = makeFakeAgentDir(tmpRoot);
    await logImplicitInvocation('tasks', agentDir, 'dev');

    const insertCall = fetchSpy.mock.calls.find(
      ([url]: [string]) => url.includes('/orch_skill_invocations'),
    );
    expect(insertCall).toBeDefined();
    const body = JSON.parse(insertCall[1].body);
    expect(body.skill_slug).toBe('tasks');
  });

  it('can insert a cron-sourced row', async () => {
    const agentDir = makeFakeAgentDir(tmpRoot);
    await logImplicitInvocation('heartbeat', agentDir, 'codex-3', { source: 'cron' });

    const insertCall = fetchSpy.mock.calls.find(
      ([url]: [string]) => url.includes('/orch_skill_invocations'),
    );
    expect(insertCall).toBeDefined();
    const body = JSON.parse(insertCall[1].body);
    expect(body.skill_slug).toBe('heartbeat');
    expect(body.source).toBe('cron');
    expect(body.agent_role).toBe('codex-3');
  });

  it('falls back to org-level secrets.env when agent .env lacks Supabase credentials', async () => {
    const agentDir = join(tmpRoot, 'orgs', 'revops-global', 'agents', 'codex-3');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, '.env'), 'BOT_TOKEN=x\n');
    writeFileSync(join(tmpRoot, 'orgs', 'revops-global', 'secrets.env'), [
      'SUPABASE_RGOS_URL=https://org.example.com',
      'SUPABASE_RGOS_SERVICE_KEY=org-key',
      '',
    ].join('\n'));

    await logImplicitInvocation('heartbeat', agentDir, 'codex-3', { source: 'cron' });

    const insertCall = fetchSpy.mock.calls.find(
      ([url]: [string]) => url.includes('/orch_skill_invocations'),
    );
    expect(insertCall).toBeDefined();
    expect(insertCall[0]).toBe('https://org.example.com/rest/v1/orch_skill_invocations');
    expect(insertCall[1].headers.Authorization).toBe('Bearer org-key');
  });

  it('silently no-ops when .env is missing', async () => {
    const emptyDir = join(tmpRoot, 'no-env-agent');
    mkdirSync(emptyDir, { recursive: true });
    // Should not throw
    await expect(logImplicitInvocation('heartbeat', emptyDir)).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('silently no-ops when Supabase credentials are absent from .env', async () => {
    const agentDir = join(tmpRoot, 'no-creds-agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, '.env'), 'BOT_TOKEN=x\n');
    await expect(logImplicitInvocation('tasks', agentDir)).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('silently swallows fetch errors', async () => {
    fetchSpy.mockRejectedValue(new Error('network error'));
    const agentDir = makeFakeAgentDir(tmpRoot);
    await expect(logImplicitInvocation('comms', agentDir, 'dev')).resolves.toBeUndefined();
  });
});
