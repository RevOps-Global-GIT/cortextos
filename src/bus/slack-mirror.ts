/**
 * slack-mirror — auto-post agent-to-agent bus messages to the #agents Slack
 * channel so humans can observe coordination without the agents having to
 * remember to copy it.
 *
 * Called from sendMessage() after the inbox write succeeds. Fire-and-forget;
 * if the Slack post fails (e.g., sender has no registered bot, secret missing,
 * Slack rate-limited), the inbox delivery still happens.
 *
 * The mirror post is attributed to the SENDING agent's Slack bot identity.
 * Format: `→ *Recipient*: first ~400 chars of the message`.
 *
 * Config:
 *   - SUPABASE_RGOS_URL + AGENT_BUS_SECRET (already set in agent .env for
 *     the outbound send-slack path)
 *   - AGENTS_CHANNEL_ID overrides the hardcoded #agents channel id
 *   - BUS_MIRROR_DISABLED=1 disables mirroring (useful during bulk migrations)
 */

import { sendSlack } from './send-slack.js';

const DEFAULT_AGENTS_CHANNEL_ID = 'C0AUJMTE94H';

function titleCase(name: string): string {
  return name
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

function truncate(text: string, max = 400): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '\u2026';
}

/**
 * Post a mirror of an agent→agent bus message to #agents.
 * Safe to call without awaiting; all errors are swallowed and logged at
 * debug level so the caller's sendMessage path is unaffected.
 */
export async function mirrorAgentBusToSlack(
  from: string,
  to: string,
  text: string,
  opts?: { priority?: string; replyTo?: string | null },
): Promise<void> {
  if (process.env.BUS_MIRROR_DISABLED === '1') return;
  if (!process.env.SUPABASE_RGOS_URL) return;
  if (!process.env.AGENT_BUS_SECRET && !process.env.INTERNAL_CRON_SECRET) return;
  if (!from || !to || !text) return;

  const fromTitle = titleCase(from);
  const toTitle = titleCase(to);
  const channel = process.env.AGENTS_CHANNEL_ID || DEFAULT_AGENTS_CHANNEL_ID;

  // Build the mirror line. Use Slack's bold + arrow for scan-ability.
  const priorityTag = opts?.priority && opts.priority !== 'normal' ? ` [${opts.priority}]` : '';
  const replyTag = opts?.replyTo ? ' (reply)' : '';
  const preview = truncate(text, 400);
  const mirrorText = `\u2192 *${toTitle}*${priorityTag}${replyTag}: ${preview}`;

  try {
    const result = await sendSlack(channel, mirrorText, { agent: fromTitle });
    if (!result.ok && process.env.DEBUG_BUS_MIRROR === '1') {
      console.error(`[bus-mirror] post to ${channel} failed: ${result.error}`);
    }
  } catch (err) {
    if (process.env.DEBUG_BUS_MIRROR === '1') {
      console.error(`[bus-mirror] threw: ${err instanceof Error ? err.message : err}`);
    }
  }
}
