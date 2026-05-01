#!/usr/bin/env node
/**
 * check-migration-drift.js
 *
 * Detects Supabase migration drift: SQL files committed to the repo that have
 * not been applied to the live database.
 *
 * Root cause prevention for incidents like the PR #40 orch_events constraint
 * gap, where a migration existed in git but was never applied to prod Supabase,
 * causing 400 errors in bus-mirror until manually discovered.
 *
 * Usage:
 *   node scripts/check-migration-drift.js [--migrations-dir <path>] [--json] [--ci]
 *
 * Flags:
 *   --migrations-dir <path>  Path to supabase/migrations/ dir (default: auto-detect)
 *   --json                   Output machine-readable JSON instead of human-readable text
 *   --ci                     Exit code 1 if any unapplied migrations found (for CI gates)
 *
 * Required env vars (loaded from secrets.env if not already set):
 *   SUPABASE_MANAGEMENT_KEY  Supabase Management API personal access token
 *   SUPABASE_RGOS_URL        Supabase project URL (used to extract project ID)
 *
 * The Supabase Management API is used (not PostgREST) because the
 * supabase_migrations schema is not exposed via the public PostgREST endpoint.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");

// ── Config ────────────────────────────────────────────────────────────────────

const REPO_ROOT = path.resolve(__dirname, "..");
const RGOS_ROOT = path.resolve(REPO_ROOT, "..", "rgos");

// Default migrations directory — the RGOS repo next to cortextos
const DEFAULT_MIGRATIONS_DIR = path.join(RGOS_ROOT, "supabase", "migrations");

// Secrets file — load env vars if not already present
const SECRETS_FILE = path.resolve(
  REPO_ROOT,
  "orgs",
  "revops-global",
  "secrets.env"
);

// ── Arg parsing ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let migrationsDir = DEFAULT_MIGRATIONS_DIR;
let jsonOutput = false;
let ciMode = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--migrations-dir" && args[i + 1]) {
    migrationsDir = path.resolve(args[++i]);
  } else if (args[i] === "--json") {
    jsonOutput = true;
  } else if (args[i] === "--ci") {
    ciMode = true;
  } else if (args[i] === "--help" || args[i] === "-h") {
    console.log(
      "Usage: node check-migration-drift.js [--migrations-dir <path>] [--json] [--ci]"
    );
    process.exit(0);
  }
}

// ── Load secrets ──────────────────────────────────────────────────────────────

function loadSecretsFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (key && !(key in process.env)) {
      process.env[key] = val;
    }
  }
}

loadSecretsFile(SECRETS_FILE);

const MANAGEMENT_KEY = process.env.SUPABASE_MANAGEMENT_KEY;
const SUPABASE_URL = process.env.SUPABASE_RGOS_URL || process.env.SUPABASE_URL;

if (!MANAGEMENT_KEY) {
  fatal("SUPABASE_MANAGEMENT_KEY not set. Add it to secrets.env.");
}
if (!SUPABASE_URL) {
  fatal("SUPABASE_RGOS_URL not set. Add it to secrets.env.");
}

// Extract project ID from URL: https://<project_id>.supabase.co
const projectIdMatch = SUPABASE_URL.match(/https:\/\/([^.]+)\.supabase\.co/);
if (!projectIdMatch) {
  fatal(`Cannot extract project ID from SUPABASE_RGOS_URL: ${SUPABASE_URL}`);
}
const PROJECT_ID = projectIdMatch[1];

// ── Local migrations ──────────────────────────────────────────────────────────

function getLocalMigrations(dir) {
  if (!fs.existsSync(dir)) {
    fatal(`Migrations directory not found: ${dir}`);
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql"));
  const migrations = [];
  for (const file of files) {
    // Filename format: <14-digit-timestamp>_<description>.sql
    const match = file.match(/^(\d{14})/);
    if (!match) continue; // skip non-timestamped files
    migrations.push({ version: match[1], file });
  }
  // Sort by version ascending, deduplicate by version
  migrations.sort((a, b) => a.version.localeCompare(b.version));
  // Deduplicate: if multiple files share the same version prefix, keep all (report as multiple)
  return migrations;
}

// ── Supabase Management API query ─────────────────────────────────────────────

function httpsPost(url, headers, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        ...headers,
      },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`JSON parse error: ${data.slice(0, 200)}`));
          }
        } else {
          reject(
            new Error(
              `HTTP ${res.statusCode}: ${data.slice(0, 300)}`
            )
          );
        }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function getAppliedMigrations(projectId, managementKey) {
  const url = `https://api.supabase.com/v1/projects/${projectId}/database/query`;
  const body = JSON.stringify({
    query:
      "SELECT version FROM supabase_migrations.schema_migrations ORDER BY version ASC",
  });
  const result = await httpsPost(
    url,
    { Authorization: `Bearer ${managementKey}` },
    body
  );
  // Result is an array of { version: string }
  if (!Array.isArray(result)) {
    throw new Error(
      `Unexpected response shape: ${JSON.stringify(result).slice(0, 200)}`
    );
  }
  return result.map((r) => r.version);
}

// ── Diff logic ────────────────────────────────────────────────────────────────

function computeDrift(localMigrations, appliedVersions) {
  const appliedSet = new Set(appliedVersions);
  const localVersionSet = new Set(localMigrations.map((m) => m.version));

  const unapplied = localMigrations.filter((m) => !appliedSet.has(m.version));
  const phantoms = appliedVersions.filter((v) => !localVersionSet.has(v));

  return { unapplied, phantoms };
}

// ── Output ────────────────────────────────────────────────────────────────────

function formatDriftReport(local, applied, drift, migrationsDir) {
  const { unapplied, phantoms } = drift;
  const timestamp = new Date().toISOString();
  const ok = unapplied.length === 0;

  if (jsonOutput) {
    console.log(
      JSON.stringify(
        {
          timestamp,
          project_id: PROJECT_ID,
          migrations_dir: migrationsDir,
          local_count: local.length,
          applied_count: applied.length,
          unapplied_count: unapplied.length,
          phantom_count: phantoms.length,
          ok,
          unapplied: unapplied.map((m) => ({ version: m.version, file: m.file })),
          phantoms,
        },
        null,
        2
      )
    );
    return;
  }

  console.log(`\n[migration-drift] ${timestamp}`);
  console.log(`  Project:   ${PROJECT_ID}`);
  console.log(`  Migrations dir: ${migrationsDir}`);
  console.log(`  Local files: ${local.length}`);
  console.log(`  Applied in DB: ${applied.length}`);
  console.log(``);

  if (ok) {
    console.log(`  ✓ No drift detected — all local migrations are applied.`);
  } else {
    console.log(
      `  ✗ DRIFT DETECTED: ${unapplied.length} migration(s) in git but NOT applied to DB`
    );
    console.log(``);
    console.log(`  Unapplied migrations (oldest first):`);
    for (const m of unapplied) {
      console.log(`    ${m.version}  ${m.file}`);
    }
  }

  if (phantoms.length > 0) {
    console.log(``);
    console.log(
      `  ⚠ ${phantoms.length} version(s) applied in DB but not found in local git:`
    );
    for (const v of phantoms) {
      console.log(`    ${v}`);
    }
    console.log(
      `    (These may have been applied directly via Supabase Studio or deleted from git)`
    );
  }

  console.log(``);
}

function fatal(msg) {
  console.error(`[migration-drift] ERROR: ${msg}`);
  process.exit(2);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  let local, applied, drift;

  try {
    local = getLocalMigrations(migrationsDir);
  } catch (err) {
    fatal(`Failed to read local migrations: ${err.message}`);
  }

  try {
    applied = await getAppliedMigrations(PROJECT_ID, MANAGEMENT_KEY);
  } catch (err) {
    fatal(`Failed to query Supabase: ${err.message}`);
  }

  drift = computeDrift(local, applied);
  formatDriftReport(local, applied, drift, migrationsDir);

  if (ciMode && drift.unapplied.length > 0) {
    process.exit(1);
  }
}

main().catch((err) => fatal(err.message));
