#!/usr/bin/env node
// vm-stale-worktree-gc.js — GC stale git worktrees under /home/cortextos/work/
//
// Removes worktrees whose branch is MERGED to the remote default branch AND
// whose working tree is clean. NEVER uses --force (that is the critical guard
// that preserved in-progress work in the 2026-06-06 disk-full incident).
//
// After removal, prunes each primary repo's dangling refs.
// Skips: primary checkouts, cortextos-qa, locked worktrees.

"use strict";

const { execSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const HOME = "/home/cortextos";

// Primary trees that must never be touched.
const PROTECTED_PATHS = new Set([
  `${HOME}/cortextos`,
  `${HOME}/cortextos-qa`,
  `${HOME}/ob1-app`,
  `${HOME}/ob1-parents`,
  `${HOME}/rgos`,
  `${HOME}/cortextos/orgs/revops-global/agents/dev/workers/w-dreams-enhance`,
]);

// Paths containing worktrees to GC (additional to what the primary repos know about).
const GC_ROOTS = [
  `${HOME}/work`,
  `/tmp/codex-worktrees`,
];

// Primary repos whose worktree registries we prune at the end.
const PRIMARY_REPOS = [
  `${HOME}/cortextos`,
  `${HOME}/ob1-app`,
  `${HOME}/ob1-parents`,
  `${HOME}/rgos`,
];

function run(cmd, opts = {}) {
  const result = spawnSync("bash", ["-c", cmd], {
    encoding: "utf8",
    timeout: 30000,
    ...opts,
  });
  return { ok: result.status === 0, stdout: (result.stdout || "").trim(), stderr: (result.stderr || "").trim() };
}

function diskUsageMb(dir) {
  const r = run(`du -sm "${dir}" 2>/dev/null | awk '{print $1}'`);
  return r.ok ? parseInt(r.stdout, 10) || 0 : 0;
}

function isProtected(p) {
  const abs = path.resolve(p);
  if (PROTECTED_PATHS.has(abs)) return true;
  // Skip .claude/worktrees — Claude Code manages those
  if (abs.includes("/.claude/worktrees/")) return true;
  // Skip codex/work nested directories
  if (abs.includes("/agents/codex/work/")) return true;
  return false;
}

function isMerged(worktreePath) {
  // Try each candidate remote/branch target in order.
  for (const target of ["refs/remotes/origin/main", "refs/remotes/fork/main", "refs/remotes/origin/master"]) {
    const check = run(`git -C "${worktreePath}" rev-parse --verify "${target}" 2>/dev/null`);
    if (!check.ok) continue;
    // merge-base --is-ancestor exits 0 if HEAD is an ancestor of target (i.e., merged).
    const merged = run(`git -C "${worktreePath}" merge-base --is-ancestor HEAD "${target}" 2>/dev/null`);
    if (merged.ok) return true;
  }
  return false;
}

// Standalone clones (e.g. work/team-brain) have a .git DIRECTORY; linked
// worktrees have a .git FILE pointing at the primary repo. Only linked
// worktrees are GC candidates — `git worktree remove` on a standalone clone is
// meaningless, and the bogus attempt risks data loss if the removal path ever
// changes.
function isLinkedWorktree(p) {
  try {
    return fs.lstatSync(path.join(p, ".git")).isFile();
  } catch {
    return false;
  }
}

function isClean(worktreePath) {
  const r = run(`git -C "${worktreePath}" status --porcelain 2>/dev/null`);
  return r.ok && r.stdout === "";
}

// Parse `git worktree list --porcelain` output into [{path, head, branch, locked}]
function listWorktrees(primaryRepo) {
  const r = run(`git -C "${primaryRepo}" worktree list --porcelain 2>/dev/null`);
  if (!r.ok || !r.stdout) return [];
  const entries = [];
  let cur = {};
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (cur.path) entries.push(cur);
      cur = { path: line.slice("worktree ".length).trim(), locked: false };
    } else if (line.startsWith("branch ")) {
      cur.branch = line.slice("branch ".length).trim();
    } else if (line === "locked" || line.startsWith("locked ")) {
      cur.locked = true;
    } else if (line === "") {
      if (cur.path) { entries.push(cur); cur = {}; }
    }
  }
  if (cur.path) entries.push(cur);
  return entries;
}

function removeWorktree(primaryRepo, worktreePath) {
  // NEVER use --force. If the tree is dirty or locked, this will fail safely.
  const r = run(`git -C "${primaryRepo}" worktree remove "${worktreePath}" 2>&1`);
  return r;
}

