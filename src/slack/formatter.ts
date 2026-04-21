/**
 * formatSlackTextMessage — format an inbound Slack message for Claude Code
 * stdin injection. Mirrors FastChecker.formatTelegramTextMessage so the
 * agent sees Slack messages in a structurally identical shape and already
 * knows how to respond.
 *
 * The reply tool that Claude will invoke to respond:
 *   cortextos bus send-slack <channel> '<reply>' [--thread-ts <ts>] [--inbox-id <id>]
 *
 * --inbox-id is included so the agent-slack-post edge function can mark the
 * corresponding agent_slack_inbox row processed with the reply's Slack ts.
 *
 * Use [USER: ...] to prevent prompt-injection via crafted display names.
 */

import type { SlackInboxRow } from './poller.js';

export interface SlackFormatOptions {
  // When we can derive a compact recent-history string, include it. Optional.
  recentHistory?: string;
}

export function formatSlackTextMessage(row: SlackInboxRow, opts?: SlackFormatOptions): string {
  const from = stripControlChars(row.from_slack_user ?? row.slack_user_id ?? 'Unknown');
  const channel = row.slack_channel_id;
  const isDM = row.channel_type === 'im';
  // Thread anchor: prefer explicit thread_ts (reply in thread) else the message's own ts.
  const threadTs = row.slack_thread_ts ?? row.slack_ts;

  let replyCx = '';
  if (row.reply_to_text) {
    replyCx = `[Replying to: "${row.reply_to_text.slice(0, 500)}"]\n`;
  }

  let historyCx = '';
  if (opts?.recentHistory) {
    historyCx = `[Recent conversation:]\n${opts.recentHistory}\n`;
  }

  const contextLabel = isDM
    ? `DM from [USER: ${from}]`
    : `Slack ${row.event_type === 'app_mention' ? '@mention' : 'message'} from [USER: ${from}] (channel:${channel})`;

  const replyCmd =
    `cortextos bus send-slack ${channel} '<your reply>' ` +
    `--thread-ts ${threadTs} --inbox-id ${row.id}`;

  const body = `\`\`\`\n${stripControlChars(row.text)}\n\`\`\``;

  return `=== SLACK ${contextLabel} ===
${replyCx}${historyCx}${body}
Reply using: ${replyCmd}

`;
}

function stripControlChars(s: string): string {
  // Strip ASCII control chars other than \n \t which are fine to keep in prompts.
  // deno-lint-ignore no-control-regex
  return s.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '');
}
