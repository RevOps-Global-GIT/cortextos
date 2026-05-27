import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

describe('agent health semantics', () => {
  let tmpRoot: string;
  let tmpFramework: string;

  beforeEach(() => {
    vi.resetModules();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-health-root-'));
    tmpFramework = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-health-framework-'));
    process.env.CTX_ROOT = tmpRoot;
    process.env.CTX_FRAMEWORK_ROOT = tmpFramework;

    writeJson(path.join(tmpRoot, 'config/enabled-agents.json'), {
      active: { enabled: true, org: 'revops-global' },
      'night-agent': { enabled: true, org: 'revops-global' },
      'disabled-agent': { enabled: false, org: 'revops-global' },
    });

    for (const name of ['active', 'night-agent', 'disabled-agent']) {
      fs.mkdirSync(path.join(tmpFramework, 'orgs/revops-global/agents', name), { recursive: true });
    }

    const now = Date.now();
    writeJson(path.join(tmpRoot, 'state/active/heartbeat.json'), {
      org: 'revops-global',
      mode: 'day',
      last_heartbeat: new Date(now - 60_000).toISOString(),
    });
    writeJson(path.join(tmpRoot, 'state/night-agent/heartbeat.json'), {
      org: 'revops-global',
      mode: 'night',
      last_heartbeat: new Date(now - 10 * 60 * 60 * 1000).toISOString(),
    });
    writeJson(path.join(tmpRoot, 'state/disabled-agent/heartbeat.json'), {
      org: 'revops-global',
      mode: 'day',
      last_heartbeat: new Date(now - 10 * 60 * 60 * 1000).toISOString(),
    });
  });

  it('excludes disabled agents and does not treat night-mode stale agents as action-required', async () => {
    const { getAllAgents } = await import('../config');
    const { getHealthSummary } = await import('../data/heartbeats');

    const agents = getAllAgents().map((agent) => agent.name);
    expect(agents).toEqual(expect.arrayContaining(['active', 'night-agent']));
    expect(agents).not.toContain('disabled-agent');

    const summary = await getHealthSummary('revops-global');
    const night = summary.agents.find((agent) => agent.agent === 'night-agent');
    const disabled = summary.agents.find((agent) => agent.agent === 'disabled-agent');

    expect(disabled).toBeUndefined();
    expect(night).toMatchObject({
      health: 'stale',
      mode: 'night',
      needsAttention: false,
      attentionLabel: 'Night mode',
    });
    expect(summary.agents.filter((agent) => agent.needsAttention)).toHaveLength(0);
  });
});
