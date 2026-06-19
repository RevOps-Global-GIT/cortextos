#!/usr/bin/env node
/**
 * cortextos-dist-rebuild.js
 *
 * Detects when dist/cli.js is stale (src/ files newer) and rebuilds.
 * Run as a cron to keep the compiled dist current after PRs merge to fork/main.
 *
 * Staleness check: compare mtime of dist/cli.js against the latest mtime of
 * any .ts file under src/. If src is newer, rebuild.
 *
 * Exit 0 in all cases (log errors but don't crash the cron).
 */

"use strict";

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.join(__dirname, "..");
const DIST_CLI = path.join(REPO_ROOT, "dist", "cli.js");
const SRC_DIR = path.join(REPO_ROOT, "src");

function latestSrcMtime() {
  let latest = 0;
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".ts")) {
        try {
          const mtime = fs.statSync(full).mtimeMs;
          if (mtime > latest) latest = mtime;
        } catch { /* ignore */ }
      }
    }
  }
  walk(SRC_DIR);
  return latest;
}

function distMtime() {
  try { return fs.statSync(DIST_CLI).mtimeMs; } catch { return 0; }
}

function main() {
  const srcMtime = latestSrcMtime();
  const dstMtime = distMtime();

  if (srcMtime === 0) {
    console.log("[dist-rebuild] src/ not found — skipping");
    return;
  }

  if (dstMtime >= srcMtime) {
    console.log("[dist-rebuild] dist is current — no rebuild needed");
    return;
  }

  const ageSec = Math.round((srcMtime - dstMtime) / 1000);
  console.log(`[dist-rebuild] dist is stale by ${ageSec}s — rebuilding`);

  try {
    execSync("npm run build", {
      cwd: REPO_ROOT,
      stdio: "pipe",
      timeout: 120_000,
    });
    console.log("[dist-rebuild] rebuild complete");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[dist-rebuild] build failed: ${msg}`);
  }
}

main();
