#!/usr/bin/env node
// Publish an agent briefing into the AgentOps Inbox (/app/work/inbox).
// Inserts a row into the RGOS agent_briefings table (service-role only —
// the table has no INSERT policy by design). Additive to Slack/Telegram
// delivery; never replaces it.
//
// Usage:
//   node scripts/publish-briefing.js --type morning_brief --title "Morning Brief — Jun 12, 2026" \
//     --file output/2026-06-12-morning-brief.md [--source-agent analyst]

const fs = require("fs");

const SECRETS = "/home/cortextos/cortextos/orgs/revops-global/secrets.env";
const TIMEOUT_MS = 15_000;

function readEnvVar(name) {
  const content = fs.readFileSync(SECRETS, "utf8");
  const m = content.match(new RegExp(`^(?:export\\s+)?${name}=(.*)$`, "m"));
  if (!m) throw new Error(`${name} not found in secrets.env`);
  return m[1].trim().replace(/^["']|["']$/g, "");
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key.startsWith("--") || value === undefined) {
      throw new Error(`Bad argument pair: ${key} ${value ?? ""}`);
    }
    args[key.slice(2)] = value;
  }
  for (const required of ["type", "title", "file"]) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const content = fs.readFileSync(args.file, "utf8").trim();
  if (!content) throw new Error(`${args.file} is empty`);

  const url = readEnvVar("SUPABASE_RGOS_URL");
  const key = readEnvVar("SUPABASE_RGOS_SERVICE_KEY");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${url}/rest/v1/agent_briefings`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        briefing_type: args.type,
        title: args.title,
        content,
        source_agent: args["source-agent"] ?? null,
      }),
      signal: controller.signal,
    });
    const body = await res.text();
    if (!res.ok) {
      throw new Error(`insert failed: HTTP ${res.status} — ${body.slice(0, 300)}`);
    }
    const rows = JSON.parse(body);
    // PostgREST can 2xx with zero rows when policies filter the write.
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error(`insert returned no rows — ${body.slice(0, 300)}`);
    }
    console.log(`[publish-briefing] published ${args.type} "${args.title}" id=${rows[0].id}`);
  } finally {
    clearTimeout(timer);
  }
}

main().catch((err) => {
  console.error(`[publish-briefing] error: ${err.message}`);
  process.exit(1);
});
