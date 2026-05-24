#!/usr/bin/env node
/**
 * Band D dogfood validation checks.
 *
 * Live copy-quality gate for the Estate vignette pipeline:
 *   - fetch today's live vignette JSON from ob1-app production
 *   - run the vignette 8-check critic against title + beat
 *   - query live estate_insights rows for the same broken-copy patterns
 *   - on FAIL, notify Telegram and create a family-agent task with evidence
 */

import { execFileSync, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fingerprint, type CheckResult } from './dogfood-check-result';

interface VignetteJson {
  title?: string;
  beat?: string;
  caption?: string;
  date?: string;
}

interface PatternHit {
  check: string;
  field: 'title' | 'beat' | 'body' | 'row';
  text: string;
  detail: string;
}

interface EstateInsightRow {
  id: string;
  title: string | null;
  body?: string | null;
  dismissed?: boolean | null;
  expires_at?: string | null;
}

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SECRETS_ENV = path.resolve(REPO_ROOT, 'orgs/revops-global/secrets.env');
const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const OUTPUT_DIR = process.env.DOGFOOD_OUTPUT_DIR
  ? path.resolve(process.env.DOGFOOD_OUTPUT_DIR)
  : path.resolve(REPO_ROOT, 'orgs/revops-global/agents/hub-dogfood/output/band-d', RUN_STAMP);
const VIGNETTE_BASE_URL = process.env.DOGFOOD_BAND_D_VIGNETTE_BASE_URL ?? 'https://ob1.revopsglobal.com/vignettes';
const VIGNETTE_DATE = process.env.DOGFOOD_BAND_D_DATE ?? new Date().toISOString().slice(0, 10);
const SUPABASE_DATA_URL = process.env.SUPABASE_DATA_URL ?? 'https://hubauzvpxuparrvqjytt.supabase.co';
const NEXT_STEP_VERBS = [
  'add', 'bring', 'check', 'clip', 'cover', 'delay', 'inspect', 'move',
  'plan', 'protect', 'pull', 'save', 'shift', 'start', 'watch', 'water',
  'harvest', 'feed', 'open', 'close', 'stake', 'thin', 'weed',
];

const results: CheckResult[] = [];
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

function record(result: CheckResult): void {
  results.push(result);
  const icon = result.status === 'PASS' ? '✓' : result.status === 'FAIL' ? '✗' : result.status === 'WARN' ? '!' : '-';
  console.log(`${result.status.padEnd(4)} ${icon} ${fingerprint(result)}`);
  if (result.status !== 'PASS') console.log(`       ${result.evidence}`);
}

