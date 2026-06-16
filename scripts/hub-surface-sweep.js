#!/usr/bin/env node
/**
 * hub-surface-sweep.js
 * Detects uncovered web surfaces and zombie crons across the RevOps fleet.
 *
 * Category A: enumerate app/** /page.tsx + src/pages/**\/*.tsx from GitHub repos,
 *   diff against hub-qa-playwright.ts KNOWN_QA_ROUTES, flag blind spots.
 * Category B: per-agent cron zombie detection — last-fire-age vs interval,
 *   plus success-event cross-check where available.
 *
 * Writes report to agents/dev/output/YYYY-MM-DD-surface-sweep.md
 * Exit code 0 always (informational).
 */

'use strict';

const { execSync, spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const REPO_ROOT  = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(REPO_ROOT, 'orgs/revops-global/agents/dev/output');
const TODAY      = new Date().toISOString().slice(0, 10);
const REPORT     = path.join(OUTPUT_DIR, `${TODAY}-surface-sweep.md`);

const HISTORY_FILE = path.join(OUTPUT_DIR, 'surface-sweep-history.json');
const ESCALATION_THRESHOLD  = 2;                      // flags in window → escalate
const ESCALATION_WINDOW_MS  = 7 * 24 * 3600 * 1000;  // 7-day rolling window

const SCAN_REPOS = [
  'RevOps-Global-GIT/rgos',
  'RevOps-Global-GIT/ob1-parents',
  'RevOps-Global-GIT/ob1-app',
  'RevOps-Global-GIT/charlie-holstine',
];

const KNOWN_QA_ROUTES = new Set([
  '/time', '/my-day', '/tasks', '/', '/dashboard', '/app/orchestrator',
  '/app/fleet/activity', '/app/work/inbox', '/app/work/approvals',
  '/companies', '/projects', '/reports', '/pipeline',
  '/app/fleet/tasks', '/app/fleet/agents', '/app/fleet/agents?tab=sessions', '/social-content',
  '/attribution-deployer', '/content-attribution', '/content-review', '/app/wiki', '/app/cortex/theta', '/app/presence',
  '/app/signals', '/app/supreme-outstanding',
  '/assessment-detail', '/assessment-rubric', '/assessments',
  '/clients', '/company-detail', '/contact-detail', '/contacts', '/deal-room', '/deal-rooms',
  '/cortext-osguide', '/database-hygiene', '/detailed-report',
  '/invoice-detail', '/invoices', '/knowledge-base', '/meeting-review',
  '/pipeline-detail', '/project-detail', '/sales-agent', '/settings', '/team',
  '/financials', '/workflow-deployer',
  '/outreach', '/outreach-preview', '/outreach-upload',
  '/pipeline-guide', '/sales-materials', '/territory-planning',
  '/beta-autopilot', '/engine-adoption', '/scoring-review', '/scoring-snapshot',
  '/deduplication-queue', '/hygiene-report', '/inbox-triage', '/lifecycle-builder',
  '/linked-in-presence', '/poc/linked-in-presence-poc', '/review-aa-frd', '/slack-link',
  '/skill-claude-code-best-practices', '/skill-dispatching-agents', '/skill-library',
  '/skill-open-brain-to-kb', '/skill-rev-ops-global-brand', '/skill-subagent-driven-development',
  '/skill-guide', '/skill-vector-art',
  '/skill-database-hygiene', '/skill-salesforce-audit', '/skill-salesforce-campaigns',
  '/skill-salesforce-cli', '/skill-sf-integration-arch', '/skill-sf-pipeline-snapshot',
  '/skill-buying-group', '/skill-eloqua-audit', '/skill-flow-builder',
  '/skill-hub-spot-audit', '/skill-lead-scoring', '/skill-marketo-audit',
  '/skill-martech-audit', '/skill-renewal-playbooks',
  '/skill-docx', '/skill-email-sequence', '/skill-google-doc', '/skill-pdf',
  '/skill-pptx', '/skill-sales-asset', '/skill-slide-deck-storytelling', '/skill-xlsx',
  '/skill-audit', '/skill-audit-data-extraction', '/skill-data-sql-queries',
  '/skill-data-visualization', '/skill-kb-extract', '/skill-knowledge-base',
  '/skill-multimodal-ingest', '/skill-open-brain-weekly',
  '/skill-attribution-modeling', '/skill-four-pillars', '/skill-lifecycle-modeling',
  '/skill-rev-ops-context', '/skill-rev-ops-cro-frameworks', '/skill-rev-ops-wp-page',
  '/skill-rgos-platform', '/skill-sow-creator',
  '/skill-copy-editing', '/skill-copywriting', '/skill-greg-social-media',
  '/skill-launch-strategy', '/skill-prompting-guide', '/skill-sales-outreach',
  '/skill-sales-research', '/skill-social-content',
  '/skill-churn-prevention', '/skill-cowork-best-practices', '/skill-cowork-debrief',
  '/skill-hub-spot-migration', '/skill-multi-instance-orchestration',
  '/skill-skill-creator', '/skill-supreme-optimization-brand', '/skill-tech-stack-audit',
  '/skill-salesforce-data-cleanup', '/skill-salesforce-data-model',
  '/skill-sf-dashboard-strategy', '/skill-sf-cpq',
  '/skill-sf-admin-daily-dashboard', '/skill-sf-data-completeness-score',
  '/skill-sf-duplicate-management', '/skill-sf-dynamic-forms-migration',
  '/skill-sf-agentforce-sdr-setup', '/skill-sf-approval-to-flow-migration',
  '/skill-sf-auto-contact-roles', '/skill-sf-auto-launch-approval',
  '/skill-sf-auto-renewal-opportunity', '/skill-sf-automation-analytics',
  '/skill-sf-automation-bypass-switch', '/skill-sf-campaign-influence-model',
  '/skill-sf-campaign-member-status',
  '/skill-sf-case-status-auto-toggle', '/skill-sf-close-date-correction',
  '/skill-sf-connected-app-security-audit', '/skill-sf-contact-job-change-handler',
  '/skill-sf-einstein-opp-scoring', '/skill-sf-einstein-prediction-builder',
  '/skill-sf-field-history-date-stamps', '/skill-sf-file-triggered-flows',
  '/skill-sf-guided-case-resolution', '/skill-sf-hubspot-sync-audit',
  '/skill-sf-lead-to-account-matching', '/skill-sf-opportunity-pause-button',
  '/skill-sf-org-monitoring-setup', '/skill-sf-pardot-bridge-flows',
  '/skill-sf-pre-closed-won-gate', '/skill-sf-round-robin-assignment',
  '/skill-sf-screen-flow-modernization', '/skill-sf-sharing-rules-architecture',
  '/skill-sf-slack-automation-pack', '/skill-sf-stale-lead-disqualification',
  '/skill-sf-sub-flow-architecture', '/skill-sf-user-access-policies',
  '/skill-sf-validation-rule-alternatives',
  '/skill-brainstorming', '/skill-find-skills', '/skill-marketing-psychology',
  '/skill-onboard', '/skill-page-cro', '/skill-pdf-processing-pro',
  '/skill-schema-markup', '/skill-seo-audit', '/skill-seo-content-rewrite',
  '/company-task-submit', '/supreme-outstanding',
  '/app/agent-memory', '/app/agent-optimization', '/app/agent-systems', '/app/agent-theta',
  '/app/agents', '/app/agents-monitor', '/app/analytics',
  '/app/cortex-events', '/app/cortex-messages', '/app/cortex-tasks',
  '/app/create-task-page', '/app/dashboard',
  '/app/config-guardrails', '/app/config-orchestrator-settings',
  '/app/config-permissions', '/app/config-rotations',
  '/app/connector-status', '/app/connectors',
  '/app/context-brand', '/app/context-campaign-history', '/app/context-competitive',
  '/app/context-complete', '/app/context-icp', '/app/context-integrations',
  '/app/context-sales-process',
  '/app/cortex-knowledge-base', '/app/cortex-sources',
  '/app/enrichment-hub', '/app/experiments', '/app/portal-capabilities',
  '/app/capabilities', '/app/config-behavior', '/app/dream-log', '/app/memory', '/app/wiki-graph',
  '/app/tool-library',
  '/app/marketplace', '/app/model-settings', '/app/nl-query',
  '/app/onboarding', '/app/play-builder', '/app/plays', '/app/rules',
  '/app/settings',
  // rgos fleet / orchestrator / play / work / wiki / signal pages (2026-05-24 sweep)
  '/app/content-queue', '/app/data-ops-monitor',
  '/app/fleet-activity', '/app/fleet-agents', '/app/fleet-health', '/app/fleet-orgo', '/app/fleet-sessions',
  '/app/fleet-schedules', '/app/fleet-strategy', '/app/fleet-tasks', '/app/fleet-wip',
  '/app/insights', '/app/linked-in-presence-engine', '/app/linked-in-presence-setup',
  '/app/orchestrator-agent-detail', '/app/orchestrator-agents',
  '/app/orchestrator-analytics', '/app/orchestrator-briefing',
  '/app/play-history', '/app/play-output', '/app/play-runner', '/app/play-running',
  '/app/signal-triggers', '/app/signal-watchers', '/app/skills', '/app/strategy', '/app/voice',
  '/app/wiki-concepts-page', '/app/wiki-health', '/app/wiki-page',
  // Tab sub-components of /app/wiki (src/pages/portal/wiki/{EvalTab,GovernanceTab,ReviewTab}.tsx),
  // not standalone routes — exercised by the /app/wiki harness checks
  // (hub-qa-playwright.ts). Listed here so the filename→route discovery stops
  // flagging them as blind spots (2026-06-16 sweep). ReviewTab renders inside
  // WikiHealth.tsx (<ReviewTab />), same class as eval-tab/governance-tab.
  '/app/wiki/eval-tab', '/app/wiki/governance-tab', '/app/wiki/review-tab',
  '/app/work-approvals', '/app/work-comms', '/app/work-inbox', '/app/work-reviews',
  '/app/workflow-execution-history', '/app/workflow-health',
  // ob1-parents routes (2026-05-24 sweep)
  '/activity', '/beer', '/casita', '/estate-map', '/family', '/garden',
  '/history', '/household', '/insights', '/maintenance', '/meals', '/media',
  '/more', '/offline', '/onboarding', '/search', '/settings/household',
  '/shared', '/unlock', '/veo', '/weather', '/widget', '/wine',
  // ob1-app routes (2026-05-24 sweep)
  '/beehives', '/beehives/langstroth', '/beehives/warre',
  '/cottage', '/farm', '/field', '/grounds', '/mushrooms', '/music', '/orchard',
  '/talk',
  // 2026-06-06: blind-spot closure — fleet-board is FleetBoard.tsx tab at /app/fleet/agents?tab=board;
  // audit/ios is IOSAuditPage in ob1-app (iOS Audit Bridge)
  '/app/fleet-board', '/audit/ios',
]);

// Routes to skip — auth/redirects/portals/guides not worth QA-scanning
// Uses startsWith so /guide/ covers /guide/foo, and /guide covers /guide-admin etc.
const SKIP_PREFIXES = ['/guide', '/auth', '/login', '/callback', '/portal/', '/not-found', '/diagnostic-public', '/company-portal', '/hygiene-report-public'];

const AGENTS_DIR = path.join(REPO_ROOT, 'orgs/revops-global/agents');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function run(cmd, { silent = false } = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: silent ? ['pipe','pipe','pipe'] : undefined });
  } catch (e) {
    return e.stdout || '';
  }
}

