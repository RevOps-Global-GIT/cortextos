/**
 * hook-blocked-auto-rotate.ts — PostToolUse hook (matcher: Bash).
 *
 * Enforces the blocked-task auto-rotate protocol from the worker-agents skill:
 * when an agent marks a task blocked it MUST first spawn a worker or rotate to
 * a backlog task. This hook is the enforcement backstop.
 *
 * Two state-machine transitions handled:
 *
 *   1. spawn-worker OR update-task <id> in_progress
 *      → Record current timestamp in state file (agent is compliant).
 *
 *   2. update-task <id> blocked
 *      → If state file shows a spawn/rotate within the last 5 minutes: no-op.
 *      → If backlog has pending tasks: send VIOLATION warning to agent's inbox.
 *      → If backlog is genuinely empty: send BACKLOG EMPTY nudge instead.
 *
 * State file: $CTX_ROOT/state/$CTX_AGENT_NAME/blocked-auto-rotate.json
 * { "last_rotation_at": "<ISO timestamp>" }
 *
 * Always exits 0 — never blocks a tool call.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { sendMessage } from '../bus/message.js';
import { resolvePaths } from '../utils/paths.js';
import { readStdin, parseHookInput } from './index.js';

export const STATE_FILE_NAME = 'blocked-auto-rotate.json';
const ROTATION_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

// Matches: cortextos bus update-task <id> blocked
const BLOCKED_RE = /(?:cortextos\s+bus|bus)\s+update-task\s+(\S+)\s+blocked\b/;
// Matches: cortextos bus update-task <id> in_progress
const IN_PROGRESS_RE = /(?:cortextos\s+bus|bus)\s+update-task\s+\S+\s+in_progress\b/;
// Matches: cortextos bus spawn-worker or cortextos spawn-worker
const SPAWN_WORKER_RE = /(?:cortextos\s+(?:bus\s+)?)?spawn-worker\b/;

interface State {
  last_rotation_at: string;
}

function stateFilePath(ctxRoot: string, agentName: string): string {
  return join(ctxRoot, 'state', agentName, STATE_FILE_NAME);
}

/** Write current timestamp to state file — marks agent as compliant. */
export function recordRotation(ctxRoot: string, agentName: string): void {
  const statePath = stateFilePath(ctxRoot, agentName);
  mkdirSync(join(statePath, '..'), { recursive: true });
  writeFileSync(statePath, JSON.stringify({ last_rotation_at: new Date().toISOString() }), 'utf-8');
}

function readState(ctxRoot: string, agentName: string): State | null {
  const statePath = stateFilePath(ctxRoot, agentName);
  if (!existsSync(statePath)) return null;
  try {
    return JSON.parse(readFileSync(statePath, 'utf-8')) as State;
  } catch {
    return null;
  }
}

function hasPendingTasks(ctxRoot: string, org: string, agentName: string): boolean {
  const taskDirs = [
    join(ctxRoot, 'orgs', org, 'tasks'),
    join(ctxRoot, 'tasks'),
  ];
  for (const dir of taskDirs) {
    if (!existsSync(dir)) continue;
    try {
      const files = readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('archive'));
      for (const file of files) {
        try {
          const task = JSON.parse(readFileSync(join(dir, file), 'utf-8'));
          if (
            task.status === 'pending' &&
            (task.assigned_to === agentName || !task.assigned_to)
          ) {
            return true;
          }
        } catch { /* skip corrupt */ }
      }
    } catch { /* skip unreadable dir */ }
  }
  return false;
}

/**
 * Core compliance check — exported for unit testing.
 * Sends a warning to the agent's inbox if the blocked-auto-rotate rule is violated.
 */
export function checkCompliance(
  ctxRoot: string,
  org: string,
  agentName: string,
  instanceId: string,
  taskId: string,
): void {
  const state = readState(ctxRoot, agentName);
  if (state) {
    const elapsed = Date.now() - new Date(state.last_rotation_at).getTime();
    if (elapsed < ROTATION_WINDOW_MS) return; // compliant
  }

  const paths = resolvePaths(agentName, instanceId, org);
  const pending = hasPendingTasks(ctxRoot, org, agentName);

  if (pending) {
    const msg =
      `BLOCKED-AUTO-ROTATE VIOLATION: you marked task ${taskId} blocked without spawning a worker or rotating to a backlog task. ` +
      `Per worker-agents skill protocol, idle blockers are not acceptable. ` +
      `Run: cortextos bus list-tasks --agent ${agentName} --status pending, then spawn-worker or claim the next task.`;
    sendMessage(paths, 'hook', agentName, 'urgent', msg);
  } else {
    const msg =
      `BACKLOG EMPTY — task ${taskId} is blocked and no pending tasks remain. ` +
      `Surface to orchestrator and stand by.`;
    sendMessage(paths, 'hook', agentName, 'normal', msg);
  }
}

async function main(): Promise<void> {
  const raw = await readStdin();
  const { tool_name, tool_input } = parseHookInput(raw);

  if (tool_name !== 'Bash') return;

  const command: string = tool_input?.command ?? '';
  if (!command) return;

  const agentName = process.env.CTX_AGENT_NAME || '';
  const instanceId = process.env.CTX_INSTANCE_ID || 'default';
  const org = process.env.CTX_ORG || '';
  const ctxRoot = process.env.CTX_ROOT || join(homedir(), '.cortextos', instanceId);

  if (!agentName) return;

  // Case 1: agent spawned a worker or rotated to in_progress — record timestamp.
  if (SPAWN_WORKER_RE.test(command) || IN_PROGRESS_RE.test(command)) {
    try {
      recordRotation(ctxRoot, agentName);
    } catch { /* non-fatal */ }
    return;
  }

  // Case 2: agent marked a task blocked — check compliance.
  const blockedMatch = BLOCKED_RE.exec(command);
  if (!blockedMatch) return;

  try {
    checkCompliance(ctxRoot, org, agentName, instanceId, blockedMatch[1]);
  } catch { /* non-fatal — hook must never block */ }
}

main().catch(() => {
  process.exit(0); // always exit 0 — never block tool execution
});
