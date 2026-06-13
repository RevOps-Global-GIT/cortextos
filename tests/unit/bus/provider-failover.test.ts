import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { CronDefinition } from '../../../src/types/index';

let tmpRoot: string;
const originalCtxRoot = process.env.CTX_ROOT;

function cron(name: string, enabled = true): CronDefinition {
  return {
    name,
    prompt: `Run ${name}`,
    schedule: '1h',
    enabled,
    created_at: '2026-06-12T00:00:00.000Z',
  };
}

async function importModules() {
  vi.resetModules();
  const failover = await import('../../../src/bus/provider-failover.js');
  const crons = await import('../../../src/bus/crons.js');
  return { failover, crons };
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'provider-failover-test-'));
  process.env.CTX_ROOT = tmpRoot;
});

afterEach(() => {
  if (originalCtxRoot !== undefined) process.env.CTX_ROOT = originalCtxRoot;
  else delete process.env.CTX_ROOT;
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('planProviderFailover', () => {
  it('selects the first available fallback when current provider is capped', async () => {
    const { failover } = await importModules();

    const plan = failover.planProviderFailover({
      currentProviderId: 'claude',
      preferredProviderIds: ['claude', 'codex', 'gemini'],
      providerHealth: {
        claude: { state: 'capped', reason: 'Claude session limit reset in 3h' },
        codex: { state: 'available' },
        gemini: { state: 'unknown' },
      },
      cronNames: ['morning-review', 'hero-publish-watchdog', 'wip-enforcer'],
      degradedCronAllowlist: ['hero-publish-watchdog'],
    });

    expect(plan.selectedProviderId).toBe('codex');
    expect(plan.shouldSwitch).toBe(true);
    expect(plan.degradedMode).toBe(true);
    expect(plan.cronsToDisable).toEqual(['morning-review', 'wip-enforcer']);
    expect(plan.reason).toContain('claude capped');
  });

  it('keeps current provider and avoids degraded mode when it is healthy', async () => {
    const { failover } = await importModules();

    const plan = failover.planProviderFailover({
      currentProviderId: 'codex',
      preferredProviderIds: ['claude', 'codex'],
      providerHealth: {
        claude: { state: 'capped' },
        codex: { state: 'available' },
      },
      cronNames: ['morning-review'],
      degradedCronAllowlist: [],
    });

    expect(plan.selectedProviderId).toBe('codex');
    expect(plan.shouldSwitch).toBe(false);
    expect(plan.degradedMode).toBe(false);
    expect(plan.cronsToDisable).toEqual([]);
  });
});

describe('applyFailoverCronPlan / restoreFailoverCrons', () => {
  it('persists prior cron state, disables non-allowlisted enabled crons, and restores exactly', async () => {
    const { failover, crons } = await importModules();
    crons.writeCrons('orchestrator', [
      cron('morning-review', true),
      cron('hero-publish-watchdog', true),
      cron('already-paused', false),
    ]);

    const state = failover.applyFailoverCronPlan({
      agentName: 'orchestrator',
      selectedProviderId: 'codex',
      previousProviderId: 'claude',
      cronsToDisable: ['morning-review', 'already-paused'],
      reason: 'claude capped',
      stateRoot: tmpRoot,
    });

    expect(state.disabledCronNames).toEqual(['morning-review']);
    expect(crons.readCrons('orchestrator').map(c => [c.name, c.enabled])).toEqual([
      ['morning-review', false],
      ['hero-publish-watchdog', true],
      ['already-paused', false],
    ]);

    const statePath = join(tmpRoot, 'state', 'provider-failover', 'orchestrator.json');
    expect(existsSync(statePath)).toBe(true);
    expect(JSON.parse(readFileSync(statePath, 'utf-8')).previous_provider_id).toBe('claude');

    const restore = failover.restoreFailoverCrons({
      agentName: 'orchestrator',
      stateRoot: tmpRoot,
    });

    expect(restore.restoredCronNames).toEqual(['morning-review']);
    expect(crons.readCrons('orchestrator').map(c => [c.name, c.enabled])).toEqual([
      ['morning-review', true],
      ['hero-publish-watchdog', true],
      ['already-paused', false],
    ]);
  });

  it('is idempotent when applied twice to the same active failover', async () => {
    const { failover, crons } = await importModules();
    crons.writeCrons('orchestrator', [cron('morning-review', true)]);

    failover.applyFailoverCronPlan({
      agentName: 'orchestrator',
      selectedProviderId: 'codex',
      previousProviderId: 'claude',
      cronsToDisable: ['morning-review'],
      reason: 'claude capped',
      stateRoot: tmpRoot,
    });
    const state = failover.applyFailoverCronPlan({
      agentName: 'orchestrator',
      selectedProviderId: 'codex',
      previousProviderId: 'claude',
      cronsToDisable: ['morning-review'],
      reason: 'claude capped',
      stateRoot: tmpRoot,
    });

    expect(state.disabledCronNames).toEqual(['morning-review']);
    expect(failover.restoreFailoverCrons({
      agentName: 'orchestrator',
      stateRoot: tmpRoot,
    }).restoredCronNames).toEqual(['morning-review']);
  });
});
