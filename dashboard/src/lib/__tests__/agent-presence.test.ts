import { describe, expect, it } from 'vitest';
import { isAgentPresencePayload, presenceTaskId, type AgentPresencePayload } from '../agent-presence';

const basePresence: AgentPresencePayload = {
  actor_id: 'codex',
  kind: 'agent',
  name: 'codex',
  avatar_url: null,
  task_id: 'task_legacy',
  task_title: 'Legacy task',
  status: 'task_updated',
  action_label: 'Working',
  updated_at: '2026-05-19T04:00:00Z',
  source: 'cortextos-bus',
};

describe('agent presence payloads', () => {
  it('accepts cursor v2 fields from the bus mirror', () => {
    const payload = {
      ...basePresence,
      agent_id: 'codex',
      current_action: 'editing',
      current_task_id: 'task_current',
      cursor_position_hint: 'Editing task card',
      ts: '2026-05-19T04:00:00Z',
      anchor_task_id: 'task_anchor',
    };

    expect(isAgentPresencePayload(payload)).toBe(true);
  });

  it('uses anchor_task_id before legacy task ids', () => {
    expect(
      presenceTaskId({
        ...basePresence,
        current_task_id: 'task_current',
        anchor_task_id: 'task_anchor',
      }),
    ).toBe('task_anchor');
  });

  it('falls back to current_task_id when no anchor or legacy task id is present', () => {
    expect(
      presenceTaskId({
        ...basePresence,
        task_id: null,
        current_task_id: 'task_current',
      }),
    ).toBe('task_current');
  });

  it('rejects malformed optional cursor fields', () => {
    expect(
      isAgentPresencePayload({
        ...basePresence,
        anchor_task_id: 123,
      }),
    ).toBe(false);
  });
});
