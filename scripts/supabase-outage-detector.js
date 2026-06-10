#!/usr/bin/env node
// Supabase outage detector (Theta proposal 2026-06-10, P2).
// Probes the RGOS Supabase REST endpoint; after 3 consecutive failures sends
// ONE high-priority bus alert to orchestrator, then stays silent until
// recovery (which sends one all-clear). 5xx / network error / timeout =
// failure; any <500 response (incl. 401/404) means the service is up.
// Context: 2026-06-10 REST 522 outage went undetected until fleet health
// misreported 0 agents while 7 were heartbeating.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const SECRETS = "/home/cortextos/cortextos/orgs/revops-global/secrets.env";
const STATE_DIR = path.join(process.env.HOME || "/home/cortextos", ".cortextos");
const STATE_FILE = path.join(STATE_DIR, "supabase-outage-detector.json");
const FAILURE_THRESHOLD = 3;
const TIMEOUT_MS = 10_000;

function readEnvVar(name) {
  const content = fs.readFileSync(SECRETS, "utf8");
  const m = content.match(new RegExp(`^(?:export\\s+)?${name}=(.*)$`, "m"));
  if (!m) throw new Error(`${name} not found in secrets.env`);
  return m[1].trim().replace(/^["']|["']$/g, "");
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { consecutiveFailures: 0, alerted: false };
  }
}

function saveState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function sendBus(priority, message) {
  execFileSync(
    "cortextos",
    ["bus", "send-message", "orchestrator", priority, message],
    { stdio: "inherit", timeout: 30_000 },
  );
}

async function probe(url, key) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${url}/rest/v1/`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    return { ok: res.status < 500, status: res.status };
  } catch (err) {
    return { ok: false, status: `network/${err.name}` };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const url = readEnvVar("SUPABASE_RGOS_URL");
  const key = readEnvVar("SUPABASE_RGOS_SERVICE_KEY");
  const state = loadState();
  const result = await probe(url, key);
  const now = new Date().toISOString();

  if (result.ok) {
    if (state.alerted) {
      sendBus(
        "normal",
        `Supabase outage detector: RECOVERED — REST probe returned ${result.status} at ${now} after ${state.consecutiveFailures} consecutive failures.`,
      );
    }
    saveState({ consecutiveFailures: 0, alerted: false, lastStatus: result.status, lastCheckAt: now });
    console.log(`[supabase-outage-detector] up (${result.status})`);
    return;
  }

  const failures = state.consecutiveFailures + 1;
  let alerted = state.alerted;
  if (failures >= FAILURE_THRESHOLD && !alerted) {
    sendBus(
      "high",
      `Supabase outage detector: ${failures} consecutive REST probe failures (latest: ${result.status} at ${now}, endpoint ${url}/rest/v1/). Fleet surfaces reading Supabase (fleet health, kanban, theta) are unreliable until recovery. Playbook: reference_supabase_project_hang_playbook.`,
    );
    alerted = true;
  }
  saveState({ consecutiveFailures: failures, alerted, lastStatus: result.status, lastCheckAt: now });
  console.log(`[supabase-outage-detector] FAIL ${failures}/${FAILURE_THRESHOLD} (${result.status}) alerted=${alerted}`);
}

main().catch((err) => {
  console.error(`[supabase-outage-detector] error: ${err.message}`);
  process.exit(1);
});
