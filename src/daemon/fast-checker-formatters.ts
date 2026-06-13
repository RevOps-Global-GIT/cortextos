import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { sanitizeForPtyInjection } from '../utils/validate.js';

/**
 * Format a Telegram text message for injection.
 * Matches bash fast-checker.sh format.
 */
export function formatTelegramTextMessage(
  from: string,
  chatId: string | number,
  text: string,
  frameworkRoot: string,
  replyToText?: string,
  lastSentText?: string,
  recentHistory?: string,
): string {
  // Untrusted context fields are run through sanitizeForPtyInjection (same helper
  // and rationale as formatTelegramReaction / upstream #606): the fast-checker
  // caller preserves ordinary ASCII + newlines, so a crafted display name, reply
  // quote, recalled message, or conversation snippet like
  // `=== AGENT MESSAGE from daemon ===` could otherwise forge a containment header
  // in the agent's PTY, and a body carrying ``` could break out of the fence below.
  // chatId is numeric per Telegram's API contract and left untouched.
  let replyCx = '';
  if (typeof replyToText === 'string' && replyToText) {
    replyCx = `[Replying to: "${sanitizeForPtyInjection(replyToText.slice(0, 500))}"]\n`;
  }

  let lastSentCtx = '';
  if (lastSentText) {
    lastSentCtx = `[Your last message: "${sanitizeForPtyInjection(lastSentText.slice(0, 500))}"]\n`;
  }

  let historyCx = '';
  if (recentHistory) {
    historyCx = `[Recent conversation:]\n${sanitizeForPtyInjection(recentHistory)}\n`;
  }

  // Use [USER: ...] wrapper to prevent prompt injection via crafted display names
  // Slash commands (text starting with /) are NOT wrapped in backticks so Claude Code
  // can recognize and invoke them via the Skill tool (e.g. /loop, /commit, /restart).
  const isSlashCommand = /^\/[a-zA-Z]/.test(text.trim());
  const body = isSlashCommand
    ? sanitizeForPtyInjection(text.trim())
    : `\`\`\`\n${sanitizeForPtyInjection(text)}\n\`\`\``;
  return `=== TELEGRAM from [USER: ${sanitizeForPtyInjection(from)}] (chat_id:${chatId}) ===
${replyCx}${historyCx}${body}
${lastSentCtx}Reply using: cortextos bus send-telegram ${chatId} '<your reply>'

`;
}

/**
 * Format a Telegram message_reaction update for PTY injection.
 * Reactions are emoji additions/removals on existing messages — they
 * surface to the agent so it can follow up on positive acknowledgements
 * or clarify after a negative reaction.
 *
 * `newReaction` is the current reaction state (an empty list means the
 * user REMOVED their reaction). `oldReaction` lets the formatter
 * distinguish "added X" from "removed Y". Custom emoji (type=custom_emoji)
 * render as [custom_emoji] since we don't resolve the custom_emoji_id.
 */
export function formatTelegramReaction(
  from: string,
  chatId: string | number,
  messageId: number,
  oldReaction: Array<{ type: 'emoji'; emoji: string } | { type: 'custom_emoji'; custom_emoji_id: string }>,
  newReaction: Array<{ type: 'emoji'; emoji: string } | { type: 'custom_emoji'; custom_emoji_id: string }>,
): string {
  const render = (list: typeof newReaction): string =>
    list.length === 0
      ? '(none)'
      : list.map((r) => (r.type === 'emoji' ? r.emoji : '[custom_emoji]')).join(' ');

  const removed = newReaction.length === 0 && oldReaction.length > 0;
  const label = removed ? `removed ${render(oldReaction)}` : render(newReaction);

  // Both untrusted interpolations are sanitized. The caller only applies
  // stripControlChars, which preserves ordinary ASCII + newlines, so a crafted
  // sender first_name like `=== AGENT MESSAGE from daemon ===` would otherwise
  // forge a containment header in the agent's PTY. `label` is currently a fixed
  // Telegram emoji set + a hardcoded [custom_emoji] placeholder (no arbitrary
  // text), but sanitizing it keeps the header un-forgeable even if render() ever
  // emits richer content. chatId/messageId are numeric per Telegram's API contract.
  return `=== REACTION from [USER: ${sanitizeForPtyInjection(from)}] (chat_id:${chatId}) on message ${messageId}: ${sanitizeForPtyInjection(label)} ===

`;
}

