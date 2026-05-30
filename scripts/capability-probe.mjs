#!/usr/bin/env node
/**
 * capability-probe.mjs
 * Probes agent capabilities and updates dashboard/src/data/capability-monitor.json.
 * Emits capability_check_passed / capability_check_failed bus events.
 *
 * Usage: node scripts/capability-probe.mjs [--capability <id>]
 *   --capability hub_qa | telegram_poller | github_token | gmail_token | linkedin_session
 *   (omit to probe all)
 *
 * Run by the capability-probe cron (every 30m).
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync, execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SECRETS_ENV = path.resolve(REPO_ROOT, 'orgs/revops-global/secrets.env');
const MONITOR_JSON = path.resolve(REPO_ROOT, 'dashboard/src/data/capability-monitor.json');
// Additional env files for agent-specific tokens
const ORCH_ENV = path.resolve(REPO_ROOT, 'orgs/revops-global/agents/orchestrator/.env');
const SUPA_URL = 'https://yyizocyaehmqrottmnaz.supabase.co';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(l => l.trim() && !l.startsWith('#') && l.includes('='))
    .reduce((acc, l) => {
      const idx = l.indexOf('=');
      acc[l.slice(0, idx).trim()] = l.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
      return acc;
    }, {});
}

function loadMonitor() {
  return JSON.parse(fs.readFileSync(MONITOR_JSON, 'utf8'));
}

function saveMonitor(data) {
  // Atomic write — write to tmp then rename
  const tmp = MONITOR_JSON + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, MONITOR_JSON);
}

/** Merge live probe fields into capability entry, preserving all static descriptive fields */
function applyProbeResult(capabilities, capId, result) {
  return capabilities.map(cap => {
    if (cap.id !== capId) return cap;
    return {
      ...cap,
      currentStatus: result.status,
      lastCheckedAt: result.checked_at,
      lastAuthority: result.authority ?? cap.authority,
      observed: result.observed ?? cap.observed,
      proof: result.proof ?? cap.proof,
      lastEventName: result.event_name,
    };
  });
}

