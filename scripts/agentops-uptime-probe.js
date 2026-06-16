#!/usr/bin/env node
// AgentOps uptime probe (2026-06-16).
// Probes agentops.revopsglobal.com; after 3 consecutive failures sends ONE
// high-priority bus alert to orchestrator, then stays silent until recovery
// (which sends one all-clear). Healthy = an HTTP response in [200,399] within
// the timeout. 4xx / 5xx / network error / timeout = failure.
//
// Why stricter than the supabase detector's "<500 = up": agentops is a Vercel
// deployment, so a removed/misrouted deployment returns 404 — which must count
// as DOWN. The healthy root returns 200 (app/auth page) or a 3xx auth bounce,
// so [200,399]=up has no false positives in practice.
//
// Context: 2026-06-16 Greg reported agentops.revopsglobal.com down at 00:24 PT
// and it self-healed before triage — there was no automated detector, so the
// outage only surfaced because a human noticed. This probe closes that gap.
// Alerts route to orchestrator (comms funnel), never directly to the user.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const TARGET_URL = process.env.AGENTOPS_PROBE_URL || "https://agentops.revopsglobal.com";
const STATE_DIR = path.join(process.env.HOME || "/home/cortextos", ".cortextos");
const STATE_FILE = path.join(STATE_DIR, "agentops-uptime-probe.json");
const FAILURE_THRESHOLD = 3;
const TIMEOUT_MS = 12_000;

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

async function probe(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { redirect: "follow", signal: controller.signal });
    return { ok: res.status >= 200 && res.status < 400, status: res.status };
  } catch (err) {
    return { ok: false, status: `network/${err.name}` };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const state = loadState();
  const result = await probe(TARGET_URL);
  const now = new Date().toISOString();

  if (result.ok) {
    if (state.alerted) {
      sendBus(
        "normal",
        `AgentOps uptime probe: RECOVERED — ${TARGET_URL} returned ${result.status} at ${now} after ${state.consecutiveFailures} consecutive failures.`,
      );
    }
    saveState({ consecutiveFailures: 0, alerted: false, lastStatus: result.status, lastCheckAt: now });
    console.log(`[agentops-uptime-probe] up (${result.status})`);
    return;
  }

  const failures = state.consecutiveFailures + 1;
  let alerted = state.alerted;
  if (failures >= FAILURE_THRESHOLD && !alerted) {
    sendBus(
      "high",
      `AgentOps uptime probe: ${failures} consecutive failures probing ${TARGET_URL} (latest: ${result.status} at ${now}). The AgentOps dashboard is likely unreachable for the user. Check the Vercel deployment state for the ob1-app/agentops project (READY?) and DNS, then surface to Greg via the funnel if confirmed down.`,
    );
    alerted = true;
  }
  saveState({ consecutiveFailures: failures, alerted, lastStatus: result.status, lastCheckAt: now });
  console.log(`[agentops-uptime-probe] FAIL ${failures}/${FAILURE_THRESHOLD} (${result.status}) alerted=${alerted}`);
}

main().catch((err) => {
  console.error(`[agentops-uptime-probe] error: ${err.message}`);
  process.exit(1);
});
