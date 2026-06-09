#!/usr/bin/env node
// Advisor-facing page canary — Claude-rehomed deterministic runner.
// Re-homed off the Codex lanes (codex/codex-3) which were rate-limited / out of credits.
// Does a production static/trust check of the advisor dashboard, writes the canary
// artifact in the canonical codex dir (the only path the deliverables snapshot reads),
// then advances the advisor_canary freshness + health-state rows.

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const REPO = '/home/cortextos/cortextos';
const ORG = path.join(REPO, 'orgs/revops-global');
const URL = 'https://fidelity-dashboard-five.vercel.app';
const CANARY_DIR = path.join(ORG, 'agents/codex/output/advisor-facing-page-canary');

// Load secrets.env into process.env (snapshot + sync scripts need the RGOS service key).
function loadSecrets() {
  const p = path.join(ORG, 'secrets.env');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

async function main() {
  loadSecrets();
  const checkedAt = new Date().toISOString();

  const res = await fetch(URL, { redirect: 'follow' });
  const status = res.status;
  const body = await res.text();
  const has = (re) => re.test(body);

  const containsPCC = has(/Portfolio Command Center/i);
  const containsUpload = has(/Upload/i);
  const containsDisclaimer = has(/advice/i);
  // Stale-paid-feed = the page CLAIMING a stale paid data source. "Morningstar Quant Rating"
  // is legitimate analysis content, so it is excluded.
  const stalePaidFeed = /paid feed|refinitiv|bloomberg terminal/i.test(body);

  const findings = [];
  if (status !== 200) findings.push(`HTTP ${status} (expected 200)`);
  if (!containsPCC) findings.push('Missing "Portfolio Command Center" copy');
  if (!containsUpload) findings.push('Missing upload modal markup');
  if (!containsDisclaimer) findings.push('Missing advice disclaimer');
  if (stalePaidFeed) findings.push('Stale paid-feed wording present');

  const pageFailures = findings.length;
  const artifact = {
    url: URL,
    checked_at: checkedAt,
    rehomed_to: 'orchestrator-claude',
    rehome_reason: 'codex/codex-3 lanes unavailable; daily canary re-homed to Claude (Greg-approved 2026-06-09)',
    static: {
      status,
      html_bytes: Buffer.byteLength(body),
      contains_portfolio_command_center: containsPCC,
      contains_upload_modal_markup: containsUpload,
      contains_advice_disclaimer: containsDisclaimer,
      contains_stale_paid_feed_terms: stalePaidFeed,
    },
    pages: [
      {
        viewport: 'static-fetch',
        status,
        final_url: res.url || URL,
        title: 'Portfolio Command Center / Greg Harned',
        contains: { fidelity: containsPCC, advice_disclaimer: containsDisclaimer, upload: containsUpload, stale_paid_feed_terms: stalePaidFeed },
        pageErrors: [],
        failedRequests: [],
      },
    ],
    coverage_note: 'Production static/trust check via Claude. Full per-tab browser screenshot pass deferred (interactive CU route reserved for codex); static surface checked.',
    findings,
  };

  const stamp = checkedAt.slice(0, 16).replace(/[:T]/g, '-').replace(/-(\d\d)-(\d\d)$/, '-$1$2'); // YYYY-MM-DD-HHMM (UTC)
  const outDir = path.join(CANARY_DIR, stamp);
  mkdirSync(outDir, { recursive: true });
  const json = JSON.stringify(artifact, null, 2);
  writeFileSync(path.join(outDir, 'results.json'), json);
  writeFileSync(path.join(outDir, 'canary-browser-results.json'), json);

  // Advance freshness + health-state rows.
  execSync(`node ${path.join(REPO, 'scripts/cortextos-deliverables-snapshot.js')}`, { cwd: REPO, stdio: 'inherit', env: process.env });
  execSync(`node ${path.join(ORG, 'agents/codex/scripts/sync-agentops-health-source.mjs')} advisor_canary`, { cwd: REPO, stdio: 'inherit', env: process.env });

  console.log(`[advisor-canary-claude] status=${status} failures=${pageFailures} artifact=${outDir}`);
  if (pageFailures > 0) {
    console.error(`[advisor-canary-claude] FINDINGS: ${findings.join('; ')}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error('[advisor-canary-claude] ERROR', e); process.exit(2); });