function loadEnv(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(line => line.trim() && !line.trim().startsWith('#') && line.includes('='))
    .reduce((acc, line) => {
      const idx = line.indexOf('=');
      acc[line.slice(0, idx).trim()] = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
      return acc;
    }, {} as Record<string, string>);
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function lastSentence(value: string): string {
  return value.split(/[.!?]/).map(part => part.trim()).filter(Boolean).at(-1) ?? value;
}

function isCapitalizedWord(word: string): boolean {
  if (!/[A-Za-z]/.test(word)) return true;
  return /^[A-Z][A-Za-z0-9'’-]*$/.test(word);
}

function hasEmoji(value: string): boolean {
  return /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(value);
}

function findCopyPatternHits(title: string, beat: string): PatternHit[] {
  const hits: PatternHit[] = [];
  const titleWords = title.match(/[A-Za-z][A-Za-z'0-9-]*/g) ?? [];

  if (titleWords.some(word => !isCapitalizedWord(word))) {
    const offenders = titleWords.filter(word => !isCapitalizedWord(word));
    hits.push({
      check: 'not_title_case',
      field: 'title',
      text: title,
      detail: `Title contains non-capitalized word(s): ${offenders.join(', ')}`,
    });
  }

  if (/\sand\s/.test(title) && !/\b(is|are|needs?|knows?|has|gets|faces|starts|comes|keeps|holds|runs|opens|closes|moves|waits|watches|guards)\b/i.test(title)) {
    hits.push({
      check: 'title_case_and',
      field: 'title',
      text: title,
      detail: 'Title uses lowercase " and " between noun phrases without a verb.',
    });
  }

  if (/\bat\s+\d+\s*(?:°\s*)?[fc]\b/i.test(title)) {
    hits.push({
      check: 'at_temperature',
      field: 'title',
      text: title,
      detail: 'Title contains "at [number]F/C".',
    });
  }

  if (/\bat\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(title)) {
    hits.push({
      check: 'at_day',
      field: 'title',
      text: title,
      detail: 'Title contains "at [weekday]".',
    });
  }

  if (/^(he|she|it)\s+(?:has been|has|is|was)\b/i.test(beat)) {
    hits.push({
      check: 'pronoun_prefix',
      field: 'beat',
      text: beat,
      detail: 'Beat starts with He/She/It has/is/was/has been.',
    });
  }

  if (normalize(beat) === normalize(title) || normalize(beat).startsWith(normalize(title))) {
    hits.push({
      check: 'body_repeats_title',
      field: 'beat',
      text: beat,
      detail: 'Beat repeats the title instead of adding useful context.',
    });
  }

  const nextStepRe = new RegExp(`\\b(${NEXT_STEP_VERBS.join('|')})\\b`, 'i');
  if (!nextStepRe.test(lastSentence(beat))) {
    hits.push({
      check: 'no_concrete_next_step',
      field: 'beat',
      text: beat,
      detail: 'Beat lacks a concrete next-step verb in the final sentence.',
    });
  }

  const combined = `${title} ${beat}`;
  if (/[!]/.test(combined) || hasEmoji(combined) || /\[[^\]]+\]|\b(?:source|model|prompt|generated by|nano-banana|gemini|imagen|flow)\s*:/i.test(combined)) {
    hits.push({
      check: 'metadata',
      field: 'row',
      text: combined,
      detail: 'Copy contains emoji, exclamation, bracket tag, or generation metadata.',
    });
  }

  if (/\b(?:might|could|maybe|perhaps|possibly|may want to consider)\b/i.test(combined)) {
    hits.push({
      check: 'hedging',
      field: 'row',
      text: combined,
      detail: 'Copy contains hedging language.',
    });
  }

  return hits;
}

async function fetchLiveVignette(): Promise<{ url: string; data: VignetteJson; hits: PatternHit[] }> {
  const url = `${VIGNETTE_BASE_URL.replace(/\/$/, '')}/${VIGNETTE_DATE}.json`;
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Vignette fetch failed ${response.status}: ${body.slice(0, 500).replace(/\s+/g, ' ')}`);
  }
  const data = await response.json() as VignetteJson;
  const title = String(data.title ?? '').trim();
  const beat = String(data.beat ?? data.caption ?? '').trim();
  if (!title || !beat) {
    return {
      url,
      data,
      hits: [{
        check: 'metadata',
        field: 'row',
        text: JSON.stringify(data).slice(0, 500),
        detail: 'Live vignette JSON is missing title or beat.',
      }],
    };
  }
  return { url, data, hits: findCopyPatternHits(title, beat) };
}

async function fetchEstateInsightRows(): Promise<EstateInsightRow[]> {
  const env = { ...loadEnv(SECRETS_ENV), ...process.env };
  const key = env.SUPABASE_DATA_SERVICE_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY ?? env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!key) throw new Error('Missing SUPABASE_DATA_SERVICE_KEY/SUPABASE_SERVICE_ROLE_KEY/NEXT_PUBLIC_SUPABASE_ANON_KEY.');
  const columns = 'id,title,body,dismissed,expires_at';
  const now = encodeURIComponent(new Date().toISOString());
  const url = `${SUPABASE_DATA_URL.replace(/\/$/, '')}/rest/v1/estate_insights?dismissed=eq.false&expires_at=gt.${now}&select=${encodeURIComponent(columns)}&limit=200`;
  const response = await fetch(url, {
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      accept: 'application/json',
    },
  });
  if (!response.ok) throw new Error(`estate_insights query failed ${response.status}: ${await response.text()}`);
  return await response.json() as EstateInsightRow[];
}

function findEstateSqlMirrorHits(row: EstateInsightRow): Array<PatternHit & { id: string }> {
  const title = String(row.title ?? '').trim();
  const body = String(row.body ?? '').trim();
  const hits: Array<PatternHit & { id: string }> = [];

  if (/\sand\s/.test(title) && / [A-Z][a-z]/.test(title)) {
    hits.push({
      id: row.id,
      check: 'title_case_and',
      field: 'title',
      text: title,
      detail: 'Detection SQL mirror: title contains lowercase " and " plus capitalized noun phrase.',
    });
  }

  if (/\bat\s+\d+\s*(?:°\s*)?[f]\b/i.test(title)) {
    hits.push({
      id: row.id,
      check: 'at_temperature',
      field: 'title',
      text: title,
      detail: 'Detection SQL mirror: title contains "at [number]F".',
    });
  }

  if (/\bat\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(title)) {
    hits.push({
      id: row.id,
      check: 'at_day',
      field: 'title',
      text: title,
      detail: 'Detection SQL mirror: title contains "at [weekday]".',
    });
  }

  if (/^(?:he|she|it)\s+has\s+/i.test(body) || /^(?:he|she|it)\s+(?:is|was|has been)\b/i.test(body)) {
    hits.push({
      id: row.id,
      check: 'pronoun_prefix',
      field: 'body',
      text: body,
      detail: 'Detection SQL mirror: body starts with He/She/It has/is/was/has been.',
    });
  }

  return hits;
}

async function checkEstateInsights(): Promise<{ rows: EstateInsightRow[]; hits: Array<PatternHit & { id: string }> }> {
  const rows = await fetchEstateInsightRows();
  const hits: Array<PatternHit & { id: string }> = [];
  for (const row of rows) {
    hits.push(...findEstateSqlMirrorHits(row));
  }
  return { rows, hits };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function busEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  try {
    const lock = path.resolve(REPO_ROOT, '.cortextos/cortextos1/state/hub-dogfood/session.lock');
    if (fs.existsSync(lock)) {
      env.CTX_SESSION_OWNER_PID = JSON.parse(fs.readFileSync(lock, 'utf8')).owner_pid;
    }
  } catch {
    // Optional daemon guard only.
  }
  return env;
}

function notifyTelegram(message: string): void {
  const chatId = process.env.CTX_TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID || process.env.CHAT_ID;
  if (!chatId) {
    console.log('[notify] skipped Telegram: no CTX_TELEGRAM_CHAT_ID/TELEGRAM_CHAT_ID/CHAT_ID');
    return;
  }
  try {
    execFileSync('cortextos', ['bus', 'send-telegram', chatId, message], {
      cwd: REPO_ROOT,
      env: busEnv(),
      stdio: 'pipe',
    });
    console.log('[notify] Telegram sent');
  } catch (error) {
    console.log(`[notify] Telegram skipped/failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function createFamilyAgentTask(hits: string, reportPath: string): void {
  const title = '[dogfood-band-d] Vignette copy quality failure';
  const desc = [
    'Band D found live vignette or estate_insights copy matching broken-pattern rules.',
    '',
    hits,
    '',
    `Report: ${reportPath}`,
    'Owner: family-agent should rewrite/dismiss offending copy per vignette skill protocol.',
  ].join('\n');
  const args = [
    'bus', 'create-task', title,
    '--desc', desc,
    '--assignee', 'family-agent',
    '--priority', 'high',
    '--success-criteria', 'Offending live vignette JSON and/or estate_insights rows no longer match Band D copy-quality checks; production /vignettes/YYYY-MM-DD.json re-fetch passes.',
    '--out-of-scope', 'Do not change Band D detector thresholds or visual Band C checks while fixing copy.',
    '--escalation-triggers', 'Supabase write blocked, ob1-app PR cannot merge, or production vignette remains contaminated after deploy.',
    '--source-hierarchy', 'hub-dogfood Band D vignette copy-quality cron failure',
    '--required-capabilities', 'ob1-app vignette JSON edit, Supabase estate_insights cleanup, production verification',
    '--fallback-proof', 'Attach report path and exact offending text/pattern if cleanup is blocked.',
    '--artifact-expectations', 'Cleaned JSON/row proof and production curl output.',
    '--goal-ancestry', 'Estate vignette copy quality dogfood coverage',
  ];
  try {
    execFileSync('cortextos', args, {
      cwd: REPO_ROOT,
      env: busEnv(),
      stdio: 'pipe',
    });
    console.log('[task] family-agent task created');
  } catch {
    try {
      execSync(`cortextos bus create-task ${shellQuote(title)} --desc ${shellQuote(desc)} --assignee family-agent --priority high`, {
        cwd: REPO_ROOT,
        env: busEnv(),
        stdio: 'pipe',
      });
      console.log('[task] family-agent task created with fallback brief');
    } catch (error) {
      console.log(`[task] skipped/failed family-agent task creation: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function writeReport(vignette: Awaited<ReturnType<typeof fetchLiveVignette>> | null, estate: Awaited<ReturnType<typeof checkEstateInsights>> | null): string {
  fs.writeFileSync(path.join(OUTPUT_DIR, 'check-results.json'), `${JSON.stringify(results, null, 2)}\n`);
  if (vignette) fs.writeFileSync(path.join(OUTPUT_DIR, 'live-vignette.json'), `${JSON.stringify(vignette.data, null, 2)}\n`);
  if (estate) fs.writeFileSync(path.join(OUTPUT_DIR, 'estate-insights-hits.json'), `${JSON.stringify(estate.hits, null, 2)}\n`);
  const lines = [
    '# Dogfood Band D Vignette Copy Quality Report',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Date: ${VIGNETTE_DATE}`,
    `Results: ${results.filter(r => r.status === 'PASS').length} pass, ${results.filter(r => r.status === 'FAIL').length} fail, ${results.filter(r => r.status === 'WARN').length} warn, ${results.filter(r => r.status === 'SKIP').length} skip`,
    '',
    '| Status | Severity | Surface | Route | Check | Evidence |',
    '|---|---|---|---|---|---|',
    ...results.map(r => `| ${r.status} | ${r.severity} | ${r.surface} | ${r.route} | ${r.check_label} | ${r.evidence.replace(/\|/g, '\\|')} |`),
  ];
  const reportPath = path.join(OUTPUT_DIR, 'report.md');
  fs.writeFileSync(reportPath, `${lines.join('\n')}\n`);
  return reportPath;
}

function formatHits(vignette: Awaited<ReturnType<typeof fetchLiveVignette>> | null, estate: Awaited<ReturnType<typeof checkEstateInsights>> | null): string {
  const lines: string[] = [];
  if (vignette?.hits.length) {
    lines.push(`Live vignette ${vignette.url}:`);
    for (const hit of vignette.hits) lines.push(`- ${hit.check} (${hit.field}): ${hit.text.slice(0, 240)} — ${hit.detail}`);
  }
  if (estate?.hits.length) {
    lines.push(`estate_insights live rows:`);
    for (const hit of estate.hits.slice(0, 20)) lines.push(`- ${hit.id} ${hit.check} (${hit.field}): ${hit.text.slice(0, 240)} — ${hit.detail}`);
    if (estate.hits.length > 20) lines.push(`- ...and ${estate.hits.length - 20} more hits`);
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  let vignette: Awaited<ReturnType<typeof fetchLiveVignette>> | null = null;
  let estate: Awaited<ReturnType<typeof checkEstateInsights>> | null = null;

  try {
    vignette = await fetchLiveVignette();
    record({
      id: 'band-d-live-vignette-copy',
      surface: 'estate-app',
      route: `/vignettes/${VIGNETTE_DATE}.json`,
      status: vignette.hits.length ? 'FAIL' : 'PASS',
      severity: 'P1',
      check_label: 'Live vignette title/beat 8-check critic',
      evidence: vignette.hits.length
        ? vignette.hits.map(hit => `${hit.check}: ${hit.detail}`).join(' | ')
        : `No broken-copy patterns found in title="${vignette.data.title}" beat="${vignette.data.beat ?? vignette.data.caption}".`,
    });
  } catch (error) {
    record({
      id: 'band-d-live-vignette-copy',
      surface: 'estate-app',
      route: `/vignettes/${VIGNETTE_DATE}.json`,
      status: 'FAIL',
      severity: 'P1',
      check_label: 'Live vignette title/beat 8-check critic',
      evidence: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    estate = await checkEstateInsights();
    record({
      id: 'band-d-estate-insights-copy',
      surface: 'estate-app',
      route: 'estate_insights',
      status: estate.hits.length ? 'FAIL' : 'PASS',
      severity: 'P1',
      check_label: 'Live estate_insights broken-pattern SQL mirror',
      evidence: estate.hits.length
        ? `${estate.hits.length} pattern hits across ${new Set(estate.hits.map(hit => hit.id)).size} live row(s): ${estate.hits.slice(0, 8).map(hit => `${hit.id}:${hit.check}`).join(', ')}`
        : `${estate.rows.length} live rows checked; no broken-copy patterns found.`,
    });
  } catch (error) {
    record({
      id: 'band-d-estate-insights-copy',
      surface: 'estate-app',
      route: 'estate_insights',
      status: 'FAIL',
      severity: 'P1',
      check_label: 'Live estate_insights broken-pattern SQL mirror',
      evidence: error instanceof Error ? error.message : String(error),
    });
  }

  const reportPath = writeReport(vignette, estate);
  const failed = results.filter(result => result.status === 'FAIL');
  if (failed.length > 0) {
    const hits = formatHits(vignette, estate) || failed.map(result => `${result.check_label}: ${result.evidence}`).join('\n');
    if (process.env.DOGFOOD_BAND_D_NOTIFY !== '0') {
      notifyTelegram(`Band D vignette copy quality FAIL (${VIGNETTE_DATE}). ${failed.length} failing check(s). Report: ${reportPath}`);
      createFamilyAgentTask(hits, reportPath);
    } else {
      console.log('[notify] skipped Telegram/task side effects because DOGFOOD_BAND_D_NOTIFY=0');
    }
    console.error(`Dogfood Band D failed: ${failed.length} failing checks. Report: ${reportPath}`);
    process.exit(1);
  }
  console.log(`Dogfood Band D passed without failures. Report: ${reportPath}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
