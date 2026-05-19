/**
 * PostToolUse hook: emit a STACK-17 task event for the active task.
 *
 * The hook intentionally no-ops when CTX_TASK_ID is missing so it can be
 * installed globally without generating unscoped noise.
 *
 * REGISTRATION RULE: Register this hook in exactly ONE PostToolUse chain —
 * either cortextos agent settings OR rgos dist, never both. Dual registration
 * causes every tool call to emit two events for the same task, doubling the
 * event stream. Canonical location: cortextos agent settings.json PostToolUse.
 */
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { emitAgentTaskEvent } from '../bus/agent-task-events.js';
import { resolveEnv } from '../utils/env.js';
import { formatToolSummary, parseHookInput, readStdin } from './index.js';

function truncate(value: string, max = 1200): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function readHookJson(input: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function resultPreview(hookJson: Record<string, unknown>): string {
  const candidates = [
    hookJson.tool_response,
    hookJson.tool_result,
    hookJson.result,
    hookJson.output,
  ];
  const found = candidates.find((value) => value != null);
  if (typeof found === 'string') return truncate(found);
  if (found != null) return truncate(JSON.stringify(found));
  return '';
}

async function emitSubagentStartIfNeeded(env = resolveEnv(), taskId: string): Promise<void> {
  const subagentId = process.env.CTX_SUBAGENT_ID;
  if (!subagentId) return;

  const stateDir = join(env.ctxRoot, 'state', env.agentName, 'agent-task-events');
  const markerPath = join(stateDir, `${taskId}-${subagentId}.started`);
  if (existsSync(markerPath)) return;

  mkdirSync(stateDir, { recursive: true });
  await emitAgentTaskEvent(env, taskId, 'subagent_start', {
    subagent_id: subagentId,
    parent_agent_id: env.agentName,
    label: process.env.CTX_SUBAGENT_LABEL || subagentId,
  });
  writeFileSync(markerPath, new Date().toISOString(), 'utf-8');
}

async function main(): Promise<void> {
  const taskId = process.env.CTX_TASK_ID;
  if (!taskId) return;

  const input = await readStdin();
  const hookJson = readHookJson(input);
  const { tool_name, tool_input } = parseHookInput(input);
  const env = resolveEnv();

  await emitSubagentStartIfNeeded(env, taskId);
  await emitAgentTaskEvent(env, taskId, 'tool_call_result', {
    call_id: String(hookJson.tool_use_id || hookJson.call_id || `${tool_name}:${Date.now()}`),
    tool: tool_name,
    output_preview: resultPreview(hookJson) || formatToolSummary(tool_name, tool_input),
    is_error: Boolean(hookJson.is_error || hookJson.error),
  });
}

main().catch((err) => {
  process.stderr.write(`hook-agent-task-event error: ${(err as Error).message}\n`);
  process.exit(0);
});
