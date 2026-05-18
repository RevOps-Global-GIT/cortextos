import type { FeedbackRuleFixture } from '../types/index.js';

// ---------------------------------------------------------------------------
// Rule check functions
// ---------------------------------------------------------------------------

/**
 * feedback_pr_body_do_not_merge — before enabling auto-merge, grep the PR
 * body for author instructions that override the blanket policy.
 *
 * Original incident: PR #229 "fix(daemon): enforce single-session-per-identity
 * via session.lock" — body contained "Feature branch only — do not merge.
 * Greg merges after review." Auto-merged 2026-05-17T19:01Z without body check.
 */
export function checkPrBodyForMergeBlock(body: string): string | null {
  const patterns = [
    /do not merge/i,
    /do not auto.?merge/i,
    /feature branch only/i,
    /greg merges/i,
    /manual review/i,
    /needs review/i,
    /hold off/i,
    /\bwip\b/i,
  ];
  for (const re of patterns) {
    const m = body.match(re);
    if (m) return `PR body contains merge-block phrase: "${m[0]}" — auto-merge must NOT be enabled`;
  }
  return null;
}

/**
 * feedback_git_push_target — any cortextos-related git push or PR creation
 * must target RevOps-Global-GIT, never grandamenium.
 *
 * Original incident (burn #3): `gh pr create --repo grandamenium/cortextos`
 * was called with `--head RevOps-Global-GIT:branch` — cross-fork PR opened
 * on the public upstream repo 2026-05-09.
 */
export function checkGitCommandTarget(command: string): string | null {
  if (/grandamenium/i.test(command) && /push|pr create|pr merge/i.test(command)) {
    return `Command targets grandamenium — all cortextos writes must target RevOps-Global-GIT: "${command.slice(0, 120)}"`;
  }
  return null;
}

/**
 * feedback_always_on_backlog — when a specialist agent's heartbeat signals
 * idle/standby, the orchestrator must immediately dispatch from the backlog.
 *
 * Original incident: 2026-05-18 Greg saw 4 of 6 specialists idle after the
 * retro Top-10 dispatch completed. Orchestrator ACK'd completions without
 * queuing follow-ons.
 */
export function checkAgentIdleHeartbeat(statusMessage: string): string | null {
  if (/\b(idle|standby|no active|waiting for work|nothing to do)\b/i.test(statusMessage)) {
    return `Agent heartbeat signals idle state: "${statusMessage.slice(0, 80)}" — orchestrator must dispatch from backlog immediately`;
  }
  return null;
}

/**
 * feedback_bus_task_scope_check — listing tasks must specify the org scope;
 * root/default scope silently omits org-scoped tasks.
 *
 * Original incident: `cortextos bus list-tasks` returned [] while 319 tasks
 * existed under revops-global scope — led to false "no tasks" report.
 */
export function checkBusTaskListScope(command: string): string | null {
  if (/cortextos bus list-tasks/.test(command) && !/--org/.test(command)) {
    return `list-tasks command missing --org scope: "${command}" — root scope silently omits org-scoped tasks`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fixture registry
// ---------------------------------------------------------------------------

export const FEEDBACK_FIXTURES: FeedbackRuleFixture[] = [
  {
    ruleName: 'feedback_pr_body_do_not_merge',
    incidentSummary: 'PR #229 auto-merged despite body saying "Feature branch only — do not merge. Greg merges after review." (2026-05-17T19:01Z)',
    originalInput: `## Summary\nEnforces single-session-per-identity via session.lock.\n\n## Notes for review\nFeature branch only — do not merge. Greg merges after review.\n\nCo-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>`,
    check: checkPrBodyForMergeBlock,
  },
  {
    ruleName: 'feedback_git_push_target',
    incidentSummary: 'Cross-fork PR opened on grandamenium/cortextos with --head RevOps-Global-GIT:branch (burn #3, 2026-05-09)',
    originalInput: `gh pr create --repo grandamenium/cortextos --head RevOps-Global-GIT:feat/daemon-session-lock --base main --title "fix(daemon): session lock"`,
    check: checkGitCommandTarget,
  },
  {
    ruleName: 'feedback_always_on_backlog',
    incidentSummary: '4 of 6 specialists idle after retro Top-10 dispatch (2026-05-18T05:38Z) — orchestrator ACK\'d without queuing follow-ons',
    originalInput: 'analyst: healthy standby — no active unblocked task',
    check: checkAgentIdleHeartbeat,
  },
  {
    ruleName: 'feedback_bus_task_scope_check',
    incidentSummary: 'list-tasks returned [] while 319 revops-global tasks existed — root scope silently omits org tasks',
    originalInput: 'cortextos bus list-tasks --status open',
    check: checkBusTaskListScope,
  },
];
