export type AgentPresenceAction =
  | 'task_created'
  | 'task_updated'
  | 'task_completed'
  | 'idle';

export interface AgentPresencePayload {
  agent_id?: string;
  current_action?: string;
  current_task_id?: string | null;
  cursor_position_hint?: string | null;
  ts?: string;
  anchor_task_id?: string | null;
  actor_id: string;
  kind: 'agent';
  name: string;
  avatar_url: string | null;
  task_id: string | null;
  task_title: string | null;
  status: AgentPresenceAction;
  action_label: string | null;
  updated_at: string;
  source: 'cortextos-bus';
}

export function presenceTaskId(payload: AgentPresencePayload) {
  return payload.anchor_task_id ?? payload.task_id ?? payload.current_task_id ?? null;
}

export function isAgentPresencePayload(value: unknown): value is AgentPresencePayload {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Record<string, unknown>;
  return (
    typeof payload.actor_id === 'string' &&
    payload.kind === 'agent' &&
    typeof payload.name === 'string' &&
    (payload.avatar_url === null || typeof payload.avatar_url === 'string') &&
    (payload.task_id === null || typeof payload.task_id === 'string') &&
    (payload.task_title === null || typeof payload.task_title === 'string') &&
    typeof payload.status === 'string' &&
    (payload.action_label === null || typeof payload.action_label === 'string') &&
    typeof payload.updated_at === 'string' &&
    payload.source === 'cortextos-bus' &&
    (payload.agent_id === undefined || typeof payload.agent_id === 'string') &&
    (payload.current_action === undefined || typeof payload.current_action === 'string') &&
    (payload.current_task_id === undefined ||
      payload.current_task_id === null ||
      typeof payload.current_task_id === 'string') &&
    (payload.cursor_position_hint === undefined ||
      payload.cursor_position_hint === null ||
      typeof payload.cursor_position_hint === 'string') &&
    (payload.ts === undefined || typeof payload.ts === 'string') &&
    (payload.anchor_task_id === undefined || payload.anchor_task_id === null || typeof payload.anchor_task_id === 'string')
  );
}