function ghApiTree(repo) {
  const raw = run(`gh api "repos/${repo}/git/trees/main?recursive=1" --jq '.tree[].path' 2>/dev/null`, { silent: true });
  return raw.trim().split('\n').filter(Boolean);
}

/** Convert App Router path (app/foo/bar/page.tsx) → /foo/bar */
function appRouterToRoute(filePath) {
  const stripped = filePath
    .replace(/^app\//, '')
    .replace(/(^|\/)page\.tsx$/, '')  // handles both root page.tsx and nested /page.tsx
    .replace(/\/+$/, '');
  return '/' + stripped;
}

/** Convert Pages Router path (src/pages/Foo/Bar.tsx) → /foo/bar */
function pagesRouterToRoute(filePath) {
  // Strip src/pages/ prefix, .tsx suffix
  let route = filePath.replace(/^src\/pages\//, '').replace(/\.tsx$/, '');
  // PascalCase segments → kebab-case
  route = route.split('/').map(seg => seg.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()).join('/');
  // portal/ prefix → /app/
  route = route.replace(/^portal\//, 'app/');
  // index → ''
  route = route.replace(/\/index$/, '').replace(/^index$/, '');
  return '/' + route;
}

function shouldSkip(route) {
  return SKIP_PREFIXES.some(p => route.startsWith(p));
}

// Parse "Xd Xh Xm" or ISO duration strings from bus list-crons output
function parseAgeMs(ageStr) {
  if (!ageStr) return null;
  let ms = 0;
  const d = ageStr.match(/(\d+)d/);  if (d) ms += parseInt(d[1]) * 86400000;
  const h = ageStr.match(/(\d+)h/);  if (h) ms += parseInt(h[1]) * 3600000;
  const m = ageStr.match(/(\d+)m/);  if (m) ms += parseInt(m[1]) * 60000;
  return ms || null;
}

function intervalToMs(interval) {
  if (!interval) return null;
  if (interval.endsWith('m')) return parseInt(interval) * 60000;
  if (interval.endsWith('h')) return parseInt(interval) * 3600000;
  if (interval.endsWith('d')) return parseInt(interval) * 86400000;
  return null;
}

// Parse cron schedule expression to approximate ms interval (best-effort)
function cronExprToMs(expr) {
  if (!expr) return null;
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5) return null;
  const [min, hour] = parts;
  if (min.startsWith('*/')) return parseInt(min.slice(2)) * 60000;
  if (hour.startsWith('*/')) return parseInt(hour.slice(2)) * 3600000;
  // daily/weekly patterns → rough multiplier
  if (parts[2] === '*' && parts[3] === '*') {
    const dow = parts[4];
    if (dow === '*') return 86400000;          // daily
    if (dow.includes(',')) return 86400000 * 3.5; // ~mid-week
    return 86400000 * 7;                       // weekly
  }
  return null; // can't infer
}

// ---------------------------------------------------------------------------
// Category A: Web Surface Coverage
// ---------------------------------------------------------------------------
async function scanWebSurfaces() {
  const blindSpots = [];
  const covered    = [];
  const repoResults = {};

  for (const repo of SCAN_REPOS) {
    const files = ghApiTree(repo);
    const pages = files.filter(f =>
      (f.startsWith('app/') && (f.endsWith('/page.tsx') || f === 'app/page.tsx')) ||
      (f.startsWith('src/pages/') && f.endsWith('.tsx') && !f.includes('/_') && !f.endsWith('.test.tsx'))
    );

    const routes = [];
    for (const f of pages) {
      const route = f.startsWith('app/') ? appRouterToRoute(f) : pagesRouterToRoute(f);
      if (!shouldSkip(route)) routes.push({ route, file: f });
    }

    repoResults[repo] = routes;

    for (const { route, file } of routes) {
      if (KNOWN_QA_ROUTES.has(route)) {
        covered.push({ route, repo, file });
      } else {
        blindSpots.push({ route, repo, file });
      }
    }
  }

  return { blindSpots, covered, repoResults };
}

// ---------------------------------------------------------------------------
// Category B: Zombie Cron Detection
// ---------------------------------------------------------------------------

/**
 * Returns a Set of agent names currently running.
 * Uses `cortextos bus list-agents` for primary state; cross-checks
 * heartbeat_age_minutes so agents mid --continue restart (running=false
 * but heartbeat fresh within 30min) are not falsely bucketed as stopped.
 */
function getRunningAgents() {
  // Primary: cortextos status (fast, local)
  const statusRaw = run('cortextos status 2>/dev/null', { silent: true });
  const running = new Set();
  for (const line of statusRaw.split('\n')) {
    const m = line.match(/^\s+(\S+)\s+running\b/);
    if (m) running.add(m[1]);
  }

  // Restart-window tolerance: list-agents gives heartbeat_age_minutes.
  // If an agent is NOT in the running set but its last heartbeat is <30min
  // old, it is likely mid --continue restart — treat as running to avoid
  // false stopped-agent bucket.
  try {
    const agentsRaw = run('cortextos bus list-agents 2>/dev/null', { silent: true });
    const agents = JSON.parse(agentsRaw);
    for (const a of agents) {
      if (!running.has(a.name) && typeof a.heartbeat_age_minutes === 'number' && a.heartbeat_age_minutes < 30) {
        running.add(a.name);
      }
    }
  } catch { /* list-agents unavailable or non-JSON — fall back to status only */ }

  return running;
}

/**
 * Returns true if a cron uses spawn-codex / spawn-worker patterns —
 * checks metadata.runner first (authoritative), then falls back to prompt text.
 * These crons depend on an external auth token; stale last-fire may reflect
 * a blocked worker rather than a dead cron.
 */
function isSpawnWorkerCron(prompt, metadata) {
  const runner = metadata?.runner;
  if (runner === 'spawn-worker' || runner === 'spawn-codex') return true;
  return /spawn[-_]?codex|spawn[-_]?worker|computer[-_]?use/i.test(prompt || '');
}

/**
 * Classify why a blocked-by-worker cron is stale by reading recent sidecar
 * files from the agent's output dir. Returns 'token_invalidated' (401),
 * 'resource_exhausted' (429), or 'unknown'.
 */
function classifyWorkerBlock(agent) {
  const outputDir = path.join(AGENTS_DIR, agent, 'output');
  try {
    const sidecars = fs.readdirSync(outputDir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try { return { f, mtime: fs.statSync(path.join(outputDir, f)).mtimeMs }; }
        catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 10);

    for (const { f } of sidecars) {
      try {
        const sidecar = JSON.parse(fs.readFileSync(path.join(outputDir, f), 'utf8'));
        const stderr  = (sidecar.stderr_excerpt || sidecar.stderr || '');
        if (/401|unauthorized|token.*invalid|invalid.*token|authentication.*failed/i.test(stderr)) {
          return 'token_invalidated';
        }
        if (/429|rate.*limit|resource.*exhaust|quota.*exceed/i.test(stderr)) {
          return 'resource_exhausted';
        }
      } catch { /* skip unreadable sidecar */ }
    }
  } catch { /* output dir absent */ }
  return 'unknown';
}

function scanZombieCrons() {
  const agents = fs.readdirSync(AGENTS_DIR).filter(a => {
    const cfgPath = path.join(AGENTS_DIR, a, 'config.json');
    return fs.existsSync(cfgPath) && a !== '_archive';
  });

  // Rule 1: only flag crons belonging to agents that are actually running.
  // Stopped agents have legitimately dormant crons — they are not zombies.
  const runningAgents = getRunningAgents();

  const zombies          = [];
  const runnerDown       = [];   // cron fires on schedule but its runner agent fails (attempted fresh, fired stale)
  const healthy          = [];
  const noData           = [];
  const disabledCrons    = [];   // Rule 2: intentionally disabled — not zombies
  const stoppedAgentCrons = [];  // Rule 1: agent not running — not zombies

  for (const agent of agents) {
    const cfgPath = path.join(AGENTS_DIR, agent, 'config.json');
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { continue; }

    // Skip intentionally-disabled agents — their crons are correctly suppressed, not zombies
    if (cfg.enabled === false) continue;

    const crons = cfg.crons || [];
    if (crons.length === 0) continue;

    // Rule 1: skip agents not currently running — their crons are dormant by design
    if (!runningAgents.has(agent)) {
      for (const cron of crons) {
        stoppedAgentCrons.push({ agent, name: cron.name });
      }
      continue;
    }

    // Get live cron data from daemon (JSON for last_fire_attempted_at access)
    const raw = run(`cortextos bus list-crons ${agent} --json 2>/dev/null`, { silent: true });

    // Build map: cron name → daemon record
    const cronMap = {};
    try {
      const records = JSON.parse(raw || '[]');
      for (const r of records) {
        if (!r.name) continue;
        // Normalise enabled: daemon JSON uses boolean, text table used 'yes'/'no'
        cronMap[r.name] = {
          schedule:            r.schedule,
          enabled:             r.enabled ? 'yes' : 'no',
          lastFire:            r.last_fired_at
            ? new Date(r.last_fired_at).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
            : '-',
          lastFireAttemptedAt: r.last_fire_attempted_at || null,
          lastFiredAt:         r.last_fired_at || null,
          daemonMetadata:      r.metadata || {},
        };
      }
    } catch { /* empty / malformed — cronMap stays {} */ }

    for (const cron of crons) {
      const name     = cron.name;
      const interval = cron.interval;
      const cronExpr = cron.cron;
      const prompt   = cron.prompt || '';
      const live     = cronMap[name];

      if (!live) {
        // session_cron: true marks crons managed via CronCreate (session-only) rather than
        // the daemon. They never appear in bus list-crons by design — not a zombie.
        if (cron.session_cron) continue;
        noData.push({ agent, name, reason: 'not found in bus list-crons' });
        continue;
      }

      // Rule 2: disabled crons are intentional — separate bucket, not zombies
      if (live.enabled !== 'yes') {
        disabledCrons.push({ agent, name, lastFire: live.lastFire, schedule: live.schedule });
        continue;
      }

      const lastFireStr = live.lastFire;
      if (!lastFireStr || lastFireStr === '-') {
        // Never fired — only a zombie if the agent has been running long enough
        noData.push({ agent, name, reason: 'never fired', schedule: live.schedule });
        continue;
      }

      // Parse last fire timestamp and compute age
      let lastFireMs;
      try {
        lastFireMs = new Date(lastFireStr.replace(' UTC', 'Z')).getTime();
      } catch { continue; }

      const ageMs = Date.now() - lastFireMs;
      // Prefer daemon-reported schedule as authoritative interval; config.json may
      // differ from what the daemon actually runs (e.g. heartbeat config=10m daemon=30m).
      const liveIntervalMs = live.schedule
        ? (intervalToMs(live.schedule) || cronExprToMs(live.schedule))
        : null;
      const intervalMs = liveIntervalMs || (interval ? intervalToMs(interval) : cronExprToMs(cronExpr));

      if (!intervalMs) {
        healthy.push({ agent, name, lastFire: lastFireStr });
        continue;
      }

      const ratio = ageMs / intervalMs;

      // Check for success signal in activity log (best-effort)
      const activityLog = path.join(
        process.env.HOME || '/home/cortextos',
        `.cortextos/${process.env.CTX_INSTANCE_ID || ''}/logs/${agent}/activity.log`
      );
      let hasRecentSuccess = false;
      if (fs.existsSync(activityLog)) {
        try {
          const logTail = execSync(`tail -200 "${activityLog}" 2>/dev/null`, { encoding: 'utf8' });
          // Look for success events from this cron within 2x interval
          const successPattern = new RegExp(`${name}.*success|success.*${name}`, 'i');
          for (const logLine of logTail.split('\n')) {
            if (!successPattern.test(logLine)) continue;
            const tsMatch = logLine.match(/\d{4}-\d{2}-\d{2}T?\d{2}:\d{2}/);
            if (!tsMatch) continue;
            const eventAge = Date.now() - new Date(tsMatch[0]).getTime();
            if (eventAge < intervalMs * 2) { hasRecentSuccess = true; break; }
          }
        } catch { /* log unreadable */ }
      }

      if (ratio > 2) {
        // Rule 3a: distinguish "cron not firing" from "cron fires but runner fails".
        // last_fired_at only advances on SUCCESS, so it freezes when the runner is down.
        // last_fire_attempted_at advances every time the daemon tries — if it is fresh,
        // the cron IS being dispatched on schedule; the runner is just failing.
        // Only classify as a true zombie when BOTH timestamps are stale.
        const attemptedAt = live.lastFireAttemptedAt;
        const attemptedMs = attemptedAt ? new Date(attemptedAt).getTime() : null;
        const attemptedAgeMs = attemptedMs ? Date.now() - attemptedMs : null;
        const attemptedFresh = attemptedAgeMs !== null && attemptedAgeMs < intervalMs * 2;

        if (attemptedFresh) {
          // Cron is firing on schedule — runner agent is down or erroring.
          // Check the runner agent heartbeat to diagnose.
          // When runner=spawn-codex, the actual failing agent is metadata.agent (e.g. codex),
          // not the owning agent. Use daemon metadata first (authoritative), then config.json fallback.
          const daemonMeta = live.daemonMetadata || {};
          const isSpawnCodex = daemonMeta.runner === 'spawn-codex' || cron.metadata?.runner === 'spawn-codex';
          const runnerAgent = isSpawnCodex
            ? (daemonMeta.agent || cron.metadata?.agent || 'codex')
            : (cron.metadata?.runner_agent || agent);
          const runnerHeartbeat = run(
            `cortextos bus list-agents 2>/dev/null | grep -i "^\\s*${runnerAgent}" | head -1`,
            { silent: true }
          ).trim();
          const runnerStatus = runnerHeartbeat ? runnerHeartbeat : 'unknown';
          runnerDown.push({
            agent, name,
            reason: `cron fires on schedule (attempted ${Math.round(attemptedAgeMs/60000)}m ago) but last success=${Math.round(ageMs/60000)}m ago — runner agent may be down or erroring`,
            lastFire: lastFireStr,
            lastFireAttempted: attemptedAt,
            schedule: live.schedule,
            runnerAgent,
            runnerStatus,
          });
          continue;
        }

        // Rule 3b: spawn-codex / spawn-worker crons — stale last-fire may reflect
        // a blocked worker (e.g. auth token invalid) rather than a dead cron.
        // Flag separately so ops can verify the worker auth rather than the cron itself.
        const spawnWorker = isSpawnWorkerCron(prompt, cron.metadata);
        let status, reason;
        if (spawnWorker) {
          const blockClass = classifyWorkerBlock(agent);
          status = `blocked-by-worker:${blockClass}`;
          reason = `spawn-worker stale — ${blockClass === 'token_invalidated' ? 'token invalidated (401)' : blockClass === 'resource_exhausted' ? 'quota exhausted (429)' : 'verify worker auth'} (age=${Math.round(ageMs/60000)}m)`;
        } else {
          status = hasRecentSuccess ? 'fired-but-check-success' : 'zombie';
          reason = `age=${Math.round(ageMs/60000)}m > 2x interval=${Math.round(intervalMs/60000)}m`;
        }
        zombies.push({
          agent, name, reason, lastFire: lastFireStr,
          schedule: live.schedule, hasRecentSuccess, status,
        });
      } else {
        healthy.push({ agent, name, lastFire: lastFireStr, ratio: Math.round(ratio * 10) / 10 });
      }
    }
  }

  return { zombies, runnerDown, healthy, noData, disabledCrons, stoppedAgentCrons };
}

// ---------------------------------------------------------------------------
// Category C: Repeat-Regression Escalator (B6)
// Tracks surfaces flagged across sweeps; auto-escalates at ≥2 flags in 7d.
// ---------------------------------------------------------------------------
function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); }
  catch { return { flags: [] }; }
}

