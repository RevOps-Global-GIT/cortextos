import type { CtxEnv, TaskStatus } from '../types/index.js';
import { applySecretsToEnv } from '../utils/env.js';

export const AGENT_TASK_EVENT_TYPES = [
  'tool_call_start',
  'tool_call_result',
  'bash_output',
  'edit_diff',
  'screenshot',
  'thinking',
  'status_update',
  'message',
  'subagent_start',
  'subagent_end',
] as const;

export type AgentTaskEventType = (typeof AGENT_TASK_EVENT_TYPES)[number];

export interface AgentTaskEventRow {
  id: string;
  org_id: string;
  task_id: string;
  agent_id: string;
  seq: number;
  event_type: AgentTaskEventType;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface EmitAgentTaskEventOptions {
  orgId?: string;
  agentId?: string;
  supabaseUrl?: string;
  serviceKey?: string;
}

const EVENT_TYPE_SET = new Set<string>(AGENT_TASK_EVENT_TYPES);

export function isAgentTaskEventType(value: string): value is AgentTaskEventType {
  return EVENT_TYPE_SET.has(value);
}

export function parseAgentTaskEventPayload(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`payload must be valid JSON: ${(err as Error).message}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('payload must be a JSON object');
  }

  return parsed as Record<string, unknown>;
}

function resolveSupabaseConfig(env: CtxEnv, options: EmitAgentTaskEventOptions) {
  applySecretsToEnv(env);

  const supabaseUrl = (
    options.supabaseUrl ||
    process.env.SUPABASE_RGOS_URL ||
    process.env.SUPABASE_URL ||
    process.env.VITE_SUPABASE_URL ||
    ''
  ).replace(/\/$/, '');

  const serviceKey =
    options.serviceKey ||
    process.env.SUPABASE_RGOS_SERVICE_KEY ||
    process.env.RGOS_SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    '';

  if (!supabaseUrl) {
    throw new Error('missing Supabase URL (set SUPABASE_RGOS_URL or SUPABASE_URL in org secrets)');
  }
  if (!serviceKey) {
    throw new Error('missing Supabase service key (set SUPABASE_RGOS_SERVICE_KEY or SUPABASE_SERVICE_ROLE_KEY in org secrets)');
  }

  return { supabaseUrl, serviceKey };
}

export async function emitAgentTaskEvent(
  env: CtxEnv,
  taskId: string,
  eventType: AgentTaskEventType,
  payload: Record<string, unknown>,
  options: EmitAgentTaskEventOptions = {},
): Promise<AgentTaskEventRow> {
  if (!taskId.trim()) throw new Error('task_id is required');
  if (!isAgentTaskEventType(eventType)) throw new Error(`unsupported agent task event type: ${eventType}`);

  const orgId = options.orgId || env.org || 'revops-global';
  const agentId = options.agentId || env.agentName;
  if (!agentId) throw new Error('agent_id is required (set CTX_AGENT_NAME or pass --agent)');

  const { supabaseUrl, serviceKey } = resolveSupabaseConfig(env, options);
  const res = await fetch(`${supabaseUrl}/rest/v1/rpc/emit_agent_task_event`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      p_task_id: taskId,
      p_agent_id: agentId,
      p_event_type: eventType,
      p_payload: payload,
      p_org_id: orgId,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`emit_agent_task_event failed: HTTP ${res.status} ${text.slice(0, 500)}`);
  }

  return await res.json() as AgentTaskEventRow;
}

/**
 * Fire-and-forget status_update event emitted automatically by the task
 * lifecycle (updateTask, completeTask, claimTask). Reads agent/org from
 * process.env so callers don't need to thread CtxEnv through every call site.
 *
 * No-ops silently in test/CI environments and when Supabase creds are absent.
 */
export function autoEmitStatusUpdate(
  taskId: string,
  taskTitle: string,
  from: TaskStatus | undefined,
  to: TaskStatus,
  note?: string,
): void {
  if (process.env.VITEST || process.env.NODE_ENV === 'test') return;

  const agentName = process.env.CTX_AGENT_NAME || '';
  const org = process.env.CTX_ORG || '';
  const supabaseUrl = (
    process.env.SUPABASE_RGOS_URL ||
    process.env.SUPABASE_URL ||
    process.env.VITE_SUPABASE_URL ||
    ''
  ).replace(/\/$/, '');
  const serviceKey =
    process.env.SUPABASE_RGOS_SERVICE_KEY ||
    process.env.RGOS_SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    '';

  if (!supabaseUrl || !serviceKey || !agentName) return;

  const env: CtxEnv = {
    agentName,
    org,
    instanceId: process.env.CTX_INSTANCE_ID || 'default',
    ctxRoot: process.env.CTX_ROOT || '',
    frameworkRoot: process.env.CTX_FRAMEWORK_ROOT || process.env.CTX_PROJECT_ROOT || '',
    agentDir: process.env.CTX_AGENT_DIR || '',
    projectRoot: process.env.CTX_PROJECT_ROOT || '',
    timezone: process.env.CTX_TIMEZONE || 'UTC',
  };

  const payload: Record<string, unknown> = { task_title: taskTitle, to };
  if (from) payload.from = from;
  if (note) payload.note = note;

  emitAgentTaskEvent(env, taskId, 'status_update', payload, {
    agentId: agentName,
    orgId: org || undefined,
    supabaseUrl,
    serviceKey,
  }).catch(() => undefined);
}