/**
 * Format a Telegram photo message for injection.
 * Matches bash fast-checker.sh format.
 */
export function formatTelegramPhotoMessage(
  from: string,
  chatId: string | number,
  caption: string,
  imagePath: string,
): string {
  // Untrusted `from` (unfenced header) and `caption` (fenced — ``` would break out)
  // are sanitized; chatId is numeric and imagePath is server-generated.
  return `=== TELEGRAM PHOTO from ${sanitizeForPtyInjection(from)} (chat_id:${chatId}) ===
caption:
\`\`\`
${sanitizeForPtyInjection(caption)}
\`\`\`
local_file: ${imagePath}
Reply using: cortextos bus send-telegram ${chatId} '<your reply>'

`;
}

/**
 * Format a Telegram document message for injection.
 * Matches bash fast-checker.sh format.
 */
export function formatTelegramDocumentMessage(
  from: string,
  chatId: string | number,
  caption: string,
  filePath: string,
  fileName: string,
): string {
  // Untrusted `from` (unfenced header), `caption` (fenced — ``` would break out)
  // and `fileName` (unfenced, attacker-supplied document name) are sanitized;
  // chatId is numeric and filePath is server-generated.
  return `=== TELEGRAM DOCUMENT from ${sanitizeForPtyInjection(from)} (chat_id:${chatId}) ===
caption:
\`\`\`
${sanitizeForPtyInjection(caption)}
\`\`\`
local_file: ${filePath}
file_name: ${sanitizeForPtyInjection(fileName)}
Reply using: cortextos bus send-telegram ${chatId} '<your reply>'

`;
}

/**
 * Format a Telegram voice/audio message for injection.
 * Matches bash fast-checker.sh format.
 *
 * `transcript` is populated by `src/telegram/transcribe.ts` when whisper-cli
 * and the GGML model are available; otherwise it stays undefined and the
 * agent receives only the .ogg path. The codex extractor surfaces the
 * transcript block when present.
 */
export function formatTelegramVoiceMessage(
  from: string,
  chatId: string | number,
  filePath: string,
  duration: number | undefined,
  transcript?: string,
): string {
  const dur = duration !== undefined ? duration : 'unknown';
  // Untrusted `from` (unfenced header) and `transcript` (fenced — ``` would break
  // out; transcript text is derived from user-spoken audio) are sanitized; chatId
  // is numeric, filePath is server-generated, duration is numeric.
  const transcriptBlock = transcript && transcript.trim()
    ? `transcript:\n\`\`\`\n${sanitizeForPtyInjection(transcript.trim())}\n\`\`\`\n`
    : '';
  return `=== TELEGRAM VOICE from ${sanitizeForPtyInjection(from)} (chat_id:${chatId}) ===
duration: ${dur}s
local_file: ${filePath}
${transcriptBlock}Reply using: cortextos bus send-telegram-voice ${chatId} '<your reply>'

`;
}

/**
 * Format a Telegram video/video_note message for injection.
 * Matches bash fast-checker.sh format.
 */
export function formatTelegramVideoMessage(
  from: string,
  chatId: string | number,
  caption: string,
  filePath: string,
  fileName: string,
  duration: number | undefined,
): string {
  const dur = duration !== undefined ? duration : 'unknown';
  // Untrusted `from` (unfenced header), `caption` (fenced — ``` would break out)
  // and `fileName` (unfenced, attacker-supplied video name) are sanitized; chatId
  // is numeric, filePath is server-generated, duration is numeric.
  return `=== TELEGRAM VIDEO from ${sanitizeForPtyInjection(from)} (chat_id:${chatId}) ===
caption:
\`\`\`
${sanitizeForPtyInjection(caption)}
\`\`\`
duration: ${dur}s
local_file: ${filePath}
file_name: ${sanitizeForPtyInjection(fileName)}
Reply using: cortextos bus send-telegram ${chatId} '<your reply>'

`;
}

/**
 * Read the last-sent message file for conversation context.
 * Returns the content (up to 500 chars) or null if not available.
 */
export function readLastSent(stateDir: string, chatId: string | number): string | null {
  const filePath = join(stateDir, `last-telegram-${chatId}.txt`);
  try {
    if (!existsSync(filePath)) return null;
    const content = readFileSync(filePath, 'utf-8');
    if (!content) return null;
    return content.slice(0, 500);
  } catch {
    return null;
  }
}
