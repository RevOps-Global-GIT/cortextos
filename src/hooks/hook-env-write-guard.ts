/**
 * hook-env-write-guard.ts — PreToolUse hook for Write/Edit tools.
 *
 * Intercepts Write and Edit calls that target *.env files and validates
 * content before any bytes reach disk. Rejects:
 *   - Empty content / all-whitespace
 *   - Content with zero parseable KEY=VALUE pairs (e.g. plain text, JSON)
 *
 * This is Q4 part 3 of the activity-channel.env protection trilogy. Parts 1
 * and 2 added atomic writes and chmod 444 locking via `update-env-file`.
 * Part 3 catches the upstream Write/Edit tool path before it can bypass those
 * safeguards and overwrite a protected env file with garbage.
 *
 * On violation: writes { decision: 'block', reason } to stdout and exits 0.
 * On non-env file: exits 0 silently.
 * On crash: exits non-zero → tool call is BLOCKED (fail-closed).
 */

import { readStdin, parseHookInput } from './index.js';

// Files matching these patterns are guarded. The pattern is intentionally
// broad: *.env, .env, .env.local, activity-channel.env, secrets.env, etc.
function isEnvFile(filePath: string): boolean {
  const base = filePath.split('/').pop() || '';
  return base === '.env' ||
    base.endsWith('.env') ||
    base.endsWith('.env.local') ||
    base.endsWith('.env.example') ||
    base === 'secrets.env';
}

/**
 * Minimal inline env validator — mirrors validateEnvContent from utils/env.ts
 * without requiring a compiled import (hook runs before build is guaranteed).
 */
function validateEnv(content: string): string | null {
  if (!content || !content.trim()) {
    return 'env write rejected: content is empty';
  }
  let pairs = 0;
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) pairs++;
  }
  if (pairs === 0) {
    return 'env write rejected: content has no parseable KEY=VALUE pairs';
  }
  return null;
}

function blockCall(reason: string): void {
  process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
}

async function main(): Promise<void> {
  const raw = await readStdin();
  const { tool_name, tool_input } = parseHookInput(raw);

  if (tool_name === 'Write') {
    const filePath: string = tool_input.file_path || '';
    if (!isEnvFile(filePath)) return;
    const content: string = tool_input.content || '';
    const err = validateEnv(content);
    if (err) {
      blockCall(`[env-write-guard] Write to ${filePath.split('/').pop()} blocked: ${err}`);
    }
    return;
  }

  if (tool_name === 'Edit') {
    const filePath: string = tool_input.file_path || '';
    if (!isEnvFile(filePath)) return;
    // Edit sends new_string (the replacement fragment). Only block if the
    // new_string itself looks like it would produce an empty or non-env file.
    // We can't validate the merged result here, so we only reject the
    // unambiguous cases: replacement is blank, or replacement is clearly
    // non-env content (e.g. pure JSON or zero KEY=VALUE pairs in a multi-line
    // replacement that's more than 3 lines long).
    const newString: string = tool_input.new_string || '';
    const lines = newString.split(/\r?\n/).filter((l: string) => l.trim());
    if (lines.length === 0) return; // blank replacement is normal (deletion)
    if (lines.length >= 3) {
      const err = validateEnv(newString);
      if (err) {
        blockCall(`[env-write-guard] Edit to ${filePath.split('/').pop()} blocked: ${err}`);
      }
    }
    return;
  }
}

main().catch(() => process.exit(1));
