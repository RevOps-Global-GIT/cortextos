#!/usr/bin/env node
/**
 * ob1-farm-qa.js
 * Live-route QA harness for ob1-app farm/estate routes.
 *
 * Visits each route on https://ob1-app.vercel.app with the ob1-auth session
 * cookie and checks that the page loads without errors.
 *
 * Scope: live-route smoke checks ONLY.
 * - No hero/vignette involvement
 * - No ob1-app code edits
 * - Auth: OB1_SESSION_TOKEN from orgs/revops-global/secrets.env
 *
 * Usage:
 *   node scripts/ob1-farm-qa.js
 *
 * Output: orgs/revops-global/agents/dev/output/YYYY-MM-DD-ob1-farm-qa.md
 */

'use strict';

const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const REPO_ROOT  = path.resolve(__dirname, '..');
const SECRETS_ENV = path.join(REPO_ROOT, 'orgs/revops-global/secrets.env');
const OUTPUT_DIR = path.join(REPO_ROOT, 'orgs/revops-global/agents/dev/output');
const TODAY      = new Date().toISOString().slice(0, 10);
const REPORT     = path.join(OUTPUT_DIR, `${TODAY}-ob1-farm-qa.md`);

const OB1_BASE_URL   = 'https://ob1-app.vercel.app';
const OB1_AUTH_COOKIE = 'ob1-auth';

// Farm/estate routes to QA — matches KNOWN_QA_ROUTES ob1-app entries
const FARM_ROUTES = [
  '/beehives',
  '/beehives/langstroth',
  '/beehives/warre',
  '/cottage',
  '/farm',
  '/field',
  '/grounds',
  '/journal',
  '/mushrooms',
  '/music',
  '/orchard',
  '/talk',
];

// Text patterns that indicate an error/not-found page
const ERROR_PATTERNS = [
  /this page could not be found/i,
  /404 - page not found/i,
  /application error/i,
  /internal server error/i,
  /500 - /i,
  /something went wrong/i,
  /unexpected error/i,
  /failed to load/i,
];

// Text patterns that indicate an authentication redirect/block
const AUTH_BLOCK_PATTERNS = [
  /sign in/i,
  /log in/i,
  /unlock/i,
  /enter your pin/i,
  /authentication required/i,
];

