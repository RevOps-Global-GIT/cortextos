import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

describe('dashboard agent registry config', () => {
  let tmpRoot: string;
  let tmpFramework: string;

  beforeEach(() => {
    vi.resetModules();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-config-root-'));
    tmpFramework = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-config-framework-'));
    process.env.CTX_ROOT = tmpRoot;
    process.env.CTX_FRAMEWORK_ROOT = tmpFramework;
  });

  it('hides status=deleted registry rows and deleted_agents bookkeeping from active agents', async () => {
    writeJson(path.join(tmpRoot, 'config/enabled-agents.json'), {
      active: { enabled: true, org: 'revops-global' },
      'deleted-agent': { enabled: false, status: 'deleted', org: 'revops-global' },
      deleted_agents: {
        'deleted-agent': {
          deleted_at: '2026-05-27T05:41:00Z',
          reason: 'removed from active namespace',
        },
      },
    });

    for (const name of ['active', 'deleted-agent']) {
      fs.mkdirSync(path.join(tmpFramework, 'orgs/revops-global/agents', name), { recursive: true });
    }

    const { getAllAgents } = await import('../config');
    const agents = getAllAgents().map((agent) => agent.name);

    expect(agents).toEqual(['active']);
    expect(agents).not.toContain('deleted-agent');
    expect(agents).not.toContain('deleted_agents');
  });
});
