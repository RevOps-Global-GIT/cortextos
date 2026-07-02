#!/usr/bin/env node
// vm-disk-watchdog.js — Monitor VM disk space; auto-reclaim if low; alert if stuck.
//
// Mirrors mac-disk-watcher but for the Linux VM (/dev/sda1).
// Below GC_TRIGGER_GB: runs stale-worktree GC + clears regenerable caches.
// Below ALERT_FLOOR_GB after recovery: alerts orchestrator via bus.
// Above GC_TRIGGER_GB: exits silently (healthy).

"use strict";

const { spawnSync } = require("child_process");
const path = require("path");
const os = require("os");

const SCRIPTS_DIR = path.join(__dirname);
const HOME = os.homedir();

// Trigger GC when free drops below this.
const GC_TRIGGER_GB = 20;
// Alert orchestrator if we cannot recover above this floor.
const ALERT_FLOOR_GB = 10;

function run(cmd, opts = {}) {
  const result = spawnSync("bash", ["-c", cmd], {
    encoding: "utf8",
    timeout: 60000,
    ...opts,
  });
  return { ok: result.status === 0, stdout: (result.stdout || "").trim(), stderr: (result.stderr || "").trim() };
}

function getFreeGb() {
  // df -BG outputs e.g. "69G" in the 4th column for /
  const r = run("df -BG / | awk 'NR==2 {gsub(/G/,\"\",$4); print $4}'");
  if (!r.ok || !r.stdout) return null;
  return parseInt(r.stdout, 10);
}

function getUsedPct() {
  const r = run("df / | awk 'NR==2 {gsub(/%/,\"\",$5); print $5}'");
  return r.ok ? parseInt(r.stdout, 10) : null;
}

function clearNpmCache() {
  const r = run("npm cache clean --force 2>/dev/null");
  console.log(`[vm-disk-watchdog] npm cache clean: ${r.ok ? "ok" : "failed"}`);
}

function clearPlaywrightCache() {
  // Remove older playwright browser versions, keeping only the 2 most recent.
  const cacheDir = `${HOME}/.cache/ms-playwright`;
  const r = run(`ls -1dt "${cacheDir}"/*/ 2>/dev/null | tail -n +3`);
  if (!r.ok || !r.stdout) return;
  const old = r.stdout.split("\n").filter(Boolean);
  for (const dir of old) {
    run(`rm -rf "${dir}"`);
    console.log(`[vm-disk-watchdog] Removed stale playwright cache: ${dir}`);
  }
}

function clearUvCache() {
  const uvCache = `${HOME}/.cache/uv`;
  const r = run(`test -d "${uvCache}" && du -sh "${uvCache}" 2>/dev/null | awk '{print $1}'`);
  if (!r.ok) return;
  run(`uv cache clean 2>/dev/null || rm -rf "${uvCache}"`);
  console.log(`[vm-disk-watchdog] Cleared uv cache (was ~${r.stdout})`);
}

function clearTmpScanDirs() {
  // Remove tmp dirs created by codex worktrees/autoresearch older than 3 days.
  const patterns = [
    `/tmp/codex-worktrees`,
    `/tmp/codex-autoresearch-*`,
  ];
  for (const pat of patterns) {
    const r = run(`find ${pat} -maxdepth 0 -mtime +3 2>/dev/null`);
    if (!r.ok || !r.stdout) continue;
    for (const dir of r.stdout.split("\n").filter(Boolean)) {
      const rm = run(`rm -rf "${dir}"`);
      console.log(`[vm-disk-watchdog] Removed stale tmp dir: ${dir} (${rm.ok ? "ok" : "failed"})`);
    }
  }
}

function runWorktreeGc() {
  try {
    const gc = require(path.join(SCRIPTS_DIR, "vm-stale-worktree-gc.js"));
    return gc.main();
  } catch (e) {
    console.log(`[vm-disk-watchdog] worktree GC error: ${e.message}`);
    return { removed: 0, removedMb: 0 };
  }
}

function alertOrchestrator(message) {
  const r = run(`cortextos bus send-message orchestrator high '${message.replace(/'/g, "'\\''")}' 2>/dev/null`);
  if (!r.ok) {
    console.log(`[vm-disk-watchdog] Failed to alert orchestrator: ${r.stderr}`);
  }
}

function main() {
  const freeBefore = getFreeGb();
  const usedPct = getUsedPct();

  if (freeBefore === null) {
    console.log("[vm-disk-watchdog] Could not read disk stats — skipping");
    return;
  }

  console.log(`[vm-disk-watchdog] /dev/sda1: ${freeBefore}GB free (${usedPct}% used)`);

  if (freeBefore > GC_TRIGGER_GB) {
    console.log("[vm-disk-watchdog] OK — above threshold, no action needed");
    return;
  }

  console.log(`[vm-disk-watchdog] WARNING: ${freeBefore}GB free < ${GC_TRIGGER_GB}GB threshold — starting recovery`);

  // Step 1: stale worktree GC
  const gcResult = runWorktreeGc();

  // Step 2: clear regenerable caches
  clearNpmCache();
  clearPlaywrightCache();
  clearUvCache();
  clearTmpScanDirs();

  const freeAfter = getFreeGb();
  const reclaimed = freeAfter !== null ? freeAfter - freeBefore : null;

  console.log(
    `[vm-disk-watchdog] Recovery complete: ${freeBefore}GB → ${freeAfter ?? "?"}GB free` +
    (reclaimed !== null ? ` (+${reclaimed}GB reclaimed)` : "") +
    `, worktrees removed: ${gcResult.removed} (~${gcResult.removedMb}MB)`,
  );

  if (freeAfter !== null && freeAfter <= ALERT_FLOOR_GB) {
    const msg = `VM disk CRITICAL: only ${freeAfter}GB free after auto-GC. Manual cleanup needed. ` +
      `Worktrees removed: ${gcResult.removed}. Check $CTX_WORK_ROOT and ~/.cache.`;
    console.log(`[vm-disk-watchdog] ALERT: ${msg}`);
    alertOrchestrator(msg);
  } else if (freeAfter !== null && freeAfter <= GC_TRIGGER_GB) {
    // Recovered but still below trigger — warn without blocking
    console.log(`[vm-disk-watchdog] Recovered to ${freeAfter}GB but still near threshold — monitoring`);
  } else {
    console.log(`[vm-disk-watchdog] Recovered successfully to ${freeAfter}GB free`);
  }
}

main();
