import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { applySecretsToEnv } from '../../../src/utils/env';
import type { CtxEnv } from '../../../src/types/index';

function makeEnv(overrides: Partial<CtxEnv> = {}): CtxEnv {
  return {
    instanceId: 'test',
    ctxRoot: '',
    frameworkRoot: '',
    agentName: 'dev',
    agentDir: overrides.agentDir ?? '',
    org: overrides.org ?? '',
    projectRoot: overrides.projectRoot ?? '',
    timezone: '',
    orchestrator: 'orchestrator',
    ...overrides,
  };
}

describe('applySecretsToEnv', () => {
  let tmpDir: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ctx-env-test-'));
  });

  afterEach(() => {
    // Restore env vars set during test
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function trackEnvKey(key: string) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }

  it('loads SUPABASE_RGOS_URL from org secrets.env into process.env', () => {
    trackEnvKey('SUPABASE_RGOS_URL');

    const orgDir = join(tmpDir, 'orgs', 'test-org');
    mkdirSync(orgDir, { recursive: true });
    writeFileSync(join(orgDir, 'secrets.env'), 'SUPABASE_RGOS_URL=https://test.supabase.co\n');

    applySecretsToEnv(makeEnv({ org: 'test-org', projectRoot: tmpDir }));

    expect(process.env.SUPABASE_RGOS_URL).toBe('https://test.supabase.co');
  });

  it('agent .env overrides org secrets.env for same key', () => {
    trackEnvKey('SUPABASE_RGOS_URL');

    const orgDir = join(tmpDir, 'orgs', 'test-org');
    const agentDir = join(orgDir, 'agents', 'dev');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(orgDir, 'secrets.env'), 'SUPABASE_RGOS_URL=https://org.supabase.co\n');
    writeFileSync(join(agentDir, '.env'), 'SUPABASE_RGOS_URL=https://agent.supabase.co\n');

    applySecretsToEnv(makeEnv({ org: 'test-org', projectRoot: tmpDir, agentDir }));

    expect(process.env.SUPABASE_RGOS_URL).toBe('https://agent.supabase.co');
  });

  it('does not overwrite vars already set in process.env', () => {
    trackEnvKey('SUPABASE_RGOS_URL');
    process.env.SUPABASE_RGOS_URL = 'https://parent-shell.supabase.co';

    const orgDir = join(tmpDir, 'orgs', 'test-org');
    mkdirSync(orgDir, { recursive: true });
    writeFileSync(join(orgDir, 'secrets.env'), 'SUPABASE_RGOS_URL=https://secrets.supabase.co\n');

    applySecretsToEnv(makeEnv({ org: 'test-org', projectRoot: tmpDir }));

    expect(process.env.SUPABASE_RGOS_URL).toBe('https://parent-shell.supabase.co');
  });

  it('no-ops when secrets.env and agent .env are absent', () => {
    trackEnvKey('SUPABASE_RGOS_URL');

    expect(() => applySecretsToEnv(makeEnv())).not.toThrow();
    expect(process.env.SUPABASE_RGOS_URL).toBeUndefined();
  });

  it('loads agent-only key when no org is configured', () => {
    trackEnvKey('BOT_TOKEN');

    const agentDir = join(tmpDir, 'agents', 'dev');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, '.env'), 'BOT_TOKEN=abc123\n');

    applySecretsToEnv(makeEnv({ agentDir }));

    expect(process.env.BOT_TOKEN).toBe('abc123');
    delete process.env.BOT_TOKEN;
  });
});
