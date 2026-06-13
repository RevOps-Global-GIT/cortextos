import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { syncExperimentToSupabase, type Experiment } from '../../../src/bus/experiment';
import { REVOPS_ORG_UUID } from '../../../src/utils/revops-authz';

// Regression target: src/bus/experiment.ts hardcodes the RevOps org_id on both
// orch_experiments AND the paired orch_approvals row. With shared Supabase
// service creds, an unknown/default-org cortextOS instance could bleed rows
// into the RevOps approval queue (the "nick" case: an external instance wrote
// approvals into RevOps org a1b2c3d4 on 2026-06-12). The org-write guard must
// reject any writer that is not a provisioned, enabled revops-global agent,
// BEFORE any Supabase write, while authorized revops-global agents still sync.

let testDir: string;      // acts as CTX_ROOT (holds config/enabled-agents.json)
let frameworkRoot: string; // holds orgs/<org>/agents/<agent>

function mkExperiment(overrides: Partial<Experiment> = {}): Experiment {
  return {
    id: 'exp_test_1',
    agent: 'dev',
    metric: 'p90_latency',
    hypothesis: 'Caching reduces p90 latency',
    surface: 'api',
    direction: 'lower',
    window: '7d',
    measurement: 'p90 via otel',
    status: 'proposed',
    baseline_value: 100,
    result_value: null,
    score: null,
    decision: null,
    learning: '',
    experiment_commit: null,
    tracking_commit: null,
    created_at: new Date().toISOString(),
    started_at: null,
    completed_at: null,
    changes_description: null,
    ...overrides,
  };
}

// Provision an enabled revops-global agent: framework agent dir with
// config.json + a matching enabled-agents.json registry entry. Returns the
// agentDir (which is what syncExperimentToSupabase receives).
function provisionRevopsAgent(agentName = 'dev'): string {
  const agentDir = join(frameworkRoot, 'orgs', 'revops-global', 'agents', agentName);
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, 'config.json'), JSON.stringify({ agent_name: agentName }));

  const configDir = join(testDir, 'config');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'enabled-agents.json'), JSON.stringify({
    [agentName]: { enabled: true, status: 'configured', org: 'revops-global' },
  }));
  return agentDir;
}

function okFetch() {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => [{ id: '00000000-0000-0000-0000-0000000000ff' }],
  });
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'cortextos-exp-guard-ctx-'));
  frameworkRoot = mkdtempSync(join(tmpdir(), 'cortextos-exp-guard-fw-'));
  process.env.CTX_ROOT = testDir;
  // Credentials present so the function does not early-skip on missing creds —
  // the guard must be the thing that stops unauthorized writers, not the
  // absence of creds (the real bleed had valid shared creds).
  process.env.SUPABASE_RGOS_URL = 'https://example.supabase.co';
  process.env.SUPABASE_RGOS_SERVICE_KEY = 'service-key';
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  rmSync(frameworkRoot, { recursive: true, force: true });
  delete process.env.CTX_ROOT;
  delete process.env.SUPABASE_RGOS_URL;
  delete process.env.SUPABASE_RGOS_SERVICE_KEY;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('syncExperimentToSupabase org-write guard', () => {
  it('ALLOWS a provisioned, enabled revops-global agent and writes both orch_approvals and orch_experiments with the RevOps org_id', async () => {
    const agentDir = provisionRevopsAgent('dev');
    const fetchSpy = okFetch();
    vi.stubGlobal('fetch', fetchSpy);

    await syncExperimentToSupabase(mkExperiment({ agent: 'dev' }), agentDir);

    // proposed experiment → createApprovalRow (orch_approvals) then INSERT (orch_experiments)
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const urls = fetchSpy.mock.calls.map((c) => c[0] as string);
    expect(urls.some((u) => u.includes('/rest/v1/orch_approvals'))).toBe(true);
    expect(urls.some((u) => u.includes('/rest/v1/orch_experiments'))).toBe(true);

    for (const [, init] of fetchSpy.mock.calls as Array<[string, RequestInit]>) {
      const body = JSON.parse(init.body as string);
      expect(body.org_id).toBe(REVOPS_ORG_UUID);
    }
  });

  it('REPLAY GUARD: BLOCKS an unknown writer (nick) not in enabled-agents.json before any Supabase write', async () => {
    // The real incident: an external instance wrote into revops-global org
    // a1b2c3d4 as an agent that is NOT provisioned in this fleet. Provision a
    // legit agent so the registry exists, but route the write through "nick".
    provisionRevopsAgent('dev');
    const nickDir = join(frameworkRoot, 'orgs', 'revops-global', 'agents', 'nick');
    mkdirSync(nickDir, { recursive: true });
    writeFileSync(join(nickDir, 'config.json'), JSON.stringify({ agent_name: 'nick' }));

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchSpy = okFetch();
    vi.stubGlobal('fetch', fetchSpy);

    await syncExperimentToSupabase(mkExperiment({ agent: 'nick' }), nickDir);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warnSpy.mock.calls.flat().join(' ')).toMatch(/unauthorized writer nick/);
  });

  it('BLOCKS a non-revops org writer (other tenant) before any Supabase write', async () => {
    const otherDir = join(frameworkRoot, 'orgs', 'acme-corp', 'agents', 'bot');
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(join(otherDir, 'config.json'), JSON.stringify({ agent_name: 'bot' }));

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchSpy = okFetch();
    vi.stubGlobal('fetch', fetchSpy);

    await syncExperimentToSupabase(mkExperiment({ agent: 'bot' }), otherDir);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warnSpy.mock.calls.flat().join(' ')).toMatch(/not revops-global/);
  });

  it('BLOCKS a writer whose agentDir does not match the canonical orgs/<org>/agents/<agent> layout', async () => {
    // Simulates the process.cwd() fallback at the CLI call sites — an
    // unparseable path cannot prove authorization, so the write is skipped.
    const strayDir = mkdtempSync(join(tmpdir(), 'cortextos-exp-guard-stray-'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchSpy = okFetch();
    vi.stubGlobal('fetch', fetchSpy);

    await syncExperimentToSupabase(mkExperiment(), strayDir);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warnSpy.mock.calls.flat().join(' ')).toMatch(/not revops-global/);
    rmSync(strayDir, { recursive: true, force: true });
  });

  it('BLOCKS a revops-global agent that is present but disabled in enabled-agents.json', async () => {
    const agentDir = join(frameworkRoot, 'orgs', 'revops-global', 'agents', 'ghost');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'config.json'), JSON.stringify({ agent_name: 'ghost' }));
    const configDir = join(testDir, 'config');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'enabled-agents.json'), JSON.stringify({
      ghost: { enabled: false, status: 'configured', org: 'revops-global' },
    }));

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchSpy = okFetch();
    vi.stubGlobal('fetch', fetchSpy);

    await syncExperimentToSupabase(mkExperiment({ agent: 'ghost' }), agentDir);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warnSpy.mock.calls.flat().join(' ')).toMatch(/unauthorized writer ghost/);
  });
});