// ---------------------------------------------------------------------------
// Env loader
// ---------------------------------------------------------------------------
function loadEnv(p) {
  if (!fs.existsSync(p)) return {};
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter(l => l && !l.startsWith('#') && l.includes('='))
    .reduce((acc, l) => {
      const idx = l.indexOf('=');
      acc[l.slice(0, idx).trim()] = l.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
      return acc;
    }, {});
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
(async () => {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const env = loadEnv(SECRETS_ENV);
  const sessionToken = env['OB1_SESSION_TOKEN'];
  if (!sessionToken) {
    console.error('[ob1-farm-qa] ERROR: OB1_SESSION_TOKEN not found in secrets.env');
    process.exit(1);
  }

  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch (e) {
    console.error('[ob1-farm-qa] ERROR: playwright not installed. Run: npm install playwright');
    process.exit(1);
  }

  console.log(`[ob1-farm-qa] Starting — ${FARM_ROUTES.length} routes to check on ${OB1_BASE_URL}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'ob1-farm-qa/1.0 (headless QA bot)',
  });

  // Set auth cookie before any navigation
  await context.addCookies([{
    name:   OB1_AUTH_COOKIE,
    value:  sessionToken,
    domain: 'ob1-app.vercel.app',
    path:   '/',
    secure: true,
    httpOnly: false,
    sameSite: 'Lax',
  }]);

  const page = await context.newPage();
  const results = [];

  for (const route of FARM_ROUTES) {
    const url = `${OB1_BASE_URL}${route}`;
    let status = 'pass';
    let httpStatus = null;
    let notes = '';

    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      httpStatus = response ? response.status() : null;

      if (httpStatus && httpStatus >= 400) {
        status = 'fail';
        notes = `HTTP ${httpStatus}`;
      } else {
        // Check page content for error / auth-block patterns
        const bodyText = await page.evaluate(() => document.body?.innerText || '');

        const errorMatch = ERROR_PATTERNS.find(p => p.test(bodyText));
        if (errorMatch) {
          status = 'fail';
          notes = `Error pattern in body: ${errorMatch.source.slice(0, 40)}`;
        } else {
          const authMatch = AUTH_BLOCK_PATTERNS.find(p => p.test(bodyText));
          if (authMatch) {
            status = 'warn';
            notes = `Auth block — session token may be stale`;
          } else {
            // Check for blank/empty body
            const textLen = bodyText.trim().length;
            if (textLen < 50) {
              status = 'warn';
              notes = `Very short body (${textLen} chars) — may be empty/broken`;
            } else {
              notes = `HTTP ${httpStatus || 'ok'}, body ${textLen} chars`;
            }
          }
        }
      }
    } catch (e) {
      status = 'fail';
      notes = `Navigation error: ${e.message.slice(0, 80)}`;
    }

    results.push({ route, url, httpStatus, status, notes });
    const icon = status === 'pass' ? '✓' : status === 'warn' ? '⚠' : '✗';
    console.log(`[ob1-farm-qa] ${icon} ${route} — ${notes || status}`);
  }

  await browser.close();

  // ---------------------------------------------------------------------------
  // Build report
  // ---------------------------------------------------------------------------
  const pass = results.filter(r => r.status === 'pass').length;
  const warn = results.filter(r => r.status === 'warn').length;
  const fail = results.filter(r => r.status === 'fail').length;
  const ts   = new Date().toISOString();

  const lines = [];
  lines.push(`# ob1-app Farm Route QA — ${TODAY}`);
  lines.push(`_Generated ${ts}_`);
  lines.push('');
  lines.push(`**Base URL:** ${OB1_BASE_URL}`);
  lines.push(`**Auth:** ${OB1_AUTH_COOKIE} cookie (OB1_SESSION_TOKEN)`);
  lines.push(`**Routes checked:** ${FARM_ROUTES.length}`);
  lines.push(`**Pass:** ${pass}  **Warn:** ${warn}  **Fail:** ${fail}`);
  lines.push('');
  lines.push('## Results');
  lines.push('');
  lines.push('| Status | Route | HTTP | Notes |');
  lines.push('|--------|-------|------|-------|');
  for (const r of results) {
    const icon = r.status === 'pass' ? '✓ pass' : r.status === 'warn' ? '⚠ warn' : '✗ fail';
    lines.push(`| ${icon} | \`${r.route}\` | ${r.httpStatus || '-'} | ${r.notes} |`);
  }
  lines.push('');

  if (fail > 0 || warn > 0) {
    lines.push('## Issues');
    lines.push('');
    for (const r of results.filter(r => r.status !== 'pass')) {
      lines.push(`- **${r.status.toUpperCase()}** \`${r.route}\`: ${r.notes}`);
    }
    lines.push('');
  } else {
    lines.push('All farm routes passed live smoke check.');
    lines.push('');
  }

  const report = lines.join('\n');
  fs.writeFileSync(REPORT, report, 'utf8');
  console.log(`[ob1-farm-qa] Report written: ${REPORT}`);
  console.log(`[ob1-farm-qa] Summary: ${pass} pass, ${warn} warn, ${fail} fail`);

  // Log to activity feed
  try {
    execSync(
      `cortextos bus log-event action ob1_farm_qa_completed info --meta '{"pass":${pass},"warn":${warn},"fail":${fail},"routes":${FARM_ROUTES.length}}'`,
      { encoding: 'utf8', stdio: 'pipe' }
    );
  } catch { /* non-critical */ }

  process.exit(fail > 0 ? 1 : 0);
})();
