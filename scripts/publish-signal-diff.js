#!/usr/bin/env node
// Publish the latest Weekly Signal Diff into the AgentOps Inbox.
// The diff itself is generated on Greg's Mac (LaunchAgent, Fridays) and
// committed to the team-brain wiki at wiki/sources/signals/YYYY-MM-DD-weekly-diff.md.
// That machine has no RGOS service key, so publication happens here on the VM:
// pull the wiki, find the newest diff (<= 8 days old), insert into
// agent_briefings unless a row with the same title already exists.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const SECRETS = "/home/cortextos/cortextos/orgs/revops-global/secrets.env";
const WIKI_REPO = "/home/cortextos/work/team-brain";
const SIGNALS_DIR = path.join(WIKI_REPO, "wiki", "sources", "signals");
const MAX_AGE_DAYS = 8;
const TIMEOUT_MS = 15_000;

function readEnvVar(name) {
  const content = fs.readFileSync(SECRETS, "utf8");
  const m = content.match(new RegExp(`^(?:export\\s+)?${name}=(.*)$`, "m"));
  if (!m) throw new Error(`${name} not found in secrets.env`);
  return m[1].trim().replace(/^["']|["']$/g, "");
}

async function rest(url, key, pathAndQuery, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${url}/rest/v1/${pathAndQuery}`, {
      ...init,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
      signal: controller.signal,
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} on ${pathAndQuery} — ${body.slice(0, 300)}`);
    return JSON.parse(body);
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  try {
    execFileSync("git", ["-C", WIKI_REPO, "pull", "--ff-only", "--quiet"], { timeout: 60_000 });
  } catch (err) {
    console.error(`[publish-signal-diff] wiki pull failed (continuing with local copy): ${err.message}`);
  }

  const files = fs
    .readdirSync(SIGNALS_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}-weekly-diff\.md$/.test(f))
    .sort();
  if (files.length === 0) {
    console.log("[publish-signal-diff] no weekly diff files found — nothing to publish");
    return;
  }
  const latest = files[files.length - 1];
  const dateStr = latest.slice(0, 10);
  const ageDays = (Date.now() - new Date(`${dateStr}T00:00:00Z`).getTime()) / 86_400_000;
  if (ageDays > MAX_AGE_DAYS) {
    console.log(`[publish-signal-diff] latest diff ${latest} is ${Math.floor(ageDays)}d old — skipping`);
    return;
  }

  const title = `Weekly Signal Diff — ${dateStr}`;
  const url = readEnvVar("SUPABASE_RGOS_URL");
  const key = readEnvVar("SUPABASE_RGOS_SERVICE_KEY");

  const existing = await rest(url, key, `agent_briefings?select=id&title=eq.${encodeURIComponent(title)}&limit=1`);
  if (existing.length > 0) {
    console.log(`[publish-signal-diff] "${title}" already published (id=${existing[0].id}) — skipping`);
    return;
  }

  let content = fs.readFileSync(path.join(SIGNALS_DIR, latest), "utf8").trim();
  // Strip wiki frontmatter; the Inbox renders plain markdown.
  content = content.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
  if (!content) throw new Error(`${latest} is empty after frontmatter strip`);

  const rows = await rest(url, key, "agent_briefings", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      briefing_type: "weekly_signal_diff",
      title,
      content,
      source_agent: "analyst",
      metadata: { wiki_path: `wiki/sources/signals/${latest}` },
    }),
  });
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("insert returned no rows");
  console.log(`[publish-signal-diff] published "${title}" id=${rows[0].id}`);
}

main().catch((err) => {
  console.error(`[publish-signal-diff] error: ${err.message}`);
  process.exit(1);
});