function emitBusEvent(capId, passed, payload) {
  const eventName = passed ? 'capability_check_passed' : 'capability_check_failed';
  const meta = JSON.stringify({ capability_id: capId, ...payload });
  try {
    execSync(`cortextos bus log-event capability ${eventName} info --meta '${meta.replace(/'/g, "'\\''")}' 2>/dev/null`, {
      env: { ...process.env },
      timeout: 5000,
    });
  } catch { /* non-fatal — probe result is written to JSON regardless */ }
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function minutesSince(value, now = new Date()) {
  const date = parseDate(value);
  if (!date) return null;
  return Math.round(((now.getTime() - date.getTime()) / 60000) * 10) / 10;
}

function isStandbyComplete(readiness = {}) {
  const workload = `${readiness.current_workload ?? readiness.current_focus ?? ''}`.toLowerCase();
  return workload.includes('standby') && workload.includes('complete');
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

/** telegram_poller: call getMe + getUpdates?timeout=0 with the bot token */
async function probeTelegram(env) {
  const token = env['TELEGRAM_BOT_TOKEN'] ?? env['BOT_TOKEN'];
  if (!token) return { status: 'blocked', observed: 'BOT_TOKEN not in secrets.env', proof: null };
  const checked_at = new Date().toISOString();
  try {
    const r = await fetchWithTimeout(`https://api.telegram.org/bot${token}/getMe`);
    const data = await r.json();
    if (!r.ok || !data.ok) {
      return { status: 'fail', checked_at, observed: `getMe returned ok=false (${r.status})`, proof: JSON.stringify(data).slice(0, 200) };
    }
    const botUsername = data.result?.username ?? '?';
    const updR = await fetchWithTimeout(`https://api.telegram.org/bot${token}/getUpdates?timeout=0`);
    const updData = await updR.json();
    const updOk = updR.ok && updData.ok;
    return {
      status: updOk ? 'ok' : 'warn',
      checked_at,
      authority: `@${botUsername}`,
      observed: `getMe ok, @${botUsername}; getUpdates ${updOk ? 'ok' : 'warn'}`,
      proof: `getMe ok=true username=${botUsername}`,
    };
  } catch (e) {
    return { status: 'fail', checked_at, observed: `Request failed: ${e.message}`, proof: null };
  }
}

/** github_token: GET /user with the token */
async function probeGithub(env) {
  const token = env['GITHUB_TOKEN'] ?? env['GH_TOKEN'];
  if (!token) return { status: 'blocked', observed: 'GITHUB_TOKEN not in secrets.env', proof: null };
  const checked_at = new Date().toISOString();
  try {
    const r = await fetchWithTimeout('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'cortextos-capability-probe' },
    });
    if (r.status === 401 || r.status === 403) {
      return { status: 'fail', checked_at, observed: `GitHub API ${r.status} — token invalid or expired`, proof: null };
    }
    if (!r.ok) {
      return { status: 'warn', checked_at, observed: `GitHub API ${r.status}`, proof: null };
    }
    const data = await r.json();
    const login = data.login ?? '?';
    const scopes = r.headers.get('x-oauth-scopes') ?? 'unknown';
    return {
      status: 'ok',
      checked_at,
      authority: `github.com/${login}`,
      observed: `Authenticated as ${login}; scopes=${scopes}`,
      proof: `GET /user ok; login=${login}`,
    };
  } catch (e) {
    return { status: 'fail', checked_at, observed: `Request failed: ${e.message}`, proof: null };
  }
}

/** gmail_token: exchange refresh token for access token, call users.getProfile */
async function probeGmail(env) {
  const refreshToken = env['GOOGLE_REFRESH_TOKEN'];
  const clientId = env['GOOGLE_CLIENT_ID'];
  const clientSecret = env['GOOGLE_CLIENT_SECRET'];
  if (!refreshToken) return { status: 'blocked', observed: 'GOOGLE_REFRESH_TOKEN not in secrets.env', proof: null };
  const checked_at = new Date().toISOString();
  try {
    // Exchange refresh token for access token
    const tokenR = await fetchWithTimeout('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        ...(clientId ? { client_id: clientId } : {}),
        ...(clientSecret ? { client_secret: clientSecret } : {}),
      }),
    });
    if (!tokenR.ok) {
      const body = await tokenR.text();
      return { status: 'fail', checked_at, observed: `Token refresh failed (${tokenR.status}): ${body.slice(0, 100)}`, proof: null };
    }
    const tokenData = await tokenR.json();
    const accessToken = tokenData.access_token;
    // Probe profile
    const profileR = await fetchWithTimeout('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!profileR.ok) {
      return { status: 'fail', checked_at, observed: `Profile probe failed (${profileR.status})`, proof: null };
    }
    const profile = await profileR.json();
    const email = profile.emailAddress ?? '?';
    return {
      status: 'ok',
      checked_at,
      authority: email,
      observed: `Gmail token valid; emailAddress=${email}; messagesTotal=${profile.messagesTotal ?? '?'}`,
      proof: `users.getProfile ok; emailAddress=${email}`,
    };
  } catch (e) {
    return { status: 'fail', checked_at, observed: `Request failed: ${e.message}`, proof: null };
  }
}

/** hub_qa: mint a Supabase session and probe two sentinel routes */
async function probeHubQa(env) {
  const serviceKey = env['RGOS_SUPABASE_SERVICE_KEY'] ?? env['SUPABASE_DATA_SERVICE_KEY'];
  if (!serviceKey) return { status: 'blocked', observed: 'RGOS_SUPABASE_SERVICE_KEY not in secrets.env', proof: null };
  const checked_at = new Date().toISOString();
  const HUB = 'https://hub.revopsglobal.com';
  const sentinels = ['/app/fleet/tasks', '/app/cortex/theta'];
  try {
    // Generate magic link
    const genRes = await fetchWithTimeout(`${SUPA_URL}/auth/v1/admin/generate_link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${serviceKey}`, apikey: serviceKey },
      body: JSON.stringify({ type: 'magiclink', email: 'greg@revopsglobal.com' }),
    });
    if (!genRes.ok) {
      return { status: 'warn', checked_at, observed: `Could not mint session (${genRes.status}) — auth probe skipped`, proof: null };
    }
    const genData = await genRes.json();
    const actionLink = genData.action_link ?? genData.properties?.action_link;
    if (!actionLink) return { status: 'warn', checked_at, observed: 'No action_link in generate_link response', proof: null };
    // Follow magic link
    const verifyRes = await fetchWithTimeout(actionLink, { redirect: 'manual' }, 10000);
    const location = verifyRes.headers.get('location') ?? '';
    const hash = location.includes('#') ? location.split('#')[1] : '';
    const params = new URLSearchParams(hash);
    const accessToken = params.get('access_token');
    if (!accessToken) {
      return { status: 'warn', checked_at, observed: 'Could not extract access_token from magic link redirect', proof: null };
    }
    // Probe each sentinel via fetch (no full browser needed — just check 200 vs redirect)
    const results = await Promise.all(sentinels.map(async route => {
      try {
        const r = await fetchWithTimeout(`${HUB}${route}`, {
          headers: { Cookie: `sb-yyizocyaehmqrottmnaz-auth-token=${encodeURIComponent(JSON.stringify({ access_token: accessToken }))}` },
          redirect: 'manual',
        }, 8000);
        const redirected = r.status >= 300 && r.status < 400;
        const loginWall = redirected && (r.headers.get('location') ?? '').includes('/auth');
        return { route, ok: !loginWall, status: r.status };
      } catch (e) {
        return { route, ok: false, status: 0, err: e.message };
      }
    }));
    const allOk = results.every(r => r.ok);
    const anyFail = results.some(r => !r.ok);
    const summary = results.map(r => `${r.route}=${r.ok ? r.status : 'AUTH-FAIL'}`).join(', ');
    return {
      status: allOk ? 'ok' : anyFail ? 'fail' : 'warn',
      checked_at,
      authority: 'hub.revopsglobal.com (magic-link auth)',
      observed: summary,
      proof: `Sentinels: ${summary}`,
    };
  } catch (e) {
    return { status: 'warn', checked_at, observed: `Hub-QA probe error: ${e.message}`, proof: null };
  }
}

