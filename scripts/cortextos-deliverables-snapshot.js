#!/usr/bin/env node
/**
 * cortextos-deliverables-snapshot.js
 *
 * Runs on the cortextOS VM (cron / systemd timer, every 5-15 min).
 * Reads the same deliverables artifacts that /api/agentops/overview used
 * to probe directly via readFileSync — but does it on the VM where the
 * files actually exist — then POSTs the parsed snapshot to the
 * agentops-deliverables-push edge function so /api/agentops/overview
 * can render real values instead of "empty" / "stale".
 *
 * Closes the truthfulness bug class from PR #1150 at the data-contract
 * level: aggregator-only-reader, one writer, one reader, one table.
 *
 * Env:
 *   SUPABASE_URL              (required, defaults to prod)
 *   INTERNAL_CRON_SECRET      (required)
 *   CORTEXTOS_ORG_ROOT        (optional, defaults to /home/cortextos/cortextos/orgs/revops-global)
 *   TEAM_BRAIN_ROOT           (optional, defaults to /home/cortextos/work/team-brain)
 *   TEAM_BRAIN_FALLBACK_ROOT  (optional, defaults to /home/cortextos/.cortexos/wiki-publisher/team-brain)
 *
 * Manual run:
 *   node /home/cortextos/work/team-brain/scripts/cortextos-deliverables-snapshot.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const https = require('https');

const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.SB_URL ||
  'https://yyizocyaehmqrottmnaz.supabase.co';
const INTERNAL_SECRET = process.env.INTERNAL_CRON_SECRET;
const ORG_ROOT =
  process.env.CORTEXTOS_ORG_ROOT ||
  '/home/cortextos/cortextos/orgs/revops-global';
const QA_ORG_ROOT =
  process.env.CORTEXTOS_QA_ORG_ROOT ||
  '/home/cortextos/cortextos-qa/orgs/revops-global';
const TEAM_BRAIN_ROOT =
  process.env.TEAM_BRAIN_ROOT || '/home/cortextos/work/team-brain';
const TEAM_BRAIN_FALLBACK_ROOT =
  process.env.TEAM_BRAIN_FALLBACK_ROOT ||
  '/home/cortextos/.cortexos/wiki-publisher/team-brain';

if (!INTERNAL_SECRET) {
  console.error('INTERNAL_CRON_SECRET is required');
  process.exit(2);
}

// ── shared helpers (matched to overview.ts so the parsed values agree) ──────

function safeIsoFromMtime(p) {
  try {
    return fs.statSync(p).mtime.toISOString();
  } catch {
    return null;
  }
}

function listFiles(root, maxDepth = 4) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  const visit = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full, depth + 1);
      else if (entry.isFile()) out.push(full);
    }
  };
  visit(root, 0);
  return out;
}

function latestTextArtifact(roots, pattern) {
  const candidates = roots
    .flatMap((root) => listFiles(root))
    .filter((p) => pattern.test(p))
    .map((p) => ({ path: p, updated_at: safeIsoFromMtime(p) }))
    .filter((c) => Boolean(c.updated_at))
    .sort(
      (a, b) =>
        new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
    );
  for (const c of candidates) {
    try {
      return {
        path: c.path,
        updated_at: c.updated_at,
        text: fs.readFileSync(c.path, 'utf8'),
      };
    } catch {
      // try next
    }
  }
  return null;
}

function minutesSince(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.round((Date.now() - t) / 60000);
}

function numberMatch(text, pattern) {
  const m = text.match(pattern);
  return m ? Number(m[1]) : null;
}

// ── source: hub_qa ──────────────────────────────────────────────────────────

function summarizeHubQa() {
  const roots = [
    path.join(QA_ORG_ROOT, 'agents/codex/output/playwright-qa'),
    path.join(QA_ORG_ROOT, 'agents/hub-dogfood/output'),
    path.join(QA_ORG_ROOT, 'agents/qa-agent/output'),
    path.join(ORG_ROOT, 'agents/hub-dogfood/output'),
    path.join(ORG_ROOT, 'agents/qa-agent/output'),
    path.join(ORG_ROOT, 'agents/codex/output/playwright-qa'),
  ];
  const artifact = latestTextArtifact(
    roots,
    /(?:qa-summary|report|dogfood|app-fleet-tasks-qa).*\.md$/i,
  );

  if (!artifact) {
    return {
      source: 'hub_qa',
      status: 'empty',
      label: 'Hub QA artifacts unavailable',
      updated_at: null,
      stale_reason: `No QA artifact found under ${roots.join(', ')}`,
      payload: {
        failed_count: 0,
        follow_up_count: 0,
        passed_count: 0,
        artifact_path: null,
        roots,
      },
    };
  }

  const passTotal =
    artifact.text.match(
      /Summary:\s*(\d+)\s+passed,\s*(\d+)\s+failed,\s*(\d+)\s+deferred/i,
    ) ||
    artifact.text.match(
      /This pass total:\*\*\s*(\d+)\s+passed,\s*(\d+)\s+failed,\s*(\d+)\s+deferred/i,
    ) ||
    artifact.text.match(
      /\*\*TOTALS?:\s*(\d+)\s+passed\s*\/\s*(\d+)\s+failed\s*\/\s*(\d+)\s+deferred\*\*/i,
    );
  const passed = passTotal
    ? Number(passTotal[1])
    : (numberMatch(artifact.text, /Checks passed:\s*(\d+)(?:\/\d+)?/i) ?? 0);
  const failed = passTotal
    ? Number(passTotal[2])
    : (numberMatch(artifact.text, /Checks failed:\s*(\d+)/i) ?? 0);
  const deferred = passTotal
    ? Number(passTotal[3])
    : (numberMatch(artifact.text, /Checks deferred:\s*(\d+)/i) ?? 0);
  const age = minutesSince(artifact.updated_at);

  const status =
    failed > 0
      ? 'error'
      : age != null && age > 6 * 60
          ? 'stale'
          : 'healthy';
  const stale_reason =
    failed > 0
      ? `${failed} failing check(s) in ${path.basename(artifact.path)}`
      : age != null && age > 6 * 60
        ? `${age}m old; threshold 360m`
        : null;

  return {
    source: 'hub_qa',
    status,
    label: `${passed} pass, ${failed} fail, ${deferred} follow-up`,
    updated_at: artifact.updated_at,
    stale_reason,
    payload: {
      passed_count: passed,
      failed_count: failed,
      follow_up_count: deferred,
      artifact_path: artifact.path,
    },
  };
}

