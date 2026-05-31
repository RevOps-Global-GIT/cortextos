import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { BusPaths } from '../../../src/types/index.js';

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('../../../src/bus/rgos-mirror.js', () => ({
  mirrorEventToRgos: vi.fn().mockResolvedValue(undefined),
}));

import { execFileSync } from 'child_process';
import { runPrStuckWatcher } from '../../../src/bus/pr-stuck-watcher.js';

function makePaths(root: string): BusPaths {
  return {
    ctxRoot: root,
    inbox: join(root, 'inbox'),
    inflight: join(root, 'inflight'),
    processed: join(root, 'processed'),
    logDir: join(root, 'logs'),
    stateDir: join(root, 'state'),
    taskDir: join(root, 'tasks'),
    approvalDir: join(root, 'approvals'),
    analyticsDir: join(root, 'analytics'),
    deliverablesDir: join(root, 'deliverables'),
  };
}

describe('pr-stuck-watcher', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cortextos-pr-stuck-'));
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps awaiting-Greg PRs in the report but suppresses alerts', () => {
    vi.mocked(execFileSync).mockReturnValue(JSON.stringify([
      {
        number: 10,
        title: 'Blocked until product decision',
        url: 'https://github.com/acme/repo/pull/10',
        createdAt: '2026-05-01T00:00:00Z',
        updatedAt: '2026-05-01T00:00:00Z',
        author: { login: 'dev' },
        reviewDecision: null,
        mergeStateStatus: 'CLEAN',
        statusCheckRollup: [{ conclusion: 'SUCCESS' }],
        labels: [{ name: 'awaiting Greg' }],
        reviews: [],
      },
      {
        number: 11,
        title: 'Normal stuck PR',
        url: 'https://github.com/acme/repo/pull/11',
        createdAt: '2026-05-01T00:00:00Z',
        updatedAt: '2026-05-01T00:00:00Z',
        author: { login: 'dev' },
        reviewDecision: null,
        mergeStateStatus: 'CLEAN',
        statusCheckRollup: [{ conclusion: 'SUCCESS' }],
        labels: [],
        reviews: [],
      },
    ]));

    const outputDir = join(root, 'output');
    const result = runPrStuckWatcher(makePaths(root), 'codex', 'revops-global', {
      repos: ['acme/repo'],
      stuckHours: 1,
      alertHours: 1,
      outputDir,
    });

    expect(result.stuckPrs.map(pr => pr.number)).toEqual([10, 11]);
    expect(result.stuckPrs.find(pr => pr.number === 10)).toMatchObject({
      awaitingGreg: true,
      alertSuppressedReason: 'awaiting Greg',
    });
    expect(result.alertPrs.map(pr => pr.number)).toEqual([11]);

    const report = readFileSync(result.reportPath!, 'utf-8');
    expect(report).toContain('awaiting Greg');
    expect(report).toContain('Normal stuck PR');
  });

  it('keeps draft PRs in the report but suppresses alerts', () => {
    vi.mocked(execFileSync).mockReturnValue(JSON.stringify([
      {
        number: 20,
        title: 'WIP draft PR',
        url: 'https://github.com/acme/repo/pull/20',
        createdAt: '2026-05-01T00:00:00Z',
        updatedAt: '2026-05-01T00:00:00Z',
        author: { login: 'dev' },
        reviewDecision: null,
        mergeStateStatus: 'CLEAN',
        statusCheckRollup: [{ conclusion: 'SUCCESS' }],
        labels: [],
        reviews: [],
        isDraft: true,
      },
      {
        number: 21,
        title: 'Normal stuck PR',
        url: 'https://github.com/acme/repo/pull/21',
        createdAt: '2026-05-01T00:00:00Z',
        updatedAt: '2026-05-01T00:00:00Z',
        author: { login: 'dev' },
        reviewDecision: null,
        mergeStateStatus: 'CLEAN',
        statusCheckRollup: [{ conclusion: 'SUCCESS' }],
        labels: [],
        reviews: [],
        isDraft: false,
      },
    ]));

    const outputDir = join(root, 'output');
    const result = runPrStuckWatcher(makePaths(root), 'codex', 'revops-global', {
      repos: ['acme/repo'],
      stuckHours: 1,
      alertHours: 1,
      outputDir,
    });

    expect(result.stuckPrs.map(pr => pr.number)).toEqual([20, 21]);
    expect(result.stuckPrs.find(pr => pr.number === 20)).toMatchObject({
      isDraft: true,
      alertSuppressedReason: 'draft',
    });
    expect(result.alertPrs.map(pr => pr.number)).toEqual([21]);
  });
});
