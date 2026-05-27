import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { AgentCursor } from '../agent-cursor';
import type { AgentPresencePayload } from '@/lib/agent-presence';

const presence: AgentPresencePayload = {
  actor_id: 'codex-2',
  kind: 'agent',
  name: 'Codex 2',
  avatar_url: null,
  task_id: 'task_legacy',
  current_task_id: 'task_current',
  anchor_task_id: 'task_anchor',
  task_title: 'Fleet cursor anchoring',
  status: 'task_updated',
  action_label: 'Inspecting card',
  updated_at: '2026-05-26T16:00:00Z',
  source: 'cortextos-bus',
};

describe('AgentCursor anchoring', () => {
  it('stays anchored to the supplied task card instead of a shared actor layout', () => {
    const element = AgentCursor({ presence, anchorId: 'task_card' }) as ReactElement<Record<string, unknown>>;

    expect(element.props.layoutId).toBeUndefined();
    expect(element.props['data-agent-cursor']).toBe('codex-2');
    expect(element.props['data-agent-cursor-anchor']).toBe('task_card');
    expect(element.props.className).toContain('absolute');
  });

  it('falls back to the presence anchor when no card anchor is supplied', () => {
    const element = AgentCursor({ presence }) as ReactElement<Record<string, unknown>>;

    expect(element.props['data-agent-cursor-anchor']).toBe('task_anchor');
  });
});