// ── source: advisor_canary ──────────────────────────────────────────────────

function summarizeAdvisorCanary() {
  const roots = [
    path.join(
      ORG_ROOT,
      'agents/codex/output/advisor-facing-page-canary',
    ),
    path.join(
      ORG_ROOT,
      'agents/codex-3/output/advisor-facing-page-canary',
    ),
  ];
  // Accept both "canary-browser-results.json" (canonical) and "browser-results.json"
  // (fallback — codex-3 sometimes writes without the "canary-" prefix).
  const jsonArtifact =
    latestTextArtifact(roots, /canary-browser-results\.json$/i) ||
    latestTextArtifact(roots, /(?:^|[/\\])browser-results\.json$/i);
  const reportArtifact = latestTextArtifact(roots, /report\.md$/i);
  const artifact = jsonArtifact || reportArtifact;

  if (!artifact) {
    return {
      source: 'advisor_canary',
      status: 'empty',
      label: 'Advisor canary artifact unavailable',
      updated_at: null,
      stale_reason: `No canary artifact found under ${roots.join(', ')}`,
      payload: { artifact_path: null, roots },
    };
  }

  let generatedAt = artifact.updated_at;
  let failures = 0;
  let label = 'Advisor canary artifact found';
  let checked = null;

  if (jsonArtifact) {
    try {
      const parsed = JSON.parse(jsonArtifact.text);
      generatedAt = parsed.generated_at ?? parsed.checked_at ?? generatedAt;
      const pages = Array.isArray(parsed.pages) ? parsed.pages : [];
      failures =
        Number(parsed.pageErrors?.length ?? 0) +
        Number(parsed.failedResponses?.length ?? 0) +
        Number(parsed.findings?.length ?? 0) +
        pages.reduce(
          (total, page) =>
            total +
            Number(page?.pageErrors?.length ?? 0) +
            Number(page?.failedRequests?.length ?? 0),
          0,
        );
      checked = Array.isArray(parsed.results)
        ? parsed.results.length
        : pages.length;
      label = `${checked} advisor canary URL(s) checked`;
    } catch {
      failures = 1;
      label = 'Advisor canary JSON parse failed';
    }
  } else if (reportArtifact) {
    const status = reportArtifact.text
      .match(/Status:\s*\*\*([^*]+)\*\*/i)?.[1]
      ?.trim();
    label = status
      ? `Advisor canary ${status.toLowerCase()}`
      : 'Advisor canary report found';
  }

  const age = minutesSince(generatedAt);
  const status =
    failures > 0
      ? 'error'
      : age != null && age > 24 * 60
        ? 'stale'
        : 'healthy';
  const stale_reason =
    failures > 0
      ? `${failures} browser error(s) recorded`
      : age != null && age > 24 * 60
        ? `${age}m old; threshold 1440m`
        : null;

  return {
    source: 'advisor_canary',
    status,
    label,
    updated_at: generatedAt,
    stale_reason,
    payload: {
      artifact_path: artifact.path,
      failures,
      checked,
    },
  };
}

