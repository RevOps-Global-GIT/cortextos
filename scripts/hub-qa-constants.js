'use strict';

// Single source of truth for hub QA artifact roots and filename pattern.
// Imported by both cortextos-deliverables-snapshot.js and cortextos-vm-sync-push.js
// so they cannot drift independently.
//
// cortextos-qa is the live QA worktree written by the hourly-dogfood (codex-independent).
// The main-repo codex/output/playwright-qa only receives morning full-rotation writes
// (~06:37) and goes stale by noon — do NOT use it as the primary root.

const HUB_QA_ROOTS = [
  '/home/cortextos/cortextos/orgs/revops-global/agents/hub-dogfood/output',
  '/home/cortextos/cortextos/orgs/revops-global/agents/qa-agent/output',
  '/home/cortextos/cortextos-qa/orgs/revops-global/agents/codex/output/playwright-qa',
];

const HUB_QA_PATTERN = /(?:qa-summary|report|dogfood|-qa-\d{4}-\d{2}-\d{2}).*\.md$/i;

module.exports = { HUB_QA_ROOTS, HUB_QA_PATTERN };
