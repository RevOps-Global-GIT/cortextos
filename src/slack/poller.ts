/**
 * SlackPoller — per-agent inbound Slack message poller.
 *
 * Mirror of TelegramPoller: every N seconds polls `agent_slack_inbox` for
 * rows where agent_id matches this agent and processed_at IS NULL. For each
 * new row, formats the message like FastChecker.formatTelegramTextMessage
 * and enqueues it via the supplied `onMessage` callback (which typically
 * calls checker.queueTelegramMessage so the existing injection loop runs).
 *
 * The agent's Claude Code then treats the message as conversation input and
 * replies via `cortextos bus send-slack`, which posts via the agent-slack-post
 * edge function. When `send-slack` is called with --inbox-id, the edge
 * function marks the row processed. Rows this poller has already injected
 * but which weren't marked processed by a downstream send-slack call are
 * tracked in-process via `injected` so we don't re-inject.
 *
 * This poller runs via HTTP polling on the Supabase REST API — simpler than
 * realtime and fine at 5s cadence for human-scale chat.
 */

export interface SlackInboxRow {
  id: string;
  agent_id: string;
  slack_app_id: string;
  slack_channel_id: string;
  slack_user_id: string | null;
  slack_ts: string;
  slack_thread_ts: string | null;
  channel_type: string | null;
  event_type: 'message' | 'app_mention';
  from_slack_user: string | null;
  from_user_id: string | null;
  text: string;
  reply_to_text: string | null;
  processed_at: string | null;
  created_at: string;
}

export type SlackMessageHandler = (row: SlackInboxRow) => void | Promise<void>;

interface SupabaseRestEnv {
  url: string;
  serviceKey: string;
}

export class SlackPoller {
  private supabase: SupabaseRestEnv;
  private agentId: string;
  private handler: SlackMessageHandler | null = null;
  private running: boolean = false;
  private started: boolean = false;
  private stopRequested: boolean = false;
  private pollInterval: number;
  private label: string;
  // Track inbox row ids already injected this process lifetime. Prevents
  // duplicate injection when processed_at is lagged (send-slack races).
  private injected: Set<string> = new Set();
  // Ring-cap the set to avoid unbounded growth on long-lived processes.
  private static readonly INJECTED_CAP = 500;

  /**
   * @param supabase { url, serviceKey } pointing at the RGOS project.
   * @param agentId  orch_agents.id UUID for this agent.
   * @param pollInterval Milliseconds between poll cycles. Default 5s.
   * @param label Diagnostic label for logs (e.g. 'slack-orchestrator').
   */
  constructor(
    supabase: SupabaseRestEnv,
    agentId: string,
    pollInterval: number = 5000,
    label?: string,
  ) {
    this.supabase = supabase;
    this.agentId = agentId;
    this.pollInterval = pollInterval;
    this.label = label || 'slack-poller';
  }

  onMessage(handler: SlackMessageHandler): void {
    this.handler = handler;
  }

  async start(initialDelayMs: number = 0): Promise<void> {
    if (this.stopRequested) return;
    if (this.started) return;
    this.started = true;

    if (initialDelayMs > 0) {
      await sleep(initialDelayMs);
      if (this.stopRequested) return;
    }

    this.running = true;
    while (this.running) {
      try {
        await this.pollOnce();
      } catch (err) {
        console.error(`[${this.label}] poll error:`, err);
      }
      if (!this.running) break;
      await sleep(this.pollInterval);
    }
  }

  stop(): void {
    this.stopRequested = true;
    this.running = false;
  }

  private async pollOnce(): Promise<void> {
    const url = new URL(`${this.supabase.url}/rest/v1/agent_slack_inbox`);
    url.searchParams.set(
      'select',
      'id,agent_id,slack_app_id,slack_channel_id,slack_user_id,slack_ts,slack_thread_ts,channel_type,event_type,from_slack_user,from_user_id,text,reply_to_text,processed_at,created_at',
    );
    url.searchParams.set('agent_id', `eq.${this.agentId}`);
    url.searchParams.set('processed_at', 'is.null');
    url.searchParams.set('order', 'created_at.asc');
    url.searchParams.set('limit', '20');

    const res = await fetch(url.toString(), {
      headers: {
        apikey: this.supabase.serviceKey,
        Authorization: `Bearer ${this.supabase.serviceKey}`,
      },
    });
    if (!res.ok) {
      throw new Error(`agent_slack_inbox query returned ${res.status}: ${await res.text()}`);
    }
    const rows = (await res.json()) as SlackInboxRow[];
    if (rows.length === 0) return;

    for (const row of rows) {
      if (this.injected.has(row.id)) continue;
      this.injected.add(row.id);
      if (this.injected.size > SlackPoller.INJECTED_CAP) {
        const first = this.injected.values().next().value;
        if (first) this.injected.delete(first);
      }
      if (this.handler) {
        try {
          await this.handler(row);
        } catch (err) {
          console.error(`[${this.label}] handler threw for inbox row ${row.id}:`, err);
        }
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
