#!/usr/bin/env node
/**
 * auto-merge-pr.js
 *
 * Cron: every 15min. Lists open PRs across RevOps-Global-GIT repos, merges
 * those that pass all checks. Logs each merge via cortextos bus log-event.
 * Sends Telegram summary via orchestrator if >5 merges or any error occurs.
 *
 * Carve-outs (never touched): charlie-holstine, grandamenium repos.
 * Skip signals in PR body (case-insensitive): 'do not merge', 'feature branch only',
 *   'do_not_merge', 'greg merges'.
 * Skip if: mergeable != MERGEABLE, any check FAILURE, any CHANGES_REQUESTED review.
 */

'use strict';

const { execSync, execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { checkPR, formatComment, postComment } = require('./memo-conflict-check');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const REPOS = [
  'RevOps-Global-GIT/cortextos',
  'RevOps-Global-GIT/rgos',
  'RevOps-Global-GIT/ob1-app',
  'RevOps-Global-GIT/ob1-parents',
  'RevOps-Global-GIT/team-brain',
];

const CARVE_OUTS = ['charlie-holstine', 'grandamenium'];

const SKIP_BODY_PATTERNS = [
  /do\s*not\s*merge/i,
  /feature\s*branch\s*only/i,
  /do_not_merge/i,
  /greg\s*merges/i,
];

// A PR updated moments ago may have an event-triggered check re-run that has
// not yet registered as a check run (#1469: an 'edited'-event gate re-run
// concluded FAILURE 8s after the merge). Defer such PRs to the next cycle.
const SETTLE_WINDOW_MS = 90 * 1000;

const CTX_ROOT = process.env.CTX_ROOT || `${process.env.HOME}/.cortextos/default`;
const CTX_AGENT_NAME = process.env.CTX_AGENT_NAME || 'dev';
const CTX_ORG = process.env.CTX_ORG || 'revops-global';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function gh(args) {
  try {
    return execFileSync('gh', args, { encoding: 'utf-8', timeout: 30000 });
  } catch (err) {
    throw new Error(`gh ${args.join(' ')}: ${err.message}`);
  }
}

function bus(args) {
  try {
    execFileSync('cortextos', ['bus', ...args], { encoding: 'utf-8', timeout: 15000 });
  } catch {
    // Non-fatal: bus errors must not abort the merge loop
  }
}

/**
 * Infer the owning agent from the PR branch name.
 * Branch conventions: "codex/...", "codex-2/...", "dev/...", "analyst/..."
 * Falls back to the current agent (dev) for non-prefixed branches.
 */
const KNOWN_AGENTS = ['codex', 'codex-2', 'codex-3', 'dev', 'analyst', 'orchestrator'];
function inferOwnerAgent(headRefName) {
  if (!headRefName) return CTX_AGENT_NAME;
  for (const agent of KNOWN_AGENTS) {
    if (headRefName.startsWith(agent + '/') || headRefName.startsWith(agent + '-')) {
      return agent;
    }
  }
  return CTX_AGENT_NAME;
}

// ---------------------------------------------------------------------------
// Post-merge Playwright verification
// ---------------------------------------------------------------------------

const PLAYWRIGHT_HARNESS = path.join(__dirname, 'hub-qa-playwright.ts');

// File path → hub route. Covers both Next.js App Router (app/) and React Router (src/pages/).
// Order matters: more specific patterns first.
const FILE_ROUTE_MAP = [
  // App Router style (app/)
  [/^(src\/)?app\/orchestrator\//, '/app/orchestrator'],
  [/^(src\/)?app\/fleet\/tasks\//, '/app/fleet/tasks'],
  [/^(src\/)?app\/fleet\/agents\//, '/app/fleet/agents'],
  [/^(src\/)?app\/fleet\/activity\//, '/app/fleet/activity'],
  [/^(src\/)?app\/work\/inbox\//, '/app/work/inbox'],
  [/^(src\/)?app\/work\/approvals\//, '/app/work/approvals'],
  [/^(src\/)?app\/cortex\/theta\//, '/app/cortex/theta'],
  [/^(src\/)?app\/wiki\//, '/app/wiki'],
  [/^(src\/)?app\/presence\//, '/app/presence'],
  [/^(src\/)?app\/signals\//, '/app/signals'],
  [/^(src\/)?app\/time\//, '/time'],
  [/^(src\/)?app\/my-day\//, '/my-day'],
  [/^(src\/)?app\/tasks\//, '/tasks'],
  [/^(src\/)?app\/companies\//, '/companies'],
  [/^(src\/)?app\/projects\//, '/projects'],
  [/^(src\/)?app\/reports\//, '/reports'],
  [/^(src\/)?app\/pipeline\//, '/pipeline'],
  [/^(src\/)?app\/social-content\//, '/social-content'],
  [/^(src\/)?app\/content-review\//, '/content-review'],
  // React Router + Pages style (src/pages/) used by rgos
  [/^src\/pages\/SupremeOutstanding\.[tj]sx?$/, '/app/supreme-outstanding'],
  [/^src\/pages\/portal\/Orchestrator\.[tj]sx?$/, '/app/orchestrator'],
  [/^src\/pages\/portal\/Fleet[^/]*\.[tj]sx?$/, '/app/fleet/tasks'],
  [/^src\/pages\/portal\/Work[^/]*\.[tj]sx?$/, '/app/work/inbox'],
  [/^src\/pages\/Companies\.[tj]sx?$/, '/companies'],
  [/^src\/pages\/Pipeline\.[tj]sx?$/, '/pipeline'],
  [/^src\/pages\/Projects\.[tj]sx?$/, '/projects'],
  [/^src\/pages\/Reports\.[tj]sx?$/, '/reports'],
  [/^src\/pages\/MyDay\.[tj]sx?$/, '/my-day'],
];

// High-traffic pages to fall back to when no specific route can be inferred
const DEFAULT_VERIFY_ROUTES = ['/app/orchestrator', '/app/fleet/tasks', '/'];

function filePathToRoute(filePath) {
  for (const [pattern, route] of FILE_ROUTE_MAP) {
    if (pattern.test(filePath)) return route;
  }
  return null;
}

/**
 * For an API file, extract the endpoint path.
 * Handles both App Router ('app/api/foo/route.ts') and flat ('api/foo.ts') styles.
 */
function apiFileToEndpoint(filePath) {
  const appRouterMatch = filePath.match(/(?:^|\/)app\/api\/(.+?)\/route\.[tj]s$/);
  if (appRouterMatch) return '/api/' + appRouterMatch[1];
  const flatMatch = filePath.match(/(?:^|\/)api\/(.+?)\.[tj]s$/);
  if (flatMatch) return '/api/' + flatMatch[1];
  return null;
}

/**
 * Search a repo for files referencing a string. Returns array of file paths.
 */
function searchCode(term, repo) {
  try {
    const result = gh(['api', `search/code?q=${encodeURIComponent(term)}+in:file+repo:${repo}&per_page=30`]);
    return (JSON.parse(result).items || []).map(i => i.path);
  } catch (err) {
    console.warn(`[auto-merge] Code search failed for "${term}" in ${repo}: ${err.message}`);
    return [];
  }
}

/**
 * For an API file, find which hub pages consume that endpoint by:
 * 1. Searching for the endpoint string in the repo
 * 2. If only hook/component files are found (not pages), searching one level deeper
 *    for files that import those hooks (the pages that actually render the data)
 */
function findApiConsumers(apiFilePath, repo) {
  const endpoint = apiFileToEndpoint(apiFilePath);
  if (!endpoint) return [];

  console.log(`[auto-merge] API change detected (${endpoint}), searching consumers in ${repo}...`);

  const level1 = searchCode(endpoint, repo);
  console.log(`[auto-merge] Level-1 hits for ${endpoint}: [${level1.join(', ')}]`);

  const routes = new Set();
  const hookFiles = [];

  for (const f of level1) {
    const route = filePathToRoute(f);
    if (route) {
      routes.add(route);
    } else if (/\.[tj]sx?$/.test(f) && !/\.(test|spec)\./.test(f) &&
               /^src\/hooks\//.test(f)) {
      hookFiles.push(f);
    }
  }

  // Level-2: when level-1 only found hooks (not pages), find what pages use those hooks
  if (routes.size === 0 && hookFiles.length > 0) {
    for (const hookFile of hookFiles.slice(0, 2)) {
      const hookName = hookFile.split('/').pop().replace(/\.[tj]sx?$/, '');
      console.log(`[auto-merge] Level-2 search for hook "${hookName}"...`);
      const level2 = searchCode(hookName, repo);
      for (const f of level2) {
        const route = filePathToRoute(f);
        if (route) routes.add(route);
      }
    }
  }

  console.log(`[auto-merge] Consumer routes for ${endpoint}: [${[...routes].join(', ')}]`);
  return routes.size > 0 ? Array.from(routes) : DEFAULT_VERIFY_ROUTES;
}

/**
 * Map a merged PR's changed files to hub routes that should be verified.
 * Returns [] for non-rgos repos (no hub pages).
 */
function mapPrFilesToRoutes(repo, number) {
  if (!repo.includes('rgos')) return [];

  let files;
  try {
    const out = gh(['pr', 'view', String(number), '-R', repo, '--json', 'files', '-q', '.files[].path']);
    files = out.trim().split('\n').filter(Boolean);
  } catch (err) {
    console.warn(`[auto-merge] Could not fetch files for PR #${number}: ${err.message}`);
    return DEFAULT_VERIFY_ROUTES;
  }

  const routes = new Set();

  for (const f of files) {
    if (/(?:^|\/)api\//.test(f) && !/\.(test|spec)\./.test(f)) {
      // API file change → verify the pages that consume it (catches both 'api/foo.ts' and 'app/api/foo/route.ts')
      const consumers = findApiConsumers(f, repo);
      consumers.forEach(r => routes.add(r));
    } else {
      const route = filePathToRoute(f);
      if (route) routes.add(route);
    }
  }

  // Shared lib/component change with no direct page match → check default surface
  if (routes.size === 0) DEFAULT_VERIFY_ROUTES.forEach(r => routes.add(r));

  return Array.from(routes).slice(0, 3); // Cap at 3 routes (~3 min max)
}

/**
 * Run hub-qa-playwright.ts against each route, synchronously.
 * Sends [verify-ok] or [verify-FAILED] to the owning agent when done.
 */
function runPlaywrightVerify(routes, repo, number, title, ownerAgent) {
  const repoShort = repo.split('/')[1];
  const results = [];

  for (const route of routes) {
    console.log(`[auto-merge] playwright verify: ${route} for #${number} ${repoShort}`);
    const proc = spawnSync(
      'npx', ['tsx', PLAYWRIGHT_HARNESS, '--page', route, '--no-send'],
      { timeout: 120000, encoding: 'utf-8', cwd: __dirname }
    );
    const passed = proc.status === 0;
    results.push({ route, passed });
    console.log(`[auto-merge] ${passed ? 'PASS' : 'FAIL'} ${route} (exit ${proc.status})`);
    if (!passed && proc.stderr) {
      console.error(`[auto-merge] stderr: ${proc.stderr.slice(0, 300)}`);
    }
  }

  const allPassed = results.every(r => r.passed);
  const failed = results.filter(r => !r.passed).map(r => r.route);
  const passed = results.filter(r => r.passed).map(r => r.route);

  const verifyMsg = allPassed
    ? `[verify-ok] PR #${number} ${repoShort} ("${title}") — Playwright auth check PASSED on: ${passed.join(', ')}. Task may be closed.`
    : `[verify-FAILED] PR #${number} ${repoShort} ("${title}") — Playwright auth check FAILED on: ${failed.join(', ')}. Screenshots in codex/output/playwright-qa/. Do not close related task until fixed.`;

  bus(['send-message', ownerAgent, 'normal', verifyMsg]);
  bus(['log-event', 'action', 'pr_playwright_verify', allPassed ? 'info' : 'error',
    '--meta', JSON.stringify({ pr: number, repo, routes, passed: allPassed, agent: CTX_AGENT_NAME })]);

  if (!allPassed) {
    bus(['send-message', 'orchestrator', 'normal',
      `[playwright-regression] PR #${number} ${repoShort} failed page verification: ${failed.join(', ')}. Owner agent: ${ownerAgent}.`]);
  }
}

function shouldSkipBody(body) {
  if (!body) return false;
  return SKIP_BODY_PATTERNS.some(p => p.test(body));
}

// Returns the id of a still-pending approval whose title/description references
// this PR (by `#<number>` + the repo short name), or null. Held PRs must never
// auto-merge ahead of an explicit approval gate.
// (2026-06-16: PR #862 auto-merged while approval_1781598850 was still pending —
// the cron had no approval-gate awareness. This closes that bypass.)
function pendingApprovalForPR(repo, number, dir = path.join(CTX_ROOT, 'orgs', CTX_ORG, 'approvals', 'pending')) {
  let files;
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  } catch {
    return null; // no pending dir → nothing to gate on (best-effort, never blocks)
  }
  const repoShort = repo.split('/')[1] || repo;
  const prRe = new RegExp(`#${number}\\b`);
  for (const f of files) {
    let appr;
    try {
      appr = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch {
      continue;
    }
    // Files live under pending/ but double-check status so a stale/misfiled
    // approved record can't block.
    if (appr.status && appr.status !== 'pending') continue;
    const text = `${appr.title || ''} ${appr.description || ''}`;
    if (prRe.test(text) && text.includes(repoShort)) {
      return appr.id || f.replace(/\.json$/, '');
    }
  }
  return null;
}

function isWithinSettleWindow(updatedAt, nowMs = Date.now(), windowMs = SETTLE_WINDOW_MS) {
  const t = new Date(updatedAt).getTime();
  if (Number.isNaN(t)) return false;
  return nowMs - t < windowMs;
}

/**
 * Evaluate REST check-runs for merge safety. Only the latest run per check
 * name counts (re-runs create new runs on the same SHA). Unsafe when any
 * latest run is still in flight or concluded badly.
 */
function evaluateCheckRuns(checkRuns) {
  const latestByName = new Map();
  for (const r of checkRuns || []) {
    const prev = latestByName.get(r.name);
    if (!prev || new Date(r.started_at) > new Date(prev.started_at)) {
      latestByName.set(r.name, r);
    }
  }
  const inFlight = [];
  const failed = [];
  for (const r of latestByName.values()) {
    if (r.status !== 'completed') inFlight.push(r.name);
    else if (['failure', 'timed_out', 'cancelled', 'action_required'].includes(r.conclusion)) failed.push(r.name);
  }
  if (inFlight.length > 0) return { ok: false, reason: `checks in flight: ${inFlight.join(', ')}` };
  if (failed.length > 0) return { ok: false, reason: `checks failed: ${failed.join(', ')}` };
  return { ok: true, reason: '' };
}

/**
 * Re-verify a PR immediately before merging. The GraphQL snapshot can be
 * tens of seconds stale by the time the merge fires (memo-conflict checks,
 * earlier PRs in the loop); a check re-run registered in that gap must
 * block the merge.
 */
function preMergeFreshnessCheck(repo, number, evalHeadSha) {
  const fresh = JSON.parse(gh(['api', `repos/${repo}/pulls/${number}`]));
  if (fresh.state !== 'open') return { ok: false, reason: `state=${fresh.state}` };
  if (fresh.head?.sha !== evalHeadSha) return { ok: false, reason: 'head SHA moved since evaluation' };
  if (isWithinSettleWindow(fresh.updated_at)) return { ok: false, reason: 'updated inside settle window' };
  const runs = JSON.parse(gh(['api', `repos/${repo}/commits/${evalHeadSha}/check-runs?per_page=100`])).check_runs || [];
  return evaluateCheckRuns(runs);
}

function isCarvedOut(repo) {
  return CARVE_OUTS.some(co => repo.includes(co));
}

/**
 * Fetch open PRs for a repo with merge + CI state via GitHub CLI GraphQL.
 * Returns array of { number, title, body, mergeable, mergeStateStatus, ciPassed, hasChangesRequested }
 */
function fetchPRs(repo) {
  const query = `
    query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        pullRequests(states: OPEN, first: 50, orderBy: {field: CREATED_AT, direction: ASC}) {
          nodes {
            number
            title
            body
            isDraft
            headRefName
            headRefOid
            updatedAt
            mergeable
            mergeStateStatus
            autoMergeRequest { mergeMethod }
            reviews(last: 10, states: [CHANGES_REQUESTED]) { totalCount }
            commits(last: 1) {
              nodes {
                commit {
                  statusCheckRollup {
                    state
                    contexts(first: 20) {
                      nodes {
                        ... on CheckRun { conclusion name }
                        ... on StatusContext { state context }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;
  const [owner, name] = repo.split('/');
  let raw;
  try {
    raw = gh(['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`]);
  } catch (err) {
    console.warn(`[auto-merge] Could not fetch PRs for ${repo}: ${err.message}`);
    return [];
  }
  const data = JSON.parse(raw);
  const nodes = data?.data?.repository?.pullRequests?.nodes ?? [];

  return nodes.map(pr => {
    const commit = pr.commits?.nodes?.[0]?.commit;
    const rollup = commit?.statusCheckRollup;
    const contexts = rollup?.contexts?.nodes ?? [];

    const hasFailure = contexts.some(c =>
      (c.conclusion && c.conclusion === 'FAILURE') ||
      (c.state && c.state === 'FAILURE')
    );
    const allPassed = rollup ? rollup.state === 'SUCCESS' : true; // no checks = pass
    const hasChangesRequested = (pr.reviews?.totalCount ?? 0) > 0;

    return {
      number: pr.number,
      title: pr.title,
      body: pr.body ?? '',
      isDraft: pr.isDraft ?? false,
      headRefName: pr.headRefName ?? '',
      headSha: pr.headRefOid ?? '',
      updatedAt: pr.updatedAt ?? '',
      mergeable: pr.mergeable,
      mergeStateStatus: pr.mergeStateStatus,
      ciPassed: !hasFailure && allPassed,
      hasChangesRequested,
    };
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const merged = [];
  const errors = [];

  for (const repo of REPOS) {
    if (isCarvedOut(repo)) continue;

    let prs;
    try {
      prs = fetchPRs(repo);
    } catch (err) {
      errors.push({ repo, error: err.message });
      continue;
    }

    for (const pr of prs) {
      const { number, title, body, isDraft, headRefName, headSha, updatedAt, mergeable, mergeStateStatus, ciPassed, hasChangesRequested } = pr;

      // Skip conditions
      if (isDraft) {
        console.log(`[auto-merge] SKIP #${number} ${repo} — draft PR`);
        continue;
      }
      if (shouldSkipBody(body)) {
        console.log(`[auto-merge] SKIP #${number} ${repo} — body contains skip signal`);
        continue;
      }
      const heldByApproval = pendingApprovalForPR(repo, number);
      if (heldByApproval) {
        console.log(`[auto-merge] SKIP #${number} ${repo} — linked approval pending (${heldByApproval})`);
        continue;
      }
      if (mergeable !== 'MERGEABLE') {
        console.log(`[auto-merge] SKIP #${number} ${repo} — mergeable=${mergeable}`);
        continue;
      }
      if (mergeStateStatus !== 'CLEAN') {
        console.log(`[auto-merge] SKIP #${number} ${repo} — mergeState=${mergeStateStatus}`);
        continue;
      }
      if (!ciPassed) {
        console.log(`[auto-merge] SKIP #${number} ${repo} — CI not clean`);
        continue;
      }
      if (hasChangesRequested) {
        console.log(`[auto-merge] SKIP #${number} ${repo} — CHANGES_REQUESTED review`);
        continue;
      }
      if (isWithinSettleWindow(updatedAt)) {
        console.log(`[auto-merge] SKIP #${number} ${repo} — updated <${SETTLE_WINDOW_MS / 1000}s ago, waiting for event-triggered checks to register`);
        continue;
      }

      // Memo-conflict check (skip if body contains 'memo-conflict-ok')
      if (!/memo-conflict-ok/i.test(body)) {
        let conflictResult;
        try {
          conflictResult = checkPR(repo, number);
        } catch {
          conflictResult = { hasConflict: false, conflicts: [] };
        }
        if (conflictResult.hasConflict) {
          const criticalCount = conflictResult.conflicts.filter(c => c.critical).length;
          console.log(`[auto-merge] SKIP #${number} ${repo} — memo-conflict (${criticalCount} critical, ${conflictResult.conflicts.length - criticalCount} warnings)`);
          const comment = formatComment(repo, number, conflictResult.conflicts);
          postComment(repo, number, comment);
          continue;
        }
      }

      // Merge
      try {
        const freshness = preMergeFreshnessCheck(repo, number, headSha);
        if (!freshness.ok) {
          console.log(`[auto-merge] SKIP #${number} ${repo} — pre-merge freshness: ${freshness.reason}`);
          continue;
        }
        console.log(`[auto-merge] MERGING #${number} ${repo} — "${title}"`);
        gh(['pr', 'merge', String(number), '-R', repo, '--squash', '--delete-branch']);
        merged.push({ repo, number, title, headRefName });
        bus(['log-event', 'action', 'pr_auto_merged', 'info',
          '--meta', JSON.stringify({ pr: number, repo, title, agent: CTX_AGENT_NAME })]);

        const ownerAgent = inferOwnerAgent(headRefName);
        const verifyRoutes = mapPrFilesToRoutes(repo, number);

        if (verifyRoutes.length > 0) {
          // rgos PR: run authenticated Playwright check on affected hub pages
          console.log(`[auto-merge] Running playwright verify on [${verifyRoutes.join(', ')}] for #${number}`);
          runPlaywrightVerify(verifyRoutes, repo, number, title, ownerAgent);
        } else {
          // Non-hub repo: send manual verify message (no UI surface to automate)
          const verifyMsg = `[verify-required] PR #${number} ${repo.split('/')[1]} merged ("${title}"). ` +
            `Before marking any related task complete: confirm the change works in prod ` +
            `(CI green + smoke test or screenshot). Reply with verification evidence.`;
          bus(['send-message', ownerAgent, 'normal', verifyMsg]);
          console.log(`[auto-merge] Sent verify-required message to ${ownerAgent} for #${number}`);
        }
      } catch (err) {
        console.error(`[auto-merge] ERROR merging #${number} ${repo}: ${err.message}`);
        errors.push({ repo, pr: number, error: err.message });
      }
    }
  }

  // Summary
  const mergedCount = merged.length;
  const errorCount = errors.length;
  console.log(`[auto-merge] Done: ${mergedCount} merged, ${errorCount} errors`);

  if (mergedCount > 5 || errorCount > 0) {
    const lines = [];
    if (mergedCount > 0) {
      lines.push(`Merged ${mergedCount} PRs:`);
      merged.slice(0, 10).forEach(m => lines.push(`  #${m.number} ${m.repo.split('/')[1]}: ${m.title}`));
    }
    if (errorCount > 0) {
      lines.push(`Errors (${errorCount}):`);
      errors.slice(0, 5).forEach(e => lines.push(`  ${e.repo} #${e.pr ?? ''}: ${e.error}`));
    }
    const summary = lines.join('\n');
    bus(['send-message', 'orchestrator', 'normal', `auto-merge-pr summary:\n${summary}`]);
  }

  process.exit(errorCount > 0 ? 1 : 0);
}

if (require.main === module) {
  main().catch(err => {
    console.error('[auto-merge] Fatal:', err);
    process.exit(1);
  });
}

// Export helpers for unit testing
if (typeof module !== 'undefined') {
  module.exports = { shouldSkipBody, pendingApprovalForPR, isCarvedOut, inferOwnerAgent, filePathToRoute, apiFileToEndpoint, mapPrFilesToRoutes, isWithinSettleWindow, evaluateCheckRuns, preMergeFreshnessCheck, REPOS, CARVE_OUTS, FILE_ROUTE_MAP, SETTLE_WINDOW_MS };
}

