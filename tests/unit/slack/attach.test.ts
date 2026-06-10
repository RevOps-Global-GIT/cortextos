import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { attachSlackToAgent, type FastCheckerLike } from '../../../src/slack/attach.js';

const AGENT_ID = '1d7f1927-a41e-49c0-1d7f-1927a41ee9c0';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('attachSlackToAgent', () => {
  const originalFetch = globalThis.fetch;
  let agentDir: string;
  let logs: string[];
  let queued: string[];
  let checker: FastCheckerLike;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), 'slack-attach-'));
    logs = [];
    queued = [];
    checker = {
      queueTelegramMessage: (formatted: string) => { queued.push(formatted); },
      isDuplicate: () => false,
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    rmSync(agentDir, { recursive: true, force: true });
  });

  function writeEnv() {
    writeFileSync(
      join(agentDir, '.env'),
      'SUPABASE_RGOS_URL=https://example.supabase.co\nSUPABASE_RGOS_SERVICE_KEY=service-key-123\n',
    );
  }

  it('returns null when the agent .env has no Supabase creds', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;

    const poller = await attachSlackToAgent({
      agentName: 'orchestrator',
      agentDir,
      checker,
      log: (m) => logs.push(m),
    });

    expect(poller).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes('not in'))).toBe(true);
  });

  it('returns null when no orch_agents row matches the agent name', async () => {
    writeEnv();
    globalThis.fetch = vi.fn(async () => jsonResponse([]));

    const poller = await attachSlackToAgent({
      agentName: 'ghost-agent',
      agentDir,
      checker,
      log: (m) => logs.push(m),
    });

    expect(poller).toBeNull();
    expect(logs.some((l) => l.includes('no orch_agents row'))).toBe(true);
  });

  it('returns null when the agent has no agent_slack_apps row', async () => {
    writeEnv();
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/rest/v1/orch_agents')) {
        return jsonResponse([{ id: AGENT_ID, title: 'Orchestrator' }]);
      }
      if (url.includes('/rest/v1/agent_slack_apps')) {
        return jsonResponse([]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const poller = await attachSlackToAgent({
      agentName: 'orchestrator',
      agentDir,
      checker,
      log: (m) => logs.push(m),
    });

    expect(poller).toBeNull();
    expect(logs.some((l) => l.includes('no agent_slack_apps row'))).toBe(true);
  });

  it('starts a poller and injects unprocessed inbox rows into the checker queue', async () => {
    writeEnv();
    const inboxRow = {
      id: 'row-1',
      agent_id: AGENT_ID,
      slack_app_id: 'app-1',
      slack_channel_id: 'D0123456789',
      slack_user_id: 'U0123456789',
      slack_ts: '1760000000.000100',
      slack_thread_ts: null,
      channel_type: 'im',
      event_type: 'message',
      from_slack_user: 'Greg',
      from_user_id: null,
      text: 'are you getting my slack DMs?',
      reply_to_text: null,
      processed_at: null,
      created_at: '2026-06-09T23:58:00Z',
    };
    let inboxPolls = 0;
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/rest/v1/orch_agents')) {
        return jsonResponse([{ id: AGENT_ID, title: 'Orchestrator' }]);
      }
      if (url.includes('/rest/v1/agent_slack_apps')) {
        return jsonResponse([{ id: 'app-1' }]);
      }
      if (url.includes('/rest/v1/agent_slack_inbox')) {
        inboxPolls += 1;
        // Only the first poll returns the row; later polls are empty so the
        // in-process injected-set dedup is also exercised.
        return jsonResponse(inboxPolls === 1 ? [inboxRow] : []);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const poller = await attachSlackToAgent({
      agentName: 'orchestrator',
      agentDir,
      checker,
      log: (m) => logs.push(m),
      staggerMs: 0,
    });

    expect(poller).not.toBeNull();
    expect(logs.some((l) => l.includes(`poller started for orchestrator (agent_id=${AGENT_ID})`))).toBe(true);

    // attachSlackToAgent fires poller.start() without awaiting; give the
    // first poll cycle a tick to run, then stop.
    await vi.waitFor(() => {
      expect(queued.length).toBe(1);
    }, { timeout: 2000 });
    poller!.stop();

    expect(queued[0]).toContain('=== SLACK DM from [USER: Greg] ===');
    expect(queued[0]).toContain('are you getting my slack DMs?');
    expect(queued[0]).toContain('--inbox-id row-1');
  });

  it('suppresses rows the checker reports as duplicates', async () => {
    writeEnv();
    checker.isDuplicate = () => true;
    let inboxPolls = 0;
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/rest/v1/orch_agents')) {
        return jsonResponse([{ id: AGENT_ID, title: 'Orchestrator' }]);
      }
      if (url.includes('/rest/v1/agent_slack_apps')) {
        return jsonResponse([{ id: 'app-1' }]);
      }
      if (url.includes('/rest/v1/agent_slack_inbox')) {
        inboxPolls += 1;
        return jsonResponse(inboxPolls === 1 ? [{
          id: 'row-dup',
          agent_id: AGENT_ID,
          slack_app_id: 'app-1',
          slack_channel_id: 'D0123456789',
          slack_user_id: 'U0123456789',
          slack_ts: '1760000000.000200',
          slack_thread_ts: null,
          channel_type: 'im',
          event_type: 'message',
          from_slack_user: 'Greg',
          from_user_id: null,
          text: 'dup',
          reply_to_text: null,
          processed_at: null,
          created_at: '2026-06-09T23:59:00Z',
        }] : []);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const poller = await attachSlackToAgent({
      agentName: 'orchestrator',
      agentDir,
      checker,
      log: (m) => logs.push(m),
      staggerMs: 0,
    });

    expect(poller).not.toBeNull();
    await vi.waitFor(() => {
      expect(logs.some((l) => l.includes('duplicate inbox row row-dup suppressed'))).toBe(true);
    }, { timeout: 2000 });
    poller!.stop();

    expect(queued.length).toBe(0);
  });
});