/** orgo_exec: use the live cortextOS Orgo lease/fleet ledger as lane authority */
async function probeOrgo(env) {
  const checked_at = new Date().toISOString();
  const now = new Date(checked_at);
  try {
    const raw = execFileSync('cortextos', ['bus', 'orgo-lease-status', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
    });
    const nodes = JSON.parse(raw);
    const execNodes = nodes.filter(node => Array.isArray(node.capabilities) && node.capabilities.includes('exec'));
    if (!execNodes.length) {
      return {
        status: 'fail',
        checked_at,
        authority: 'cortextos bus orgo-lease-status',
        observed: 'No exec-capable Orgo lanes in live lease/fleet status',
        proof: 'orgo-lease-status returned 0 nodes with capabilities[]=exec',
      };
    }

    const healthy = [];
    const degraded = [];
    const stale = [];

    for (const node of execNodes) {
      const readiness = node.app_readiness ?? {};
      const lane = node.node_key ?? node.display_name ?? 'unknown-lane';
      const statusApi = readiness.status_api ?? node.status ?? 'unknown';
      const lastCheck = readiness.last_check ?? node.last_heartbeat_at ?? null;
      const ageMinutes = minutesSince(lastCheck, now);
      const lastExecOk = readiness.last_exec_ok;
      const failureReason = readiness.failure_reason ?? node.last_fallback_reason ?? null;
      const blocked = readiness.restart_blocked ?? null;
      const freshFlag = readiness.fresh;
      const hasRecentCheck = ageMinutes !== null && ageMinutes <= 45;
      const isRunning = ['running', 'idle'].includes(statusApi);

      if (ageMinutes === null || ageMinutes > 45 || freshFlag === false) {
        stale.push(`${lane}: last_check=${lastCheck ?? 'missing'} age=${ageMinutes ?? 'unknown'}m`);
        continue;
      }

      if (failureReason || blocked || statusApi === 'unreachable' || node.failure_count > 0) {
        degraded.push(`${lane}: ${failureReason ?? blocked ?? `status=${statusApi}; failures=${node.failure_count ?? 0}`}`);
        continue;
      }

      if (lastExecOk === false && !isStandbyComplete(readiness)) {
        degraded.push(`${lane}: last_exec_ok=false`);
        continue;
      }

      if ((lastExecOk === true && isRunning && hasRecentCheck) || isStandbyComplete(readiness)) {
        healthy.push(`${lane}: last_exec_ok=${lastExecOk === false ? 'standby-complete' : 'true'} status=${statusApi}`);
      } else {
        degraded.push(`${lane}: exec status unclear (last_exec_ok=${lastExecOk ?? 'missing'}, status=${statusApi})`);
      }
    }

    const observedParts = [
      `${healthy.length}/${execNodes.length} exec-capable Orgo lanes healthy`,
      degraded.length ? `${degraded.length} degraded` : null,
      stale.length ? `${stale.length} stale` : null,
    ].filter(Boolean);
    const proof = [
      `healthy=[${healthy.join('; ')}]`,
      degraded.length ? `degraded=[${degraded.join('; ')}]` : null,
      stale.length ? `stale=[${stale.join('; ')}]` : null,
    ].filter(Boolean).join(' ');

    if (!healthy.length) {
      return {
        status: 'fail',
        checked_at,
        authority: 'cortextos bus orgo-lease-status',
        observed: observedParts.join('; '),
        proof,
      };
    }

    return {
      status: degraded.length || stale.length ? 'warn' : 'ok',
      checked_at,
      authority: 'cortextos bus orgo-lease-status',
      observed: observedParts.join('; '),
      proof,
    };
  } catch (e) {
    return {
      status: 'fail',
      checked_at,
      authority: 'cortextos bus orgo-lease-status',
      observed: `Lease/fleet status probe failed: ${e.message}`,
      proof: null,
    };
  }
}

