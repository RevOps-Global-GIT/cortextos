/**
 * hook-pr-url-wire.ts — PostToolUse hook (matcher: Bash).
 *
 * After any `gh pr create` bash call, extracts the PR URL from the tool output,
 * finds the current in_progress task for this agent, and patches pr_url into the
 * orch_tasks mirror row via mirrorPrUrlToRgos. Best-effort — never throws, never
 * blocks, always exits 0.
 *
 * This wires the pr_cycle_minutes metric (claim → PR merge) in autoresearch
 * without requiring agents to manually call `bus set-pr-url` after each PR open.
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { mirrorPrUrlToRgos } from '../bus/rgos-mirror.js';
import { readStdin, parseHookInput } from './index.js';

const PR_URL_RE = /https:\/\/github\.com\/[^\s"'<>]+\/pull\/\d+/;
const GH_PR_CREATE_RE = /\bgh\s+pr\s+create\b/;

function extractPrUrl(hookJson: Record<string, unknown>): string | null {
  const candidates = [
    hookJson.tool_response,
    hookJson.tool_result,
    hookJson.result,
    hookJson.output,
  ];
  for (const c of candidates) {
    const str = typeof c === 'string' ? c : c != null ? JSON.stringify(c) : null;
    if (!str) continue;
    const m = PR_URL_RE.exec(str);
    if (m) return m[0];
  }
  return null;
}

function findInProgressTaskId(ctxRoot: string, org: string, agentName: string): string | null {
  const taskDirs = [
    join(ctxRoot, 'orgs', org, 'tasks'),
    join(ctxRoot, 'tasks'),
  ];
  let best: { id: string; ts: number } | null = null;
  for (const dir of taskDirs) {
    let files: string[];
    try { files = readdirSync(dir).filter(f => f.endsWith('.json')); }
    catch { continue; }
    for (const file of files) {
      try {
        const task = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as Record<string, unknown>;
        if (task.status === 'in_progress' && task.assigned_to === agentName) {
          const ts = new Date(String(task.updated_at || task.created_at || 0)).getTime();
          if (!best || ts > best.ts) best = { id: String(task.id), ts };
        }
      } catch { /* skip corrupt */ }
    }
  }
  return best?.id ?? null;
}

async function main(): Promise<void> {
  const raw = await readStdin();
  const { tool_name, tool_input } = parseHookInput(raw);
  if (tool_name !== 'Bash') return;

  const command: string = (tool_input?.command as string) ?? '';
  if (!GH_PR_CREATE_RE.test(command)) return;

  let hookJson: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw);
    hookJson = (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      ? parsed as Record<string, unknown>
      : {};
  } catch { return; }

  const prUrl = extractPrUrl(hookJson);
  if (!prUrl) return;

  const agentName = process.env.CTX_AGENT_NAME || '';
  if (!agentName) return;

  const instanceId = process.env.CTX_INSTANCE_ID || 'default';
  const org = process.env.CTX_ORG || '';
  const ctxRoot = process.env.CTX_ROOT || join(homedir(), '.cortextos', instanceId);

  const taskId = findInProgressTaskId(ctxRoot, org, agentName);
  if (!taskId) return;

  await mirrorPrUrlToRgos(taskId, prUrl);
}

if (process.argv[1]?.includes('hook-pr-url-wire')) {
  main().catch(() => process.exit(0));
}
