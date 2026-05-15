#!/usr/bin/env node
/**
 * cortextos-mac-task-sync.js
 *
 * Push VM task files → Mac local task store via rsync over SSH.
 * Complements cortextos-vm-sync-push.js (which pushes to Supabase/RGOS).
 *
 * Syncs:
 *   VM: ~/.cortextos/<instance>/orgs/<org>/tasks/
 *   → Mac: ~/.cortextos/<instance>/orgs/<org>/tasks/
 *
 * Also syncs audit/ and archive/ subdirs so Mac CLI reads correct history.
 * Uses --update (skip files newer on Mac) so Mac-local task edits are preserved.
 *
 * Usage:
 *   node scripts/cortextos-mac-task-sync.js [--dry-run] [--org <org>]
 *
 * Requires: ssh key access to gregs-mac (Tailscale 100.84.86.6).
 * MAC_SSH_HOST defaults to env MAC_SSH_HOST or "gregs-mac".
 */

"use strict";

const { execSync, spawnSync } = require("child_process");
const { existsSync } = require("fs");
const path = require("path");
const os = require("os");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const orgIdx = args.indexOf("--org");
const ORG = orgIdx !== -1 ? args[orgIdx + 1] : (process.env.CTX_ORG || "revops-global");
const INSTANCE_ID = process.env.CTX_INSTANCE_ID || "cortextos1";
const MAC_SSH_HOST = process.env.MAC_SSH_HOST || "gregs-mac";
const CTX_ROOT = path.join(os.homedir(), ".cortextos", INSTANCE_ID);

const SYNC_DIRS = [
  `orgs/${ORG}/tasks`,
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function log(msg) {
  process.stdout.write(`[mac-task-sync] ${msg}\n`);
}

function rsync(srcDir, destHost, destDir, dryRunFlag) {
  const flags = [
    "-az",          // archive + compress
    "--update",     // skip files newer on receiver (preserve Mac-local edits)
    "--chmod=F644,D755", // fix permissions on arrival
  ];
  if (dryRunFlag) flags.push("--dry-run", "--stats");

  const src = `${srcDir}/`;
  const dest = `${destHost}:${destDir}/`;
  const cmd = ["rsync", ...flags, src, dest];

  log(`rsync ${src} → ${dest}${dryRunFlag ? " [DRY RUN]" : ""}`);
  const result = spawnSync(cmd[0], cmd.slice(1), { stdio: "pipe", encoding: "utf-8" });

  if (result.status !== 0) {
    const err = result.stderr?.trim() || result.error?.message || "unknown error";
    // ENOENT on src dir is not fatal — dir may not exist yet for this org
    if (err.includes("No such file") || err.includes("does not exist")) {
      log(`  skip: source dir not found (${srcDir})`);
      return { skipped: true };
    }
    log(`  ERROR: ${err}`);
    return { error: err };
  }

  const stdout = result.stdout?.trim();
  if (stdout) log(`  ${stdout.split("\n").slice(0, 3).join("\n  ")}`);
  return { ok: true };
}

// Ensure dest dir exists on Mac
function ensureMacDir(host, dir) {
  spawnSync("ssh", [host, `mkdir -p ${dir}`], { stdio: "pipe" });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
log(`Syncing ${ORG} task dirs from VM → ${MAC_SSH_HOST}${dryRun ? " [DRY RUN]" : ""}`);

let synced = 0;
let errors = 0;

for (const rel of SYNC_DIRS) {
  const srcDir = path.join(CTX_ROOT, rel);
  const destDir = path.join("~/.cortextos", INSTANCE_ID, rel);

  if (!existsSync(srcDir)) {
    log(`  skip: ${srcDir} not found locally`);
    continue;
  }

  if (!dryRun) ensureMacDir(MAC_SSH_HOST, destDir);

  const result = rsync(srcDir, MAC_SSH_HOST, destDir, dryRun);
  if (result.ok || result.skipped) synced++;
  else errors++;
}

// Also sync audit + archive subdirs if they exist
for (const sub of ["audit", "archive"]) {
  const srcDir = path.join(CTX_ROOT, `orgs/${ORG}/tasks`, sub);
  const destDir = path.join("~/.cortextos", INSTANCE_ID, `orgs/${ORG}/tasks`, sub);
  if (!existsSync(srcDir)) continue;
  if (!dryRun) ensureMacDir(MAC_SSH_HOST, destDir);
  const result = rsync(srcDir, MAC_SSH_HOST, destDir, dryRun);
  if (result.ok || result.skipped) synced++;
  else errors++;
}

log(`Done: ${synced} dirs synced, ${errors} errors${dryRun ? " [DRY RUN]" : ""}`);
if (errors > 0) process.exit(1);
