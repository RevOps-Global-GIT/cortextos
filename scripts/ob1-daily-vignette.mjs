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
import { hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const REPO_ROOT = process.env.CTX_FRAMEWORK_ROOT || path.resolve(__dirname, "..");
const WORK_ROOT = process.env.CTX_WORK_ROOT || path.resolve(REPO_ROOT, "../work");
const OB1_APP = process.env.OB1_APP_ROOT || path.join(WORK_ROOT, "ob1-app");
const SECRETS_ENV = path.join(REPO_ROOT, "orgs/revops-global/secrets.env");
const DEFAULT_ALERT_ENV = path.join(REPO_ROOT, "orgs/revops-global/agents/orchestrator/.env");
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

function findAlertEnv() {
  const override = process.env.CORTEXTOS_ALERT_BOT_ENV;
  if (override && existsSync(override)) return override;

  const contextPath = path.join(__dirname, "../orgs/revops-global/context.json");
  if (existsSync(contextPath)) {
    try {
      const context = JSON.parse(readFileSync(contextPath, "utf8"));
      const orchestrator = context.orchestrator;
      if (orchestrator) {
        const candidate = path.join(__dirname, "../orgs/revops-global/agents", orchestrator, ".env");
        if (existsSync(candidate)) return candidate;
      }
    } catch (err) {
      log(`WARN: could not parse alert context: ${err.message}`);
    }
  }

  return existsSync(DEFAULT_ALERT_ENV) ? DEFAULT_ALERT_ENV : null;
}

function firstNonEmpty(...values) {
  return values.find((value) => typeof value === "string" && value.trim().length > 0);
}

function sendFailureAlert(detail) {
  const alertEnvPath = findAlertEnv();
  const alertEnv = alertEnvPath ? parseEnvFile(alertEnvPath) : {};
  const token = firstNonEmpty(env.OB1_DAILY_VIGNETTE_ALERT_BOT_TOKEN, env.BOT_TOKEN, alertEnv.BOT_TOKEN);
  const chatId = firstNonEmpty(env.OB1_DAILY_VIGNETTE_ALERT_CHAT_ID, env.CHAT_ID, alertEnv.CHAT_ID);

  if (!token || !chatId) {
    log("WARN: vignette failed, but no Telegram alert token/chat id was found.");
    return;
  }

  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  const text = [
    "OB1 Daily Vignette failed on VM.",
    `Date: ${today}`,
    `Host: ${hostname()}`,
    detail,
  ].join("\n");

  if (env.OB1_DAILY_VIGNETTE_ALERT_DRY_RUN === "1") {
    log(`DRY RUN alert: ${text.replaceAll("\n", " | ")}`);
    return;
  }

  const result = spawnSync("curl", [
    "-sS",
    "--max-time",
    "10",
    `https://api.telegram.org/bot${token}/sendMessage`,
    "-H",
    "Content-Type: application/json",
    "-d",
    JSON.stringify({ chat_id: chatId, text }),
  ], { stdio: "pipe", env });

  const body = result.stdout?.toString("utf8") ?? "";
  if (result.status !== 0) {
    log(`WARN: Telegram alert failed with status ${result.status ?? "unknown"}.`);
  } else if (!body.includes('"ok":true')) {
    log("WARN: Telegram alert request completed, but Telegram did not return ok=true.");
  } else {
    log("Telegram failure alert sent.");
  }
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
    const status = result.status ?? 1;
    const reason = result.error ? result.error.message : `exit status ${status}`;
    sendFailureAlert(`Failed command: ${cmd} ${args.join(" ")} (${reason})`);
    process.exit(status);
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
