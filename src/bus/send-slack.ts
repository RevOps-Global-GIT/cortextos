/**
 * send-slack — bus command that posts a Slack reply as the current agent.
 *
 * Invoked by Claude Code when an agent replies to a Slack message:
 *
 *   cortextos bus send-slack <channel> '<text>' [--thread-ts <ts>] [--inbox-id <id>]
 *
 * This forwards to the agent-slack-post edge function with the shared
 * X-Internal-Secret, which looks up the agent's bot token from edge-function
 * env and calls Slack chat.postMessage. The reply posts under the agent's
 * native Slack identity.
 *
 * Agent identity is derived from the current process env:
 *   - CORTEXTOS_AGENT_NAME (the agent subdir name, e.g. "orchestrator"). We
 *     capitalize it to match the agent_slack_apps.display_name / orch_agents.title.
 *   - Override: --agent <title> if the canonical title isn't derivable.
 *
 * Required env vars:
 *   SUPABASE_RGOS_URL
 *   INTERNAL_CRON_SECRET   (or SUPABASE_AGENT_POST_SECRET if the daemon
 *                           separates these in the future)
 */

interface SendSlackOptions {
  threadTs?: string;
  inboxId?: string;
  agent?: string;
  blocks?: unknown;
  unfurlLinks?: boolean;
}

function titleCase(agentName: string): string {
  return agentName
    .split(/[\s_-]+/)
    .map((w) => (w.length === 0 ? w : w[0].toUpperCase() + w.slice(1).toLowerCase()))
    .join(' ');
}

export async function sendSlack(
  channel: string,
  text: string,
  opts: SendSlackOptions = {},
): Promise<{ ok: boolean; ts?: string; error?: string; as_app?: string }> {
  const url = process.env.SUPABASE_RGOS_URL;
  // Prefer AGENT_BUS_SECRET (dedicated); fall back to legacy INTERNAL_CRON_SECRET.
  const secret =
    process.env.AGENT_BUS_SECRET ||
    process.env.INTERNAL_CRON_SECRET ||
    process.env.SUPABASE_INTERNAL_CRON_SECRET ||
    process.env.X_INTERNAL_SECRET;
  if (!url) {
    return { ok: false, error: 'SUPABASE_RGOS_URL not set' };
  }
  if (!secret) {
    return { ok: false, error: 'INTERNAL_CRON_SECRET not set' };
  }

  const agentTitle =
    opts.agent ??
    (process.env.CORTEXTOS_AGENT_NAME
      ? titleCase(process.env.CORTEXTOS_AGENT_NAME)
      : null);
  if (!agentTitle) {
    return {
      ok: false,
      error:
        'Could not resolve agent title. Set CORTEXTOS_AGENT_NAME or pass --agent "<Title>".',
    };
  }

  const body: Record<string, unknown> = {
    agent_title: agentTitle,
    channel,
    text,
  };
  if (opts.threadTs) body.thread_ts = opts.threadTs;
  if (opts.inboxId) body.inbox_id = opts.inboxId;
  if (opts.blocks) body.blocks = opts.blocks;
  if (typeof opts.unfurlLinks === 'boolean') body.unfurl_links = opts.unfurlLinks;

  const endpoint = `${url}/functions/v1/agent-slack-post`;

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-secret': secret,
      },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as {
      ok: boolean;
      ts?: string;
      error?: string;
      as_app?: string;
    };
    return data;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
