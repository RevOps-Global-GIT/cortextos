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

  it('treats Palette/Bolt ob1-app PRs as manual-review-only', () => {
    vi.mocked(execFileSync).mockReturnValue(JSON.stringify([
      {
        number: 342,
        title: '⚡ Bolt: Use cached Intl.DateTimeFormat for faster date rendering',
        url: 'https://github.com/RevOps-Global-GIT/ob1-app/pull/342',
        createdAt: '2026-05-01T00:00:00Z',
        updatedAt: '2026-05-01T00:00:00Z',
        headRefName: 'bolt-cached-datetime-formatter-4368978276833109193',
        author: { login: 'revopsglobal' },
        reviewDecision: null,
        mergeStateStatus: 'CLEAN',
        statusCheckRollup: [{ conclusion: 'SUCCESS' }],
        labels: [],
        reviews: [],
        isDraft: false,
      },
      {
        number: 343,
        title: '🎨 Palette: Improve Vendor Form Accessibility & UX',
        url: 'https://github.com/RevOps-Global-GIT/ob1-app/pull/343',
        createdAt: '2026-05-01T00:00:00Z',
        updatedAt: '2026-05-01T00:00:00Z',
        headRefName: 'jules-3860853350944772031-17d4f227',
        author: { login: 'revopsglobal' },
        reviewDecision: null,
        mergeStateStatus: 'CLEAN',
        statusCheckRollup: [{ conclusion: 'SUCCESS' }],
        labels: [],
        reviews: [],
        isDraft: false,
      },
      {
        number: 999,
        title: 'Regular ob1-app PR from a contributor',
        url: 'https://github.com/RevOps-Global-GIT/ob1-app/pull/999',
        createdAt: '2026-05-01T00:00:00Z',
        updatedAt: '2026-05-01T00:00:00Z',
        headRefName: 'feat/contributor-fix',
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
    const result = runPrStuckWatcher(makePaths(root), 'analyst', 'revops-global', {
      repos: ['RevOps-Global-GIT/ob1-app'],
      stuckHours: 1,
      alertHours: 1,
      outputDir,
    });

    const bolt = result.stuckPrs.find(pr => pr.number === 342);
    const palette = result.stuckPrs.find(pr => pr.number === 343);
    const regular = result.stuckPrs.find(pr => pr.number === 999);

    expect(bolt).toMatchObject({
      isManualReviewOnly: true,
      autoMergeEligible: false,
      alertSuppressedReason: 'manual review only',
    });
    expect(palette).toMatchObject({
      isManualReviewOnly: true,
      autoMergeEligible: false,
      alertSuppressedReason: 'manual review only',
    });
    expect(regular).toMatchObject({
      isManualReviewOnly: false,
      autoMergeEligible: true,
      alertSuppressedReason: null,
    });

    expect(result.alertPrs.map(pr => pr.number)).toEqual([999]);
  });

  it('treats Palette/Bolt PRs in non-ob1-app repos as manual-review-only', () => {
    vi.mocked(execFileSync).mockReturnValue(JSON.stringify([
      {
        number: 50,
        title: '⚡ Bolt: cross-repo bolt PR on cortextos',
        url: 'https://github.com/RevOps-Global-GIT/cortextos/pull/50',
        createdAt: '2026-05-01T00:00:00Z',
        updatedAt: '2026-05-01T00:00:00Z',
        headRefName: 'bolt-foo',
        author: { login: 'dev' },
        reviewDecision: null,
        mergeStateStatus: 'CLEAN',
        statusCheckRollup: [{ conclusion: 'SUCCESS' }],
        labels: [],
        reviews: [],
        isDraft: false,
      },
      {
        number: 51,
        title: '🎨 Palette: cross-repo palette PR on rgos',
        url: 'https://github.com/RevOps-Global-GIT/rgos/pull/51',
        createdAt: '2026-05-01T00:00:00Z',
        updatedAt: '2026-05-01T00:00:00Z',
        headRefName: 'jules-foo',
        author: { login: 'dev' },
        reviewDecision: null,
        mergeStateStatus: 'CLEAN',
        statusCheckRollup: [{ conclusion: 'SUCCESS' }],
        labels: [],
        reviews: [],
        isDraft: false,
      },
    ]));

    const result = runPrStuckWatcher(makePaths(root), 'analyst', 'revops-global', {
      repos: ['RevOps-Global-GIT/cortextos', 'RevOps-Global-GIT/rgos'],
      stuckHours: 1,
      alertHours: 1,
    });

    expect(result.stuckPrs.find(pr => pr.number === 50)).toMatchObject({
      isManualReviewOnly: true,
      autoMergeEligible: false,
    });
    expect(result.stuckPrs.find(pr => pr.number === 51)).toMatchObject({
      isManualReviewOnly: true,
      autoMergeEligible: false,
    });
    expect(result.alertPrs.map(pr => pr.number)).toEqual([]);
  });

  it('treats claude OB1 PRs as manual-review-only without suppressing other claude branches', () => {
    vi.mocked(execFileSync)
      .mockReturnValueOnce(JSON.stringify([
        {
          number: 60,
          title: 'Cowork ob1-app lane',
          url: 'https://github.com/RevOps-Global-GIT/ob1-app/pull/60',
          createdAt: '2026-05-01T00:00:00Z',
          updatedAt: '2026-05-01T00:00:00Z',
          headRefName: 'claude/fix-signup-flow',
          author: { login: 'claude' },
          reviewDecision: null,
          mergeStateStatus: 'CLEAN',
          statusCheckRollup: [{ conclusion: 'SUCCESS' }],
          labels: [],
          reviews: [],
          isDraft: false,
        },
      ]))
      .mockReturnValueOnce(JSON.stringify([
        {
          number: 61,
          title: 'Cowork ob1-parents lane',
          url: 'https://github.com/RevOps-Global-GIT/ob1-parents/pull/61',
          createdAt: '2026-05-01T00:00:00Z',
          updatedAt: '2026-05-01T00:00:00Z',
          headRefName: 'CLAUDE/fix-family-view',
          author: { login: 'claude' },
          reviewDecision: null,
          mergeStateStatus: 'CLEAN',
          statusCheckRollup: [{ conclusion: 'SUCCESS' }],
          labels: [],
          reviews: [],
          isDraft: false,
        },
      ]))
      .mockReturnValueOnce(JSON.stringify([
        {
          number: 62,
          title: 'Regular claude branch on rgos',
          url: 'https://github.com/RevOps-Global-GIT/rgos/pull/62',
          createdAt: '2026-05-01T00:00:00Z',
          updatedAt: '2026-05-01T00:00:00Z',
          headRefName: 'claude/fix-dashboard',
          author: { login: 'claude' },
          reviewDecision: null,
          mergeStateStatus: 'CLEAN',
          statusCheckRollup: [{ conclusion: 'SUCCESS' }],
          labels: [],
          reviews: [],
          isDraft: false,
        },
      ]));

    const result = runPrStuckWatcher(makePaths(root), 'analyst', 'revops-global', {
      repos: ['RevOps-Global-GIT/ob1-app', 'RevOps-Global-GIT/ob1-parents', 'RevOps-Global-GIT/rgos'],
      stuckHours: 1,
      alertHours: 1,
    });

    expect(result.stuckPrs.find(pr => pr.number === 60)).toMatchObject({
      isManualReviewOnly: true,
      autoMergeEligible: false,
      alertSuppressedReason: 'manual review only',
    });
    expect(result.stuckPrs.find(pr => pr.number === 61)).toMatchObject({
      isManualReviewOnly: true,
      autoMergeEligible: false,
      alertSuppressedReason: 'manual review only',
    });
    expect(result.stuckPrs.find(pr => pr.number === 62)).toMatchObject({
      isManualReviewOnly: false,
      autoMergeEligible: true,
      alertSuppressedReason: null,
    });
    expect(result.alertPrs.map(pr => pr.number)).toEqual([62]);
  });
});
