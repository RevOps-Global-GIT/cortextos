#!/usr/bin/env node
/**
 * fix-data-permissions.js
 *
 * One-shot migration: chmod all .json/.jsonl files in the cortextos data dir
 * from 0o600 → 0o644 so cross-user reads work after multi-user installs.
 * Also fixes parent directories from 0o700 → 0o755.
 *
 * Usage:
 *   node scripts/fix-data-permissions.js [--data-root <path>] [--dry-run]
 *
 * Defaults:
 *   --data-root  ~/.cortextos/<instance>   (auto-detected via CORTEXTOS_ROOT or
 *                                           ~/.cortextos first subdirectory)
 */

const { readdirSync, statSync, chmodSync } = require('fs');
const { join, resolve } = require('path');
const { homedir } = require('os');

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const dataRootIdx = args.indexOf('--data-root');
let dataRoot = dataRootIdx !== -1 ? resolve(args[dataRootIdx + 1]) : null;

if (!dataRoot) {
  const cortextosHome = process.env.CORTEXTOS_ROOT ?? join(homedir(), '.cortextos');
  try {
    const entries = readdirSync(cortextosHome, { withFileTypes: true });
    const first = entries.find(e => e.isDirectory());
    if (first) dataRoot = join(cortextosHome, first.name);
  } catch {
    // ignore
  }
}

if (!dataRoot) {
  console.error('Could not detect cortextos data root. Pass --data-root <path>.');
  process.exit(1);
}

console.log(`fix-data-permissions: scanning ${dataRoot}${dryRun ? ' [DRY RUN]' : ''}`);

// ---------------------------------------------------------------------------
// Walk + fix
// ---------------------------------------------------------------------------
let dirsFixed = 0;
let filesFixed = 0;
let skipped = 0;

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Fix dir mode: 0o700 → 0o755
      try {
        const st = statSync(full);
        const mode = st.mode & 0o777;
        if (mode === 0o700) {
          if (!dryRun) chmodSync(full, 0o755);
          console.log(`  dir  ${mode.toString(8)} → 755  ${full}`);
          dirsFixed++;
        }
      } catch {
        // ignore stat/chmod errors
      }
      walk(full);
    } else if (entry.isFile() && (entry.name.endsWith('.json') || entry.name.endsWith('.jsonl'))) {
      try {
        const st = statSync(full);
        const mode = st.mode & 0o777;
        if (mode === 0o600) {
          if (!dryRun) chmodSync(full, 0o644);
          console.log(`  file ${mode.toString(8)} → 644  ${full}`);
          filesFixed++;
        } else {
          skipped++;
        }
      } catch {
        // ignore
      }
    }
  }
}

walk(dataRoot);

console.log(`\nDone: ${dirsFixed} dirs fixed, ${filesFixed} files fixed, ${skipped} files already correct${dryRun ? ' [DRY RUN — no changes written]' : ''}`);