function main() {
  const startedAt = new Date().toISOString();
  let removed = 0;
  let skippedDirty = 0;
  let skippedUnmerged = 0;
  let skippedProtected = 0;
  let removedMb = 0;
  const errors = [];

  console.log(`[vm-stale-worktree-gc] Starting at ${startedAt}`);

  // Collect (primaryRepo, worktreePath) pairs from each primary repo's registry.
  const seen = new Set();
  const candidates = [];

  for (const primary of PRIMARY_REPOS) {
    if (!fs.existsSync(primary)) continue;
    const worktrees = listWorktrees(primary);
    for (const wt of worktrees) {
      if (!wt.path || seen.has(wt.path)) continue;
      seen.add(wt.path);
      // Only process worktrees under GC roots.
      const inGcRoot = GC_ROOTS.some((root) => wt.path.startsWith(root + "/") || wt.path === root);
      if (!inGcRoot) continue;
      candidates.push({ primary, ...wt });
    }
  }

  // Also scan GC roots directly for orphaned worktrees the registry may not know about.
  // Those will fail `git -C` cleanly, so no harm.
  for (const root of GC_ROOTS) {
    if (!fs.existsSync(root)) continue;
    let entries;
    try { entries = fs.readdirSync(root); } catch { continue; }
    for (const entry of entries) {
      const p = path.join(root, entry);
      if (seen.has(p)) continue;
      seen.add(p);
      if (!isLinkedWorktree(p)) continue;
      // Need to identify the owning primary repo.
      // Use `git -C <path> rev-parse --git-common-dir` to find the common git dir.
      const r = run(`git -C "${p}" rev-parse --git-common-dir 2>/dev/null`);
      if (!r.ok) continue;
      // common-dir is e.g. /home/cortextos/cortextos/.git
      const commonDir = r.stdout;
      const ownerGitDir = path.dirname(commonDir.endsWith("/.git") ? commonDir : commonDir + "/x");
      const primary = PRIMARY_REPOS.find((pr) => path.resolve(`${pr}/.git`) === path.resolve(commonDir));
      candidates.push({ primary: primary || ownerGitDir, path: p, locked: false });
    }
  }

  console.log(`[vm-stale-worktree-gc] ${candidates.length} candidate(s) to evaluate`);

  for (const wt of candidates) {
    const wtPath = wt.path;

    if (isProtected(wtPath)) {
      skippedProtected++;
      continue;
    }

    if (wt.locked) {
      // Locked = in-use by Claude Code agent session, never touch.
      skippedProtected++;
      continue;
    }

    if (!fs.existsSync(wtPath)) {
      // Already removed externally; prune will clean up the ref.
      continue;
    }

    if (!isClean(wtPath)) {
      skippedDirty++;
      console.log(`[vm-stale-worktree-gc] SKIP (dirty): ${wtPath}`);
      continue;
    }

    if (!isMerged(wtPath)) {
      skippedUnmerged++;
      continue;
    }

    // Safe to remove: clean + merged.
    const sizeMb = diskUsageMb(wtPath);
    console.log(`[vm-stale-worktree-gc] REMOVE (clean+merged, ~${sizeMb}MB): ${wtPath}`);

    const r = removeWorktree(wt.primary, wtPath);
    if (r.ok) {
      removed++;
      removedMb += sizeMb;
    } else {
      // Non-force removal failed — could be locked post-check or detached HEAD.
      // Log but do not escalate; safe to skip.
      console.log(`[vm-stale-worktree-gc] REMOVE FAILED (non-force, skipping): ${wtPath} — ${r.stdout}`);
      errors.push(`${wtPath}: ${r.stdout}`);
    }
  }

  // Prune dangling worktree refs from each primary repo.
  for (const primary of PRIMARY_REPOS) {
    if (!fs.existsSync(primary)) continue;
    run(`git -C "${primary}" worktree prune 2>/dev/null`);
  }

  console.log(
    `[vm-stale-worktree-gc] Done: removed=${removed} (~${removedMb}MB), ` +
    `dirty=${skippedDirty}, unmerged=${skippedUnmerged}, protected=${skippedProtected}` +
    (errors.length ? `, errors=${errors.length}` : ""),
  );

  return { removed, removedMb, skippedDirty, skippedUnmerged, errors };
}

module.exports = { main, isLinkedWorktree };

if (require.main === module) {
  main();
}
