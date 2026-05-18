import { describe, it, expect } from 'vitest';
import {
  checkPrBodyForMergeBlock,
  checkGitCommandTarget,
  checkAgentIdleHeartbeat,
  checkBusTaskListScope,
  FEEDBACK_FIXTURES,
} from '../../../src/bus/feedback-replay.js';

describe('feedback-replay: rules fire against original incidents', () => {
  describe('FEEDBACK_FIXTURES registry', () => {
    it('every fixture has a non-empty ruleName, incidentSummary, and originalInput', () => {
      for (const f of FEEDBACK_FIXTURES) {
        expect(f.ruleName.length).toBeGreaterThan(0);
        expect(f.incidentSummary.length).toBeGreaterThan(0);
        expect(f.originalInput.length).toBeGreaterThan(0);
      }
    });

    it('every fixture fires (non-null) against its own originalInput', () => {
      for (const f of FEEDBACK_FIXTURES) {
        const result = f.check(f.originalInput);
        expect(result, `Rule "${f.ruleName}" did not fire against its original incident: ${f.incidentSummary}`).not.toBeNull();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // checkPrBodyForMergeBlock
  // ---------------------------------------------------------------------------
  describe('checkPrBodyForMergeBlock (feedback_pr_body_do_not_merge)', () => {
    it('flags PR #229 original body — "Feature branch only — do not merge"', () => {
      const body = `## Summary\nEnforces single-session-per-identity.\n\n## Notes for review\nFeature branch only — do not merge. Greg merges after review.`;
      expect(checkPrBodyForMergeBlock(body)).not.toBeNull();
    });

    it('flags "do not auto-merge"', () => {
      expect(checkPrBodyForMergeBlock('Please do not auto-merge this PR')).not.toBeNull();
    });

    it('flags "Greg merges after review"', () => {
      expect(checkPrBodyForMergeBlock('Greg merges after review once QA passes')).not.toBeNull();
    });

    it('flags "WIP" in body', () => {
      expect(checkPrBodyForMergeBlock('WIP: not ready yet')).not.toBeNull();
    });

    it('returns null for a clean PR body with no merge-block phrases', () => {
      const body = `## Summary\nAdds blocker_reason validation.\n\n## Test plan\n- [x] 56/56 tests pass\n\nCo-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>`;
      expect(checkPrBodyForMergeBlock(body)).toBeNull();
    });

    it('returns null for an empty body', () => {
      expect(checkPrBodyForMergeBlock('')).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // checkGitCommandTarget
  // ---------------------------------------------------------------------------
  describe('checkGitCommandTarget (feedback_git_push_target)', () => {
    it('flags the original burn-#3 cross-fork PR create command', () => {
      const cmd = `gh pr create --repo grandamenium/cortextos --head RevOps-Global-GIT:feat/daemon-session-lock --base main`;
      expect(checkGitCommandTarget(cmd)).not.toBeNull();
    });

    it('flags git push to grandamenium', () => {
      expect(checkGitCommandTarget('git push grandamenium feat/my-branch')).not.toBeNull();
    });

    it('flags gh pr merge against grandamenium', () => {
      expect(checkGitCommandTarget('gh pr merge 42 --repo grandamenium/cortextos')).not.toBeNull();
    });

    it('returns null for correct fork target', () => {
      expect(checkGitCommandTarget('gh pr create --repo RevOps-Global-GIT/cortextos --head feat/my-branch')).toBeNull();
    });

    it('returns null for git push to fork', () => {
      expect(checkGitCommandTarget('git push fork feat/my-branch')).toBeNull();
    });

    it('returns null for grandamenium in a comment or URL that is not a push/pr command', () => {
      expect(checkGitCommandTarget('# upstream is grandamenium/cortextos')).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // checkAgentIdleHeartbeat
  // ---------------------------------------------------------------------------
  describe('checkAgentIdleHeartbeat (feedback_always_on_backlog)', () => {
    it('flags the original incident heartbeat — "healthy standby — no active unblocked task"', () => {
      expect(checkAgentIdleHeartbeat('analyst: healthy standby — no active unblocked task')).not.toBeNull();
    });

    it('flags "idle"', () => {
      expect(checkAgentIdleHeartbeat('dev: idle')).not.toBeNull();
    });

    it('flags "waiting for work"', () => {
      expect(checkAgentIdleHeartbeat('codex: waiting for work')).not.toBeNull();
    });

    it('returns null for an active status', () => {
      expect(checkAgentIdleHeartbeat('dev: working on PR #290 blocker validation')).toBeNull();
    });

    it('returns null for an empty string', () => {
      expect(checkAgentIdleHeartbeat('')).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // checkBusTaskListScope
  // ---------------------------------------------------------------------------
  describe('checkBusTaskListScope (feedback_bus_task_scope_check)', () => {
    it('flags the original incident command — list-tasks without --org', () => {
      expect(checkBusTaskListScope('cortextos bus list-tasks --status open')).not.toBeNull();
    });

    it('returns null when --org is present', () => {
      expect(checkBusTaskListScope('cortextos bus list-tasks --org revops-global --status open')).toBeNull();
    });

    it('returns null for unrelated commands', () => {
      expect(checkBusTaskListScope('cortextos bus create-task "foo"')).toBeNull();
    });
  });
});
