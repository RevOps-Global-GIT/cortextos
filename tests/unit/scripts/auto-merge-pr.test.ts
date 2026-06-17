/**
 * Unit tests for scripts/auto-merge-pr.js
 * Tests skip-condition logic and carve-out enforcement without hitting GitHub.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const { shouldSkipBody, pendingApprovalForPR, isCarvedOut, isWithinSettleWindow, evaluateCheckRuns, REPOS, CARVE_OUTS, SETTLE_WINDOW_MS } =
  require('../../../scripts/auto-merge-pr.js');

describe('shouldSkipBody', () => {
  it('returns false for empty/null body', () => {
    expect(shouldSkipBody('')).toBe(false);
    expect(shouldSkipBody(null)).toBe(false);
    expect(shouldSkipBody(undefined)).toBe(false);
  });

  it('returns false for normal PR body', () => {
    expect(shouldSkipBody('## Summary\n- Fix bug\n\n## Test plan\n- [x] tested')).toBe(false);
  });

  it('catches "do not merge" case-insensitively', () => {
    expect(shouldSkipBody('DO NOT MERGE until feature flag is ready')).toBe(true);
    expect(shouldSkipBody('do not merge')).toBe(true);
    expect(shouldSkipBody('Do Not Merge')).toBe(true);
  });

  it('catches "feature branch only"', () => {
    expect(shouldSkipBody('feature branch only — do not squash')).toBe(true);
    expect(shouldSkipBody('FEATURE BRANCH ONLY')).toBe(true);
  });

  it('catches "do_not_merge"', () => {
    expect(shouldSkipBody('do_not_merge')).toBe(true);
    expect(shouldSkipBody('label: do_not_merge')).toBe(true);
  });

  it('catches "greg merges"', () => {
    expect(shouldSkipBody('Greg merges after review')).toBe(true);
    expect(shouldSkipBody('greg merges this one manually')).toBe(true);
  });

  it('does not false-positive on adjacent words', () => {
    // "merge" alone should not trigger
    expect(shouldSkipBody('This PR merges the feature')).toBe(false);
    expect(shouldSkipBody('Auto-merge is enabled')).toBe(false);
  });
});

describe('isCarvedOut', () => {
  it('returns true for charlie-holstine repo', () => {
    expect(isCarvedOut('RevOps-Global-GIT/charlie-holstine')).toBe(true);
    expect(isCarvedOut('charlie-holstine')).toBe(true);
  });

  it('returns true for grandamenium repo', () => {
    expect(isCarvedOut('grandamenium/cortextos')).toBe(true);
    expect(isCarvedOut('grandamenium')).toBe(true);
  });

  it('returns false for normal repos', () => {
    expect(isCarvedOut('RevOps-Global-GIT/cortextos')).toBe(false);
    expect(isCarvedOut('RevOps-Global-GIT/rgos')).toBe(false);
    expect(isCarvedOut('RevOps-Global-GIT/ob1-app')).toBe(false);
    expect(isCarvedOut('RevOps-Global-GIT/ob1-parents')).toBe(false);
    expect(isCarvedOut('RevOps-Global-GIT/team-brain')).toBe(false);
  });
});

describe('REPOS config', () => {
  it('includes all required repos', () => {
    expect(REPOS).toContain('RevOps-Global-GIT/cortextos');
    expect(REPOS).toContain('RevOps-Global-GIT/rgos');
    expect(REPOS).toContain('RevOps-Global-GIT/ob1-app');
    expect(REPOS).toContain('RevOps-Global-GIT/ob1-parents');
    expect(REPOS).toContain('RevOps-Global-GIT/team-brain');
  });

  it('does not include carve-out repos', () => {
    for (const repo of REPOS) {
      expect(isCarvedOut(repo)).toBe(false);
    }
  });
});

describe('CARVE_OUTS config', () => {
  it('includes charlie-holstine and grandamenium', () => {
    expect(CARVE_OUTS).toContain('charlie-holstine');
    expect(CARVE_OUTS).toContain('grandamenium');
  });
});

describe('isWithinSettleWindow', () => {
  const now = Date.parse('2026-06-05T16:02:00Z');

  it('true for a PR updated seconds ago (the #1469 race window)', () => {
    expect(isWithinSettleWindow('2026-06-05T16:01:55Z', now)).toBe(true);
  });

  it('false for a PR updated beyond the window', () => {
    expect(isWithinSettleWindow('2026-06-05T15:58:00Z', now)).toBe(false);
  });

  it('false exactly at the window boundary', () => {
    expect(isWithinSettleWindow(new Date(now - SETTLE_WINDOW_MS).toISOString(), now)).toBe(false);
  });

  it('false for missing/invalid timestamps (does not wedge the merge loop)', () => {
    expect(isWithinSettleWindow('', now)).toBe(false);
    expect(isWithinSettleWindow(undefined, now)).toBe(false);
    expect(isWithinSettleWindow('not-a-date', now)).toBe(false);
  });
});

describe('evaluateCheckRuns', () => {
  const run = (name: string, status: string, conclusion: string | null, started_at: string) =>
    ({ name, status, conclusion, started_at });

  it('ok for all-green runs', () => {
    expect(evaluateCheckRuns([
      run('screenshot-evidence-gate', 'completed', 'success', '2026-06-05T16:00:00Z'),
      run('Build & Type Check', 'completed', 'success', '2026-06-05T16:00:00Z'),
    ])).toEqual({ ok: true, reason: '' });
  });

  it('blocks when a run is in flight', () => {
    const res = evaluateCheckRuns([
      run('screenshot-evidence-gate', 'in_progress', null, '2026-06-05T16:02:20Z'),
    ]);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('in flight');
    expect(res.reason).toContain('screenshot-evidence-gate');
  });

  it('only the LATEST run per name counts — green old run does not mask an in-flight re-run (#1469)', () => {
    const res = evaluateCheckRuns([
      run('screenshot-evidence-gate', 'completed', 'success', '2026-06-05T15:50:00Z'),
      run('screenshot-evidence-gate', 'queued', null, '2026-06-05T16:02:20Z'),
    ]);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('in flight');
  });

  it('only the LATEST run per name counts — green old run does not mask a failed re-run', () => {
    const res = evaluateCheckRuns([
      run('screenshot-evidence-gate', 'completed', 'success', '2026-06-05T15:50:00Z'),
      run('screenshot-evidence-gate', 'completed', 'failure', '2026-06-05T16:02:20Z'),
    ]);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('failed');
  });

  it('a superseded failure overridden by a newer green re-run is ok', () => {
    expect(evaluateCheckRuns([
      run('screenshot-evidence-gate', 'completed', 'failure', '2026-06-05T15:50:00Z'),
      run('screenshot-evidence-gate', 'completed', 'success', '2026-06-05T16:02:20Z'),
    ]).ok).toBe(true);
  });

  it('blocks on timed_out / cancelled / action_required conclusions', () => {
    for (const conclusion of ['timed_out', 'cancelled', 'action_required']) {
      expect(evaluateCheckRuns([run('ci', 'completed', conclusion, '2026-06-05T16:00:00Z')]).ok).toBe(false);
    }
  });

  it('ok for neutral/skipped conclusions and empty input', () => {
    expect(evaluateCheckRuns([run('ci', 'completed', 'neutral', '2026-06-05T16:00:00Z')]).ok).toBe(true);
    expect(evaluateCheckRuns([run('ci', 'completed', 'skipped', '2026-06-05T16:00:00Z')]).ok).toBe(true);
    expect(evaluateCheckRuns([]).ok).toBe(true);
    expect(evaluateCheckRuns(undefined).ok).toBe(true);
  });
});

describe('pendingApprovalForPR — approval-gate bypass guard', () => {
  // Regression: 2026-06-16 PR #862 auto-merged while approval_1781598850 was
  // still pending. The cron had no approval-gate awareness. A held PR must be
  // skipped while a pending approval references it (#<number> + repo short name).
  let dir: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approvals-pending-'));
    const write = (id: string, status: string, title: string, description = '') =>
      fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, status, title, description }));
    write('approval_aaa', 'pending', 'Merge wiki QA coverage PR #862', 'Context: PR #862 in RevOps-Global-GIT/cortextos.');
    write('approval_bbb', 'pending', 'Merge AgentOps uptime probe PR #861', 'RevOps-Global-GIT/cortextos PR #861.');
    write('approval_ccc', 'pending', 'Merge native clearance harness PR #593', 'RevOps-Global-GIT/ob1-app PR #593.');
    write('approval_ddd', 'approved', 'Already-decided PR #700', 'RevOps-Global-GIT/cortextos PR #700.');
  });

  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('gates a PR with a pending approval referencing it (#number + repo)', () => {
    expect(pendingApprovalForPR('RevOps-Global-GIT/cortextos', 862, dir)).toBe('approval_aaa');
    expect(pendingApprovalForPR('RevOps-Global-GIT/cortextos', 861, dir)).toBe('approval_bbb');
    expect(pendingApprovalForPR('RevOps-Global-GIT/ob1-app', 593, dir)).toBe('approval_ccc');
  });

  it('does NOT gate a PR with no pending approval', () => {
    expect(pendingApprovalForPR('RevOps-Global-GIT/cortextos', 999999, dir)).toBeNull();
  });

  it('does NOT gate when the approval is already resolved (status != pending)', () => {
    expect(pendingApprovalForPR('RevOps-Global-GIT/cortextos', 700, dir)).toBeNull();
  });

  it('does NOT cross-match the same PR number in a different repo', () => {
    // #861 is gated in cortextos but must not gate an ob1-app PR #861.
    expect(pendingApprovalForPR('RevOps-Global-GIT/ob1-app', 861, dir)).toBeNull();
  });

  it('does not partial-match a longer number (#86 must not match #862)', () => {
    expect(pendingApprovalForPR('RevOps-Global-GIT/cortextos', 86, dir)).toBeNull();
  });

  it('returns null (never throws) when the pending dir does not exist', () => {
    expect(pendingApprovalForPR('RevOps-Global-GIT/cortextos', 862, path.join(dir, 'nope'))).toBeNull();
  });
});