// ── source: team_brain_wiki ─────────────────────────────────────────────────

function summarizeTeamBrainWiki() {
  const roots = [TEAM_BRAIN_ROOT, TEAM_BRAIN_FALLBACK_ROOT].filter(Boolean);
  const candidates = [];

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const lastSyncPath = path.join(root, 'wiki', '.last_sync');
    const lastSync = safeIsoFromMtime(lastSyncPath);
    let gitUpdatedAt = null;
    let commitSubject = 'git log unavailable';

    try {
      const raw = execFileSync(
        'git',
        ['-C', root, 'log', '-1', '--format=%cI%x00%s'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1500 },
      );
      const [commitDate, subject] = raw.trim().split('\0');
      gitUpdatedAt = commitDate || null;
      commitSubject = subject || commitSubject;
    } catch {
      // fall through to lastSync
    }

    let updatedAt = gitUpdatedAt || lastSync;

    if (!updatedAt) {
      const wikiFiles = listFiles(root)
        .filter((p) => p.endsWith('.md'))
        .map((p) => ({ path: p, mtime: safeIsoFromMtime(p) }))
        .filter((f) => Boolean(f.mtime))
        .sort((a, b) => new Date(b.mtime).getTime() - new Date(a.mtime).getTime());
      if (wikiFiles.length > 0) updatedAt = wikiFiles[0].mtime;
    }

    const age = minutesSince(updatedAt);
    const status =
      age == null
        ? 'empty'
        : age > 24 * 60
          ? 'stale'
          : 'healthy';
    const stale_reason =
      status === 'stale'
        ? `${age}m old; threshold 1440m`
        : status === 'empty'
          ? 'no timestamp source available'
          : null;
    const label =
      status === 'healthy'
        ? `Team Brain updated: ${commitSubject.slice(0, 80)}`
        : status === 'stale'
          ? 'Team Brain git/wiki stale'
          : 'Team Brain git/wiki state unknown';

    const summary = {
      source: 'team_brain_wiki',
      status,
      label,
      updated_at: updatedAt,
      stale_reason,
      payload: {
        source_root: root,
        commit_subject: commitSubject,
        last_sync: lastSync,
        git_updated_at: gitUpdatedAt,
      },
    };

    candidates.push(summary);
  }

  if (candidates.length > 0) {
    candidates.sort((a, b) => {
      const aTime = a.updated_at ? new Date(a.updated_at).getTime() : 0;
      const bTime = b.updated_at ? new Date(b.updated_at).getTime() : 0;
      return bTime - aTime;
    });
    return candidates[0];
  }

  return {
    source: 'team_brain_wiki',
    status: 'empty',
    label: 'Team Brain checkout unavailable',
    updated_at: null,
    stale_reason: `Checked ${roots.join(', ') || 'no configured paths'}`,
    payload: { roots },
  };
}

// ── POST ────────────────────────────────────────────────────────────────────

function postSnapshot(payload) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${SUPABASE_URL}/functions/v1/agentops-deliverables-push`);
    const data = Buffer.from(JSON.stringify(payload), 'utf8');
    const req = https.request(
      {
        method: 'POST',
        hostname: url.hostname,
        path: url.pathname,
        port: url.port || 443,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': data.length,
          'X-Internal-Secret': INTERNAL_SECRET,
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ status: res.statusCode, body });
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${body}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  const sources = [
    summarizeHubQa(),
    summarizeAdvisorCanary(),
    summarizeTeamBrainWiki(),
  ];

  const payload = {
    generated_at: new Date().toISOString(),
    sources,
  };

  if (process.env.DRY_RUN === '1') {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const result = await postSnapshot(payload);
  console.log(`pushed ${sources.length} sources: ${result.body}`);
}

main().catch((err) => {
  console.error(`snapshot failed: ${err.message}`);
  process.exit(1);
});