/**
 * RCA cross-reference: returns the path of the most recent output artifact
 * (across all agents) that references `surfaceKey` and was written after
 * `firstFlaggedDate`. Treats this as evidence a root-cause analysis was
 * completed and the surface is being validated, not actively broken.
 */
function findRcaArtifact(surfaceKey, firstFlaggedDate) {
  const cutoffMs = new Date(firstFlaggedDate + 'T00:00:00Z').getTime();
  // Surface key is "cron:agent/name" or "route:/path" — extract the bare token
  const searchTerm = surfaceKey.replace(/^(?:cron:|route:)/, '');
  const rcaPattern = /\brca\b|root.?cause|rca.?task|rca.?on.?file|fixed|resolved/i;

  try {
    const agentsDir = path.join(REPO_ROOT, 'orgs/revops-global/agents');
    for (const agent of fs.readdirSync(agentsDir)) {
      const outDir = path.join(agentsDir, agent, 'output');
      let files;
      try { files = fs.readdirSync(outDir); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.md') && !f.endsWith('.json') && !f.endsWith('.txt')) continue;
        const fPath = path.join(outDir, f);
        try {
          if (fs.statSync(fPath).mtimeMs < cutoffMs) continue;
          const content = fs.readFileSync(fPath, 'utf8');
          if (content.includes(searchTerm) && rcaPattern.test(content)) return fPath;
        } catch { /* skip unreadable */ }
      }
    }
  } catch { /* agents dir absent */ }
  return null;
}

