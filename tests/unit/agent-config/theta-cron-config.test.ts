import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

interface AgentConfig {
  crons: Array<{
    name: string;
    cron?: string;
    prompt?: string;
    metadata?: Record<string, unknown>;
  }>;
}

describe('analyst theta cron config', () => {
  const config = JSON.parse(readFileSync(
    resolve(process.cwd(), 'orgs/revops-global/agents/analyst/config.json'),
    'utf8',
  )) as AgentConfig;

  it('runs theta-wave through spawn-codex prompt_file artifacts', () => {
    const theta = config.crons.find(cron => cron.name === 'theta-wave');

    expect(theta).toMatchObject({
      cron: '0 22 * * *',
      metadata: {
        runner: 'spawn-codex',
        prompt_file: 'agents/analyst/prompts/cron-theta-wave.md',
        workdir: 'agents/analyst',
        agent: 'analyst',
        task_id: 'cron:analyst:theta-wave',
      },
    });
    expect(theta?.prompt).toContain('artifact-backed');
  });

  it('adds a separate read-only theta freshness watchdog cron', () => {
    const watchdog = config.crons.find(cron => cron.name === 'theta-freshness-watchdog');

    expect(watchdog).toMatchObject({
      cron: '30 23 * * *',
      metadata: {
        runner: 'spawn-codex',
        prompt_file: 'agents/analyst/prompts/cron-theta-freshness-watchdog.md',
        workdir: 'agents/analyst',
        agent: 'analyst',
        task_id: 'cron:analyst:theta-freshness-watchdog',
      },
    });
    expect(watchdog?.prompt).toContain('read-only theta freshness watchdog');
  });
});
