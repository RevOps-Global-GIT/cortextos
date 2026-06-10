import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildAutomationRegistry } from '../automation-registry';

let tempDirs: string[] = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automation-registry-'));
  tempDirs.push(dir);
  return dir;
}

function writeJson(filePath: string, data: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe('buildAutomationRegistry', () => {
  it('surfaces daemon cron source, owner, cadence, status, notification behavior, and next action', () => {
    const ctxRoot = makeTempDir();
    const dashboardRoot = makeTempDir();
    const now = new Date('2026-05-26T12:00:00.000Z');
    const agentState = path.join(ctxRoot, '.cortextOS/state/agents/codex-2');

    writeJson(path.join(agentState, 'crons.json'), {
      crons: [
        {
          name: 'rgos-task-poll',
          schedule: '5m',
          prompt: 'Check for tasks. If no tasks, do nothing. Log a cortextos bus log-event for each claimed task.',
          enabled: true,
          last_fired_at: '2026-05-26T11:58:00.000Z',
        },
      ],
    });
    fs.writeFileSync(
      path.join(agentState, 'cron-execution.log'),
      JSON.stringify({
        ts: '2026-05-26T11:58:00.000Z',
        cron: 'rgos-task-poll',
        status: 'fired',
        attempt: 1,
        duration_ms: 50,
        error: null,
      }) + '\n',
    );
    writeJson(path.join(dashboardRoot, 'src/data/capability-monitor.json'), { capabilities: [] });

    const registry = buildAutomationRegistry({
      ctxRoot,
      dashboardRoot,
      agents: [{ name: 'codex-2', org: 'revops-global' }],
      now,
    });

    expect(registry.summary.total).toBe(1);
    expect(registry.summary.ok).toBe(1);
    expect(registry.surface).toBe('fleet-schedules/automation-registry');
    expect(registry.filters.owners).toContain('codex-2');
    expect(registry.filters.cadences).toContain('5m');
    expect(registry.filters.notificationBehaviors).toContain('quiet unless drift, errors, or assigned work appear');
    expect(registry.items[0]).toMatchObject({
      sourceType: 'cron',
      source: 'daemon cron: codex-2/rgos-task-poll',
      owner: 'codex-2',
      cadence: '5m',
      status: 'ok',
      notificationBehavior: 'quiet unless drift, errors, or assigned work appear',
      duplicateCount: 1,
      nextAction: 'No action required; monitor next scheduled fire.',
    });
  });

  it('adds capability monitor rows and marks blocked capabilities as high-risk action items', () => {
    const ctxRoot = makeTempDir();
    const dashboardRoot = makeTempDir();

    writeJson(path.join(dashboardRoot, 'src/data/capability-monitor.json'), {
      defaultCadence: 'hourly probes',
      capabilities: [
        {
          id: 'linkedin_session',
          label: 'LinkedIn Session',
          currentStatus: 'blocked',
          freshnessTarget: 'validated daily',
          lastCheckedAt: '2026-05-26T11:00:00.000Z',
          lastAuthority: 'LinkedIn-Session browser',
          observed: 'No linkedin-cookies.json found',
          renewalPath: 'Human or approved browser-auth lane',
        },
      ],
    });

    const registry = buildAutomationRegistry({
      ctxRoot,
      dashboardRoot,
      agents: [],
      now: new Date('2026-05-26T12:00:00.000Z'),
    });

    expect(registry.summary.total).toBe(1);
    expect(registry.summary.blocked).toBe(1);
    expect(registry.summary.highRisk).toBe(1);
    expect(registry.items[0]).toMatchObject({
      sourceType: 'capability',
      source: 'capability monitor: linkedin_session',
      owner: 'LinkedIn-Session browser',
      cadence: 'validated daily',
      status: 'blocked',
      risk: 'high',
      nextAction: 'Human or approved browser-auth lane',
      detail: 'No linkedin-cookies.json found',
    });
  });

  it('groups duplicate owner/cadence/notification rows for registry filtering', () => {
    const ctxRoot = makeTempDir();
    const dashboardRoot = makeTempDir();
    const agentState = path.join(ctxRoot, '.cortextOS/state/agents/codex-2');

    writeJson(path.join(agentState, 'crons.json'), {
      crons: [
        {
          name: 'quiet-a',
          schedule: '30m',
          prompt: 'Run quietly and do nothing if no drift.',
          enabled: true,
        },
        {
          name: 'quiet-b',
          schedule: '30m',
          prompt: 'Run quietly and do nothing if no drift.',
          enabled: true,
        },
      ],
    });
    writeJson(path.join(dashboardRoot, 'src/data/capability-monitor.json'), { capabilities: [] });

    const registry = buildAutomationRegistry({
      ctxRoot,
      dashboardRoot,
      agents: [{ name: 'codex-2', org: 'revops-global' }],
      now: new Date('2026-05-26T12:00:00.000Z'),
    });

    expect(registry.summary.duplicateGroups).toBe(1);
    expect(registry.summary.duplicateRows).toBe(2);
    expect(registry.filters.duplicateGroups).toHaveLength(1);
    expect(registry.items.map(item => item.duplicateCount)).toEqual([2, 2]);
  });
});
