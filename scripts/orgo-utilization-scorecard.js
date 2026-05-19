#!/usr/bin/env node
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const OUT_PATH = '/home/cortextos/.cortextos/cortextos1/state/orgo-utilization.jsonl';
const ORGO_OUTPUT_DIR = '/home/cortextos/cortextos/orgs/revops-global/agents/orgo-1/output';
const ONE_HOUR_MS = 60 * 60 * 1000;

const PREFIXES = {
  'orgo-codex-computeruse': ['codex-cu-', 'codex-computeruse', 'vm_codex_computeruse'],
  'orgo-hub-qa': ['hub-qa-', 'hub-qa-sweep-', 'vm_hub_qa'],
  'orgo-linkedin-session': ['linkedin-', 'linkedin-check-', 'vm_linkedin_session'],
  'orgo-telegram-web': ['telegram-', 'telegram-web-', 'telegram-ux-', 'tg-', 'vm_telegram_web'],
  'orgo-wiki-ingestion-worker': ['wiki-', 'wiki-health-', 'wiki-push-', 'wiki-sync-', 'vm_wiki_ingestion_worker'],
};

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

function minutesSince(iso, now) {
  const d = parseDate(iso);
  if (!d) return null;
  return Math.round(((now.getTime() - d.getTime()) / 60000) * 10) / 10;
}

function walkFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  return out;
}

function nodeArtifacts(files, nodeKey) {
  const prefixes = PREFIXES[nodeKey] || [nodeKey.replace(/^orgo-/, '')];
  return files.filter((file) => {
    const rel = path.relative(ORGO_OUTPUT_DIR, file);
    return prefixes.some((prefix) => rel.startsWith(prefix) || rel.includes(`/${prefix}`));
  });
}

function artifactStats(files, node, readiness, now) {
  const relevant = nodeArtifacts(files, node.node_key);
  const recent = relevant.filter((file) => {
    try {
      return now.getTime() - fs.statSync(file).mtimeMs <= ONE_HOUR_MS;
    } catch {
      return false;
    }
  });
  let lastArtifact = readiness.last_artifact || null;
  let lastArtifactAt = readiness.last_artifact_at || null;

  if (!lastArtifact && relevant.length) {
    let newest = null;
    for (const file of relevant) {
      try {
        const stat = fs.statSync(file);
        if (!newest || stat.mtimeMs > newest.mtimeMs) newest = { file, mtimeMs: stat.mtimeMs };
      } catch {}
    }
    if (newest) {
      lastArtifact = path.relative('/home/cortextos/cortextos/orgs/revops-global/agents/orgo-1', newest.file);
      lastArtifactAt = new Date(newest.mtimeMs).toISOString();
    }
  }

  return {
    artifacts_per_hour: recent.length,
    last_artifact: lastArtifact,
    last_artifact_at: lastArtifactAt,
    last_artifact_age_minutes: minutesSince(lastArtifactAt, now),
  };
}

function successRate(node, readiness) {
  if (readiness.last_exec_ok === true) return 1;
  if (readiness.last_exec_ok === false) return 0;
  if ((node.failure_count || 0) > 0) return 0;
  return null;
}

function isAlive(node, readiness) {
  const workload = readiness.current_workload || readiness.current_focus || '';
  const statusApi = readiness.status_api || node.status || null;
  if (statusApi === 'unreachable') return false;
  if (workload === 'offline') return false;
  if (readiness.fresh === false && statusApi !== 'running') return false;
  return true;
}

function main() {
  const now = new Date();
  const raw = execFileSync('cortextos', ['bus', 'orgo-lease-status', '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const nodes = JSON.parse(raw);
  const files = walkFiles(ORGO_OUTPUT_DIR);
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });

  const rows = [];
  for (const node of nodes) {
    const readiness = node.app_readiness || {};
    if (!isAlive(node, readiness)) continue;
    const artifact = artifactStats(files, node, readiness, now);
    const row = {
      event: 'orgo_utilization_scorecard',
      checked_at: now.toISOString(),
      node_key: node.node_key,
      display_name: node.display_name,
      vm_id: readiness.vm_id || null,
      alive: true,
      status_api: readiness.status_api || node.status || null,
      auth_status: readiness.auth_status || null,
      current_workload: readiness.current_workload || readiness.current_focus || null,
      current_task_id: readiness.current_task_id || node.current_task_id || null,
      artifacts_per_hour: artifact.artifacts_per_hour,
      last_artifact: artifact.last_artifact,
      last_artifact_at: artifact.last_artifact_at,
      last_artifact_age_minutes: artifact.last_artifact_age_minutes,
      success_rate: successRate(node, readiness),
      source: 'cortextos bus orgo-lease-status + orgo-1 output artifacts',
    };
    rows.push(row);
    fs.appendFileSync(OUT_PATH, `${JSON.stringify(row)}\n`);
  }

  console.log(JSON.stringify({ ok: true, output: OUT_PATH, rows_written: rows.length, rows }, null, 2));
}

main();
