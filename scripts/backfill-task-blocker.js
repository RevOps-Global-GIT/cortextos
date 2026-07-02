#!/usr/bin/env node
/**
 * backfill-task-blocker.js
 *
 * Walks all blocked tasks in the revops-global org and populates
 * meta.blocker with { blocker_reason, next_proof_required } so the
 * Fleet Tasks UI can render the blocker context instead of
 * "No blocking reason recorded".
 *
 * Atomic write: write to .tmp then rename (matches src/utils/atomic.ts).
 * Skips tasks that already have meta.blocker.blocker_reason set.
 */

const { readFileSync, writeFileSync, renameSync, readdirSync } = require('fs');
const { join } = require('path');
const { homedir } = require('os');

const CTX_ROOT = process.env.CTX_ROOT || join(homedir(), '.cortextos', process.env.CTX_INSTANCE_ID || 'cortextos1');
const TASK_DIR = process.env.CORTEXTOS_TASK_DIR || join(CTX_ROOT, 'orgs/revops-global/tasks');

function atomicWrite(filePath, content) {
  const tmp = `${filePath}.tmp.${process.pid}`;
  writeFileSync(tmp, content, 'utf-8');
  renameSync(tmp, filePath);
}

// Derived blocker context keyed by task ID
const BLOCKER_MAP = {
  task_1778703626320_769: {
    blocker_reason: 'Requires browser/CU session with Slack workspace admin access to api.slack.com/apps; no durable agent-browser Slack session available.',
    next_proof_required: 'Screenshot of api.slack.com/apps showing workspace-installed apps list with last-active dates for all registered bots.',
  },
  task_1778867295122_17178860: {
    blocker_reason: 'PRs #191 (cortextos) and #808 (rgos) opened adding HUB_ORIGIN env var to CORS allowlist; blocked on production deploy step — HUB_ORIGIN must be set in Vercel env before CORS fix is live.',
    next_proof_required: 'curl preflight on https://hub.revopsglobal.com/app/fleet/strategy returning Access-Control-Allow-Origin: https://hub.revopsglobal.com after env var deploy.',
  },
  task_1778898651599_92714091: {
    blocker_reason: 'LinkedIn-Session reports alive=true/last_exec_ok=true but fresh artifact shows Complimentary remap auth gap — session cookie valid but remap path requires re-auth or OAuth refresh.',
    next_proof_required: 'Fresh output/linkedin-check artifact showing alive=true AND complement field non-empty with valid session identity.',
  },
  task_1778838397410_51512040: {
    blocker_reason: 'Blocked on task_1778838986728_60900395 (restore Hub-QA auth); voice Start validation at /app/voice requires authenticated Orgo browser lane which is currently expired.',
    next_proof_required: 'task_1778838986728_60900395 completed AND /app/voice Start button Playwright screenshot showing connection state without redirect to login.',
  },
  task_1778841172658_16688092: {
    blocker_reason: 'Four of five Orgo API lanes returned ECONNREFUSED at 2026-05-15T10:30Z; fleet state shows lanes unreachable and root cause (VM stop/restart vs network) undiagnosed.',
    next_proof_required: 'cortextos bus computer-use ping returning HTTP 200 on all five Orgo fleet lanes with fresh timestamp.',
  },
  task_1778692561317_628: {
    blocker_reason: 'Requires computer-use on Greg Mac to create Telegram bot via BotFather; original provisioning was gated on Mac CU session availability.',
    next_proof_required: 'codex-2 agent running (cortextos status shows running:true), responding to /start on its Telegram bot.',
  },
  task_1778838986728_60900395: {
    blocker_reason: 'Hub-QA Chrome session in Orgo lane expired; continuous Orgo product QA requires durable authenticated session against hub.revopsglobal.com that survives VM restarts.',
    next_proof_required: 'Orgo browser lane returns HTTP 200 on /app/orchestrator with valid auth cookie confirmed via Playwright storageState snapshot.',
  },
  task_1778835317546_63981742: {
    blocker_reason: 'Partial deploy — Supabase edge functions deployed but Greg Mac LaunchAgents step blocked by auth/env issues; agent loops not loading on Mac.',
    next_proof_required: 'launchctl list | grep team-brain returning loaded status AND agent loop confirmed running via process check.',
  },
  task_1778856511142_12368636: {
    blocker_reason: 'Live Ship Verifier found RGOS local edge-function source diverges from deployed source at 2026-05-15T14:47Z; security/2026-05-13 branch not yet merged to main and deployed.',
    next_proof_required: 'supabase functions deploy output showing clean deploy AND drift check returning zero diff between local and deployed source.',
  },
  task_1778871311959_06221323: {
    blocker_reason: 'RGOS agent-browser Hub auth lane (AGENT_BROWSER_SESSION=rgos) regressed at 2026-05-15T18:53Z; session cookie against hub.revopsglobal.com expired, redirecting to login.',
    next_proof_required: 'agent-browser Hub auth returning HTTP 200 on /app/orchestrator without redirect; storageState refreshed and persisted for future runs.',
  },
  task_1778834575189_22695542: {
    blocker_reason: 'Gemini Veo API requires confirmed billing headroom on GCP project revops-global; billing enablement task (RGOS Gemini billing) not yet verified complete.',
    next_proof_required: 'Gemini Veo API call returning HTTP 200 with video generation artifact URL, confirming quota is available.',
  },
  task_1778768411411_82329236: {
    blocker_reason: 'Explicitly gated: must not start until dev wiki-fallback task c515621b lands; premature migration would break skills during the KB re-ingest window.',
    next_proof_required: 'dev wiki-fallback task c515621b status=completed AND confirmed no active KB re-ingest in progress before starting OpenAI text-embedding-3-large migration.',
  },
};

const files = readdirSync(TASK_DIR).filter(f => f.endsWith('.json') && !f.startsWith('.'));
let updated = 0;
let skipped = 0;

for (const file of files) {
  const filePath = join(TASK_DIR, file);
  let task;
  try {
    task = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    continue;
  }

  if (task.status !== 'blocked') continue;

  const context = BLOCKER_MAP[task.id];
  if (!context) {
    console.log(`[backfill-blocker] WARN: no blocker context defined for ${task.id} ("${task.title}") — skipping`);
    skipped++;
    continue;
  }

  // Already populated — skip
  if (task.meta?.blocker?.blocker_reason) {
    console.log(`[backfill-blocker] SKIP: ${task.id} already has meta.blocker`);
    skipped++;
    continue;
  }

  task.meta = task.meta ?? {};
  task.meta.blocker = context;
  task.updated_at = new Date().toISOString();

  atomicWrite(filePath, JSON.stringify(task, null, 2) + '\n');
  console.log(`[backfill-blocker] WROTE: ${task.id} — ${task.title}`);
  updated++;
}

console.log(`[backfill-blocker] Done: ${updated} updated, ${skipped} skipped`);