function runRepeatRegressionEscalator(webResult, cronResult) {
  const history = loadHistory();
  const cutoff  = Date.now() - ESCALATION_WINDOW_MS;

  // Prune stale entries outside the 7d window
  history.flags = history.flags.filter(f => new Date(f.date + 'T00:00:00Z').getTime() >= cutoff);

  // Build today's flag set from current results
  const todayFlags = [];
  for (const { route, repo } of webResult.blindSpots) {
    todayFlags.push({ key: `route:${route}`, type: 'blind-spot', date: TODAY, surface: `${route} (${repo.split('/')[1]})` });
  }
  // Only true zombies count for escalation — not disabled, stopped-agent, or worker-blocked
  for (const z of cronResult.zombies.filter(z => !z.status.startsWith('blocked-by-worker'))) {
    todayFlags.push({ key: `cron:${z.agent}/${z.name}`, type: 'zombie', date: TODAY, surface: `${z.agent}/${z.name}` });
  }

  // Append today's flags (dedup: one entry per key per day)
  for (const flag of todayFlags) {
    if (!history.flags.some(f => f.key === flag.key && f.date === TODAY)) {
      history.flags.push(flag);
    }
  }

  // Persist updated history
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');

  // Find surfaces at or above threshold — MUST also appear in today's scan.
  // Resolved surfaces (fixed since last flag) drop out immediately even if
  // they have a historical pattern; this prevents escalating already-closed issues.
  const todayFlagKeys = new Set(todayFlags.map(f => f.key));

  const byKey = {};
  for (const f of history.flags) {
    if (!byKey[f.key]) byKey[f.key] = { count: 0, surface: f.surface, type: f.type, dates: [], firstDate: f.date };
    byKey[f.key].count++;
    byKey[f.key].dates.push(f.date);
    if (f.date < byKey[f.key].firstDate) byKey[f.key].firstDate = f.date;
  }

  const escalations = [];
  const rcaOnFile   = [];

  for (const [key, v] of Object.entries(byKey)) {
    if (v.count < ESCALATION_THRESHOLD || !todayFlagKeys.has(key)) continue;

    // RCA cross-reference: if a completed output artifact references this surface
    // and post-dates the first flag, suppress escalation — mark as validating.
    const rcaPath = findRcaArtifact(key, v.firstDate);
    if (rcaPath) {
      rcaOnFile.push({ key, ...v, rcaArtifact: rcaPath });
    } else {
      escalations.push({ key, ...v });
    }
  }

  return { escalations: escalations.sort((a, b) => b.count - a.count), rcaOnFile };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
function buildReport(webResult, cronResult, escalations, rcaOnFile = []) {
  const lines = [];
  const ts = new Date().toISOString();
  lines.push(`# Hub Surface Sweep — ${TODAY}`);
  lines.push(`_Generated ${ts}_`);
  lines.push('');

  // ── Category A ──
  lines.push('## Category A: Web Surface Coverage');
  lines.push('');
  lines.push(`**Repos scanned:** ${SCAN_REPOS.join(', ')}`);
  lines.push(`**Known QA routes:** ${KNOWN_QA_ROUTES.size}`);
  lines.push(`**Covered:** ${webResult.covered.length}`);
  lines.push(`**Blind spots (uncovered):** ${webResult.blindSpots.length}`);
  lines.push('');

  if (webResult.blindSpots.length > 0) {
    lines.push('### Uncovered Routes');
    lines.push('');
    lines.push('| Route | Repo | File |');
    lines.push('|-------|------|------|');
    for (const { route, repo, file } of webResult.blindSpots) {
      lines.push(`| \`${route}\` | ${repo.split('/')[1]} | \`${file}\` |`);
    }
    lines.push('');
  } else {
    lines.push('All discovered routes are covered by the QA harness.');
    lines.push('');
  }

  if (webResult.covered.length > 0) {
    lines.push('<details><summary>Covered routes</summary>');
    lines.push('');
    for (const { route, repo } of webResult.covered) {
      lines.push(`- \`${route}\` (${repo.split('/')[1]})`);
    }
    lines.push('</details>');
    lines.push('');
  }

  // ── Category B ──
  lines.push('## Category B: Automation Zombies');
  lines.push('');
  const trueZombies = cronResult.zombies.filter(z => !z.status.startsWith('blocked-by-worker'));
  const workerBlocked = cronResult.zombies.filter(z => z.status.startsWith('blocked-by-worker'));
  const runnerDownList = cronResult.runnerDown || [];
  lines.push(`**Healthy:** ${cronResult.healthy.length}  **Zombies:** ${trueZombies.length}  **Runner-down:** ${runnerDownList.length}  **Worker-blocked:** ${workerBlocked.length}  **No data:** ${cronResult.noData.length}  **Disabled:** ${cronResult.disabledCrons.length}  **Agent stopped:** ${cronResult.stoppedAgentCrons.length}`);
  lines.push('');

  if (trueZombies.length > 0) {
    lines.push('### Zombie Crons (not firing — both attempted and fired timestamps stale)');
    lines.push('');
    lines.push('| Agent | Cron | Reason | Last Fire | Success Signal |');
    lines.push('|-------|------|--------|-----------|----------------|');
    for (const z of trueZombies) {
      const success = z.hasRecentSuccess ? 'yes' : 'no';
      lines.push(`| ${z.agent} | ${z.name} | ${z.reason} | ${z.lastFire || '-'} | ${success} |`);
    }
    lines.push('');
  } else {
    lines.push('No zombie crons detected.');
    lines.push('');
  }

  if (runnerDownList.length > 0) {
    lines.push('### Runner-Down Crons (firing on schedule — runner agent failing)');
    lines.push('');
    lines.push('> Cron dispatch is working (last_fire_attempted_at is recent) but the runner agent is down or erroring (last_fired_at frozen). Check the runner agent heartbeat, not the cron.');
    lines.push('');
    lines.push('| Agent | Cron | Last Attempted | Last Success | Runner |');
    lines.push('|-------|------|----------------|--------------|--------|');
    for (const r of runnerDownList) {
      const attempted = r.lastFireAttempted
        ? new Date(r.lastFireAttempted).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
        : '-';
      lines.push(`| ${r.agent} | ${r.name} | ${attempted} | ${r.lastFire || '-'} | ${r.runnerAgent} |`);
    }
    lines.push('');
  }

  if (workerBlocked.length > 0) {
    lines.push('### Worker-Blocked Crons (verify auth, not cron)');
    lines.push('');
    lines.push('> These crons use spawn-codex / spawn-worker. Stale last-fire may reflect a blocked worker token rather than a dead cron. Verify worker auth before treating as a zombie.');
    lines.push('');
    lines.push('| Agent | Cron | Block Class | Last Fire |');
    lines.push('|-------|------|-------------|-----------|');
    for (const z of workerBlocked) {
      const blockClass = z.status.includes(':') ? z.status.split(':')[1] : 'unknown';
      lines.push(`| ${z.agent} | ${z.name} | ${blockClass} | ${z.lastFire || '-'} |`);
    }
    lines.push('');
  }

  if (cronResult.noData.length > 0) {
    lines.push('### Crons With No Fire Data');
    lines.push('');
    for (const n of cronResult.noData) {
      lines.push(`- **${n.agent}/${n.name}**: ${n.reason}`);
    }
    lines.push('');
  }

  if (cronResult.disabledCrons.length > 0) {
    lines.push('<details><summary>Disabled crons (intentional — not zombies)</summary>');
    lines.push('');
    for (const d of cronResult.disabledCrons) {
      lines.push(`- **${d.agent}/${d.name}** (last fire: ${d.lastFire || '-'})`);
    }
    lines.push('</details>');
    lines.push('');
  }

  if (cronResult.stoppedAgentCrons.length > 0) {
    lines.push('<details><summary>Stopped-agent crons (agent not running — not zombies)</summary>');
    lines.push('');
    for (const s of cronResult.stoppedAgentCrons) {
      lines.push(`- **${s.agent}/${s.name}**`);
    }
    lines.push('</details>');
    lines.push('');
  }

  // ── Category C: Repeat Regressions ──
  if (escalations.length > 0) {
    lines.push('## Category C: Repeat Regressions — MERGE-BLOCKER');
    lines.push('');
    lines.push(`> ${escalations.length} surface(s) flagged ≥${ESCALATION_THRESHOLD}× in the last 7 days. Auto-escalated to merge-blocker severity.`);
    lines.push('');
    lines.push('| Surface | Type | Flags (7d) | Dates |');
    lines.push('|---------|------|-----------|-------|');
    for (const e of escalations) {
      lines.push(`| \`${e.surface}\` | ${e.type} | ${e.count} | ${e.dates.join(', ')} |`);
    }
    lines.push('');
  }

  // ── Category C: RCA-on-file (suppressed escalations) ──
  if (rcaOnFile.length > 0) {
    lines.push('## Category C: RCA-on-file — Validating (suppressed from merge-blocker)');
    lines.push('');
    lines.push(`> ${rcaOnFile.length} surface(s) met the repeat-regression threshold but have a post-flag RCA artifact on file. Not escalated — monitoring for resolution.`);
    lines.push('');
    lines.push('| Surface | Type | Flags (7d) | RCA Artifact |');
    lines.push('|---------|------|-----------|--------------|');
    for (const e of rcaOnFile) {
      const artifactName = path.basename(e.rcaArtifact);
      lines.push(`| \`${e.surface}\` | ${e.type} | ${e.count} | ${artifactName} |`);
    }
    lines.push('');
  }

  // Summary
  const trueZombieCount = cronResult.zombies.filter(z => !z.status.startsWith('blocked-by-worker')).length;
  const workerBlockedCount = cronResult.zombies.filter(z => z.status.startsWith('blocked-by-worker')).length;
  const runnerDownCount = (cronResult.runnerDown || []).length;
  const issueCount = webResult.blindSpots.length + trueZombieCount;
  lines.push('## Summary');
  lines.push('');
  if (issueCount === 0 && runnerDownCount === 0 && escalations.length === 0 && rcaOnFile.length === 0) {
    lines.push('No issues found. All surfaces covered, all crons healthy.');
  } else {
    const parts = [];
    if (webResult.blindSpots.length > 0)  parts.push(`${webResult.blindSpots.length} uncovered route(s)`);
    if (trueZombieCount > 0)              parts.push(`${trueZombieCount} zombie cron(s)`);
    if (runnerDownCount > 0)              parts.push(`${runnerDownCount} runner-down cron(s) (check runner agent heartbeat)`);
    if (workerBlockedCount > 0)           parts.push(`${workerBlockedCount} worker-blocked cron(s) (auth check needed)`);
    if (escalations.length > 0)           parts.push(`${escalations.length} repeat-regression MERGE-BLOCKER(s)`);
    if (rcaOnFile.length > 0)             parts.push(`${rcaOnFile.length} RCA-on-file validating`);
    lines.push(`**${parts.join(', ')}.**`);
  }
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
(async () => {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log('[surface-sweep] Scanning web surfaces...');
  const webResult  = await scanWebSurfaces();
  console.log(`[surface-sweep] Found ${webResult.blindSpots.length} blind spots, ${webResult.covered.length} covered`);

  console.log('[surface-sweep] Scanning crons for zombies...');
  const cronResult = scanZombieCrons();
  console.log(`[surface-sweep] ${cronResult.zombies.length} zombies, ${(cronResult.runnerDown || []).length} runner-down, ${cronResult.healthy.length} healthy, ${cronResult.noData.length} no-data`);

  console.log('[surface-sweep] Running repeat-regression escalator...');
  const { escalations, rcaOnFile } = runRepeatRegressionEscalator(webResult, cronResult);
  console.log(`[surface-sweep] ${escalations.length} surface(s) escalated to merge-blocker, ${rcaOnFile.length} suppressed (RCA-on-file)`);

  const report = buildReport(webResult, cronResult, escalations, rcaOnFile);
  fs.writeFileSync(REPORT, report, 'utf8');
  console.log(`[surface-sweep] Report written: ${REPORT}`);

  // Log event
  run(`cortextos bus log-event action surface_sweep info --meta '{"blind_spots":${webResult.blindSpots.length},"zombies":${cronResult.zombies.length},"runner_down":${(cronResult.runnerDown || []).length},"escalations":${escalations.length},"rca_suppressed":${rcaOnFile.length}}'`, { silent: true });

  // Spawn RGOS tasks for newly-escalated surfaces
  for (const e of escalations) {
    const title = `[MERGE-BLOCKER] Repeat regression: ${e.surface} (${e.count}x in 7d)`;
    const desc  = `Surface flagged ${e.count} times in the last 7 days by hub-surface-sweep. Type: ${e.type}. Dates: ${e.dates.join(', ')}. Auto-escalated by B6 repeat-regression escalator. Fix and verify before next merge to affected surface.`;
    run(`cortextos bus create-task ${JSON.stringify(title)} --desc ${JSON.stringify(desc)} --priority high 2>/dev/null`, { silent: true });
  }

  // Notify orchestrator — suppress repeat runner-down noise.
  // Runner-down items that appeared in the last sweep and haven't changed are
  // already acknowledged; only ping on NEW findings to avoid recurring spam.
  const runnerDownList2 = cronResult.runnerDown || [];
  const runnerDownCount2 = runnerDownList2.length;

  // Load + diff runner-down state from history
  const history2 = loadHistory();
  const prevRunnerDownKeys = new Set(history2.runnerDownKeys || []);
  const currRunnerDownKeys = new Set(runnerDownList2.map(r => `${r.agent}/${r.name}`));
  const newRunnerDown = runnerDownList2.filter(r => !prevRunnerDownKeys.has(`${r.agent}/${r.name}`));
  // Persist current runner-down state for next sweep
  history2.runnerDownKeys = [...currRunnerDownKeys];
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(history2, null, 2), 'utf8'); } catch { /* ignore */ }

  const notifyIssueCount = webResult.blindSpots.length + cronResult.zombies.length + newRunnerDown.length + escalations.length;
  if (notifyIssueCount > 0) {
    const parts = [];
    if (webResult.blindSpots.length > 0) parts.push(`${webResult.blindSpots.length} blind spot(s)`);
    if (cronResult.zombies.length > 0)   parts.push(`${cronResult.zombies.length} zombie cron(s)`);
    if (newRunnerDown.length > 0)        parts.push(`${newRunnerDown.length} NEW runner-down cron(s): ${newRunnerDown.map(r => `${r.agent}/${r.name}(runner:${r.runnerAgent})`).join(', ')}`);
    if (escalations.length > 0)          parts.push(`${escalations.length} MERGE-BLOCKER repeat regression(s)`);
    if (rcaOnFile.length > 0)            parts.push(`${rcaOnFile.length} RCA-on-file validating`);
    const summary = `Surface sweep: ${parts.join(', ')}. Report: ${REPORT}`;
    run(`cortextos bus send-message orchestrator normal '${summary.replace(/'/g, "\\'")}' `, { silent: true });
  }

  process.exit(0);
})();
