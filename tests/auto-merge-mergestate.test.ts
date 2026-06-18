/**
 * Regression test for the auto-merge-pr cron skipping green, MERGEABLE PRs.
 *
 * Root cause (PRs #1713, #878): the cron gated on `mergeStateStatus === 'CLEAN'`,
 * but GitHub computes mergeStateStatus lazily — batch GraphQL returns
 * UNKNOWN/UNSTABLE for PRs that are actually MERGEABLE with all checks green
 * (a `gh pr view` forces recompute to CLEAN). So green CLEAN PRs were skipped
 * every cycle until a human manually merged. Fix: gate only on DEFINITE
 * hard-block states (DIRTY/BLOCKED); mergeable===MERGEABLE + ciPassed are the
 * real gates.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { mergeStateBlocksMerge, HARD_BLOCK_MERGE_STATES } = require('../scripts/auto-merge-pr.js');
import { describe, it, expect } from 'vitest';

describe('mergeStateBlocksMerge — auto-merge mergeState gate', () => {
  it('blocks only DIRTY (conflicts) and BLOCKED (required check/review missing)', () => {
    expect(mergeStateBlocksMerge('DIRTY')).toBe(true);
    expect(mergeStateBlocksMerge('BLOCKED')).toBe(true);
    expect(HARD_BLOCK_MERGE_STATES).toEqual(['DIRTY', 'BLOCKED']);
  });

  it('does NOT block lazily-computed / mergeable states — the #1713/#878 fix', () => {
    // These all presented for green MERGEABLE PRs and were wrongly skipped by
    // the old `=== CLEAN` gate. mergeable + ciPassed are the real gates.
    expect(mergeStateBlocksMerge('CLEAN')).toBe(false);
    expect(mergeStateBlocksMerge('UNKNOWN')).toBe(false);  // the #878/#1713 case
    expect(mergeStateBlocksMerge('UNSTABLE')).toBe(false);
    expect(mergeStateBlocksMerge('BEHIND')).toBe(false);
    expect(mergeStateBlocksMerge('HAS_HOOKS')).toBe(false);
  });

  it('treats unrecognised/empty mergeState as non-blocking (let mergeable+ciPassed decide)', () => {
    expect(mergeStateBlocksMerge('')).toBe(false);
    expect(mergeStateBlocksMerge(null)).toBe(false);
    expect(mergeStateBlocksMerge(undefined)).toBe(false);
  });
});
