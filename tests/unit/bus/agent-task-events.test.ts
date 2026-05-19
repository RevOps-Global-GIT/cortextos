import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  emitAgentTaskEvent,
  isAgentTaskEventType,
  parseAgentTaskEventPayload,
} from '../../../src/bus/agent-task-events';
import type { CtxEnv } from '../../../src/types';

const env: CtxEnv = {
  instanceId: 'default',
  ctxRoot: '/tmp/ctx',
  frameworkRoot: '/tmp/framework',
  agentName: 'codex-3',
  agentDir: '/tmp/framework/orgs/revops-global/agents/codex-3',
  org: 'revops-global',
  projectRoot: '/tmp/framework',
};

describe('agent task events', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('recognizes the STACK-17 event vocabulary', () => {
    expect(isAgentTaskEventType('tool_call_start')).toBe(true);
    expect(isAgentTaskEventType('tool_call_result')).toBe(true);
    expect(isAgentTaskEventType('bash_output')).toBe(true);
    expect(isAgentTaskEventType('edit_diff')).toBe(true);
    expect(isAgentTaskEventType('screenshot')).toBe(true);
    expect(isAgentTaskEventType('thinking')).toBe(true);
    expect(isAgentTaskEventType('status_update')).toBe(true);
    expect(isAgentTaskEventType('message')).toBe(true);
    expect(isAgentTaskEventType('subagent_start')).toBe(true);
    expect(isAgentTaskEventType('subagent_end')).toBe(true);
    expect(isAgentTaskEventType('unknown')).toBe(false);
  });

  it('parses only JSON object payloads', () => {
    expect(parseAgentTaskEventPayload('{"status":"ok"}')).toEqual({ status: 'ok' });
    expect(() => parseAgentTaskEventPayload('[]')).toThrow('payload must be a JSON object');
    expect(() => parseAgentTaskEventPayload('nope')).toThrow('payload must be valid JSON');
  });

  it('emits through the Supabase RPC with monotonic sequencing delegated to the database', async () => {
    const row = {
      id: 'evt_1',
      org_id: 'revops-global',
      task_id: 'task_1',
      agent_id: 'codex-3',
      seq: 1,
      event_type: 'status_update',
      payload: { status: 'ok' },
      created_at: '2026-05-19T11:00:00Z',
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(row), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const emitted = await emitAgentTaskEvent(
      env,
      'task_1',
      'status_update',
      { status: 'ok' },
      { supabaseUrl: 'https://example.supabase.co/', serviceKey: 'service-key' },
    );

    expect(emitted).toEqual(row);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://example.supabase.co/rest/v1/rpc/emit_agent_task_event');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({
      apikey: 'service-key',
      Authorization: 'Bearer service-key',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      p_task_id: 'task_1',
      p_agent_id: 'codex-3',
      p_event_type: 'status_update',
      p_payload: { status: 'ok' },
      p_org_id: 'revops-global',
    });
  });
});
