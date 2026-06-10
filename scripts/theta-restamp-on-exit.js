#!/usr/bin/env node
/**
 * theta-restamp-on-exit.js
 *
 * Fired by the daemon when a theta-wave spawn-worker exits. If the
 * theta_sessions row for the cycle is still status='running' (the worker died
 * or its terminal MCP write was lost — see analyst RCA 2026-06-10), restamp it
 * to status='error' with the exit context so the row never sticks in
 * 'running' and the freshness watchdog reports a truthful state.
 *
 * The PATCH is guarded by status=eq.running, so a worker that already wrote
 * its own terminal status (complete/partial/error) is never overwritten.
 *
 * Usage: node scripts/theta-restamp-on-exit.js --worker <name> --exit-code <n>
 */

'use strict';

const { readFileSync } = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = { worker: 'unknown', exitCode: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--worker' && argv[i + 1] != null) args.worker = argv[++i];
    else if (argv[i] === '--exit-code' && argv[i + 1] != null) {
      const n = Number.parseInt(argv[++i], 10);
      args.exitCode = Number.isNaN(n) ? null : n;
    }
  }
  return args;
}

function loadSupabaseEnv(frameworkRoot) {
  const envPath = path.join(frameworkRoot, 'orgs/revops-global/secrets.env');
  try {
    const content = readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  } catch { /* fall through to process.env */ }
  const url = process.env.SUPABASE_RGOS_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_RGOS_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('missing SUPABASE_RGOS_URL/SUPABASE_RGOS_SERVICE_KEY');
  return { url: url.replace(/\/$/, ''), key };
}

function buildRestampSummary(worker, exitCode, nowIso) {
  const code = exitCode == null ? 'unknown' : String(exitCode);
  return (
    `error: theta spawn-worker "${worker}" exited (code ${code}) without writing a terminal status; ` +
    `auto-restamped from 'running' by theta-restamp-on-exit at ${nowIso}. ` +
    'Check the worker stdout log and the session artifact under the analyst output/ directory.'
  );
}

async function restampRunningRows({ url, key, worker, exitCode, now = new Date(), fetchImpl = fetch }) {
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  };

  const listRes = await fetchImpl(
    `${url}/rest/v1/theta_sessions?status=eq.running&select=id,session_id,ran_at&order=ran_at.desc`,
    { headers },
  );
  if (!listRes.ok) throw new Error(`list running rows failed: ${listRes.status} ${await listRes.text()}`);
  const running = await listRes.json();
  if (!Array.isArray(running) || running.length === 0) {
    return { restamped: [], skipped: 'no rows in status=running' };
  }

  const restamped = [];
  for (const row of running) {
    // Guard on status=eq.running again in the PATCH itself: if the worker's
    // own terminal write races us and lands first, this PATCH matches 0 rows.
    const patchRes = await fetchImpl(
      `${url}/rest/v1/theta_sessions?id=eq.${encodeURIComponent(row.id)}&status=eq.running`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          status: 'error',
          synthesis_summary: buildRestampSummary(worker, exitCode, now.toISOString()),
        }),
      },
    );
    if (!patchRes.ok) throw new Error(`patch ${row.session_id} failed: ${patchRes.status} ${await patchRes.text()}`);
    const patched = await patchRes.json();
    if (Array.isArray(patched) && patched.length > 0) {
      restamped.push(row.session_id);
    }
  }
  return { restamped, skipped: null };
}

async function main() {
  const { worker, exitCode } = parseArgs(process.argv.slice(2));
  const frameworkRoot = path.resolve(__dirname, '..');
  const { url, key } = loadSupabaseEnv(frameworkRoot);
  const result = await restampRunningRows({ url, key, worker, exitCode });
  if (result.restamped.length > 0) {
    console.log(`[theta-restamp] restamped to error: ${result.restamped.join(', ')} (worker=${worker}, exit=${exitCode})`);
  } else {
    console.log(`[theta-restamp] nothing to do: ${result.skipped ?? 'terminal status already written'}`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[theta-restamp] Fatal:', err.message || err);
    process.exit(1);
  });
}

if (typeof module !== 'undefined') {
  module.exports = { parseArgs, buildRestampSummary, restampRunningRows };
}
