#!/usr/bin/env node
/**
 * ob1-daily-vignette.mjs
 *
 * VM daemon cron runner for the OB1 daily vignette.
 * Replaces the GHA daily-vignette.yml schedule trigger.
 *
 * Runs generate-daily-vignette.mjs from the ob1-app checkout,
 * validates the output, then commits and pushes to origin main.
 *
 * Scheduled at 06:33 America/Los_Angeles via daemon cron.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const OB1_APP = "/home/cortextos/ob1-app";
const SECRETS_ENV = path.join(__dirname, "../orgs/revops-global/secrets.env");
const OB1_ENV = path.join(OB1_APP, ".env.local");

function log(msg) {
  console.log(`[ob1-daily-vignette] ${msg}`);
}

function parseEnvFile(filePath) {
  if (!existsSync(filePath)) return {};
  const lines = readFileSync(filePath, "utf8").split("\n");
  const result = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    result[key] = val;
  }
  return result;
}

function run(cmd, args, opts = {}) {
  log(`${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, {
    cwd: OB1_APP,
    stdio: "inherit",
    env: opts.env ?? process.env,
    ...opts,
  });
  if (result.status !== 0) {
    log(`ERROR: ${cmd} exited with status ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

// ── Build env ────────────────────────────────────────────────────────────────
const env = {
  ...process.env,
  ...parseEnvFile(SECRETS_ENV),
  ...parseEnvFile(OB1_ENV),
  // Ensure uv is on PATH
  PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}`,
};

log(`Starting at ${new Date().toISOString()}`);
log(`ob1-app: ${OB1_APP}`);

// ── Ensure main branch ───────────────────────────────────────────────────────
run("git", ["fetch", "origin", "main", "--quiet"], { env });
run("git", ["checkout", "main"], { env });
run("git", ["reset", "--hard", "origin/main"], { env });

// ── Generate ─────────────────────────────────────────────────────────────────
run("node", ["scripts/generate-daily-vignette.mjs"], { env });

// ── Validate ─────────────────────────────────────────────────────────────────
run("node", ["scripts/validate-vignette.mjs"], { env });
run("node", ["scripts/verify-vignette-hero-assets.mjs"], { env });

// ── Commit & push ─────────────────────────────────────────────────────────────
const gitEnv = {
  ...env,
  GIT_AUTHOR_NAME: "revopsglobal",
  GIT_AUTHOR_EMAIL: "106196448+revopsglobal@users.noreply.github.com",
  GIT_COMMITTER_NAME: "revopsglobal",
  GIT_COMMITTER_EMAIL: "106196448+revopsglobal@users.noreply.github.com",
};

run("git", ["config", "user.name", "revopsglobal"], { env });
run("git", ["config", "user.email", "106196448+revopsglobal@users.noreply.github.com"], { env });
run("git", ["add", "-f", "public/vignettes/"], { env });

// Check if there is anything to commit
const diff = spawnSync("git", ["diff", "--staged", "--quiet"], { cwd: OB1_APP, env });
if (diff.status === 0) {
  log("No new vignette files; nothing to commit.");
  process.exit(0);
}

const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
run("git", ["commit", "-m", `chore(vignette): ${today} daily render (vm-cron)`], { env: gitEnv });
run("git", ["push", "origin", "HEAD:main"], { env });

log(`Done — ${today} vignette committed and pushed.`);
