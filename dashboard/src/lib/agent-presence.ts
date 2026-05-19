export type AgentPresenceAction =
  | 'task_created'
  | 'task_updated'
  | 'task_completed'
  | 'idle';

export interface AgentPresencePayload {
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
    payload.source === 'cortextos-bus'
  );
}