/** linkedin_session: check whether LinkedIn cookies are present in known cookie jar */
async function probeLinkedIn(env) {
  const checked_at = new Date().toISOString();
  // LinkedIn session check: look for cookie file; cannot validate without browser
  const cookiePaths = [
    path.resolve(REPO_ROOT, 'orgs/revops-global/secrets/linkedin-cookies.json'),
    path.resolve(REPO_ROOT, 'orgs/revops-global/secrets/linkedin_cookies.json'),
  ];
  const cookiePath = cookiePaths.find(p => fs.existsSync(p));
  if (!cookiePath) {
    return { status: 'blocked', checked_at, observed: 'No linkedin-cookies.json found — session not provisioned on this VM', proof: null };
  }
  try {
    const cookieData = JSON.parse(fs.readFileSync(cookiePath, 'utf8'));
    const cookies = Array.isArray(cookieData) ? cookieData : (cookieData.cookies ?? []);
    const liAt = cookies.find(c => c.name === 'li_at');
    if (!liAt) {
      return { status: 'fail', checked_at, observed: 'li_at cookie missing from cookie file', proof: null };
    }
    const expiresAt = liAt.expires ? new Date(liAt.expires * 1000) : null;
    const ageHours = expiresAt ? Math.round((expiresAt - Date.now()) / 3600000) : null;
    const expired = expiresAt && expiresAt < new Date();
    return {
      status: expired ? 'fail' : (ageHours !== null && ageHours < 24 ? 'warn' : 'ok'),
      checked_at,
      authority: 'linkedin-cookies.json',
      observed: expired ? `li_at expired at ${expiresAt.toISOString()}` : `li_at present; expires ${expiresAt?.toISOString() ?? 'unknown'}`,
      proof: `Cookie file present; li_at=${expired ? 'EXPIRED' : 'valid'}`,
    };
  } catch (e) {
    return { status: 'warn', checked_at, observed: `Cookie file parse error: ${e.message}`, proof: null };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const PROBES = {
  telegram_poller: probeTelegram,
  github_token: probeGithub,
  gmail_token: probeGmail,
  hub_qa: probeHubQa,
  linkedin_session: probeLinkedIn,
};

const argv = process.argv.slice(2);
const capFilter = argv.includes('--capability') ? argv[argv.indexOf('--capability') + 1] : null;

// Merge secrets.env + orchestrator .env (orchestrator has BOT_TOKEN; secrets.env has API keys)
const env = { ...loadEnv(SECRETS_ENV), ...loadEnv(ORCH_ENV) };
const monitor = loadMonitor();

const toProbe = capFilter ? [capFilter] : Object.keys(PROBES);
const missing = toProbe.filter(id => !PROBES[id]);
if (missing.length) {
  console.error(`Unknown capability ids: ${missing.join(', ')}. Valid: ${Object.keys(PROBES).join(', ')}`);
  process.exit(1);
}

console.log(`[capability-probe] Probing: ${toProbe.join(', ')}`);

let caps = monitor.capabilities;
for (const capId of toProbe) {
  process.stdout.write(`  ${capId}... `);
  let result;
  try {
    result = await PROBES[capId](env);
  } catch (e) {
    result = { status: 'fail', checked_at: new Date().toISOString(), observed: `Probe threw: ${e.message}`, proof: null };
  }
  result.event_name = result.status === 'fail' ? 'capability_check_failed' : 'capability_check_passed';
  console.log(`${result.status} — ${result.observed}`);
  caps = applyProbeResult(caps, capId, result);
  emitBusEvent(capId, result.status !== 'fail', result);
}

const updated = { ...monitor, capabilities: caps };
saveMonitor(updated);
console.log(`[capability-probe] capability-monitor.json updated.`);
