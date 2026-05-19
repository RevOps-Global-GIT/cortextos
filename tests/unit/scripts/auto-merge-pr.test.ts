/**
 * Unit tests for scripts/auto-merge-pr.js
 * Tests skip-condition logic and carve-out enforcement without hitting GitHub.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire(import.meta.url);
const { shouldSkipBody, isCarvedOut, REPOS, CARVE_OUTS } =
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
