/**
 * Telegram message logging and last-sent context caching.
 * Matches the bash send-telegram.sh outbound logging (lines 100-108)
 * and last-sent cache (lines 111-113).
 */

import { appendFileSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { logEvent } from '../bus/event.js';
import type { BusPaths, TelegramMessage } from '../types/index.js';

/**
 * Optional metadata attached to an outbound Telegram message log entry.
 * Fields are all optional so existing callers that pass nothing still
 * produce the same JSONL shape as before this extension.
 *
 * - `parseMode`: which parse_mode the first send attempt used. "html"
 *   for the default path (Markdown-to-HTML conversion), "none" when the
 *   caller used --plain-text.
 */
export interface OutboundLogMetadata {
  parseMode?: 'html' | 'none';
}

/**
 * Append an outbound message to the agent's JSONL log.
 * Path: {ctxRoot}/logs/{agentName}/outbound-messages.jsonl
 */
export function logOutboundMessage(
  ctxRoot: string,
  agentName: string,
  chatId: string | number,
  text: string,
  messageId: number,
  metadata?: OutboundLogMetadata,
): void {
  const logDir = join(ctxRoot, 'logs', agentName);
  mkdirSync(logDir, { recursive: true });

  // Only emit metadata fields that were actually set so the base log shape
  // stays unchanged for callers that pass nothing (backwards compat).
  const meta: Record<string, unknown> = {};
  if (metadata?.parseMode !== undefined) meta.parse_mode = metadata.parseMode;

  const entry = JSON.stringify({
    timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    agent: agentName,
    chat_id: String(chatId),
    text,
    message_id: messageId,
    ...meta,
  });

  appendFileSync(join(logDir, 'outbound-messages.jsonl'), entry + '\n', 'utf-8');
}

/**
 * Append an inbound message to the agent's JSONL log.
 * Path: {ctxRoot}/logs/{agentName}/inbound-messages.jsonl
 */
export function logInboundMessage(
  ctxRoot: string,
  agentName: string,
  rawMessage: object,
): void {
  const logDir = join(ctxRoot, 'logs', agentName);
  mkdirSync(logDir, { recursive: true });

  const entry = JSON.stringify({
    ...rawMessage,
    archived_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    agent: agentName,
  });

  appendFileSync(join(logDir, 'inbound-messages.jsonl'), entry + '\n', 'utf-8');
}

/**
 * Persist an inbound Telegram message to the daemon's JSONL archive AND
 * emit a `message/telegram_received` bus event so dashboards and
 * experiment cycles can count fleet-wide inbound traffic. Symmetric with
 * `telegram_sent` emitted from the outbound path in `cortextos bus
 * send-telegram`.
 *
 * Wrapped: a logEvent failure (e.g. unwritable analytics dir) must not
 * break message processing — the logged inbound JSONL still goes through.
 */
export function recordInboundTelegram(
  paths: BusPaths,
  ctxRoot: string,
  agentName: string,
  org: string,
  fromName: string,
  msg: TelegramMessage,
  log?: (m: string) => void,
): void {
  const text = (msg.text || msg.caption || '').toString();
  logInboundMessage(ctxRoot, agentName, {
    message_id: msg.message_id,
    from: msg.from?.id,
    from_name: fromName,
    chat_id: msg.chat?.id,
    text,
    timestamp: new Date().toISOString(),
  });

  const hasMedia = !!(msg.photo || msg.document || msg.voice || msg.audio || msg.video || msg.video_note);
  try {
    logEvent(paths, agentName, org, 'message', 'telegram_received', 'info', {
      chat_id: String(msg.chat?.id ?? ''),
      message_id: msg.message_id,
      from_id: msg.from?.id,
      from_name: fromName,
      has_media: hasMedia,
      text_chars: text.length,
      text: text.slice(0, 200),
    });
  } catch (err) {
    log?.(`logEvent(telegram_received) failed: ${err}`);
  }

  try {
    recordDogfoodTelegramAudit(paths, ctxRoot, agentName, org, 'inbound', {
      chatId: String(msg.chat?.id ?? ''),
      messageId: msg.message_id,
      threadMessageId: msg.reply_to_message?.message_id ?? null,
      fromName,
      timestamp: msg.date ? new Date(msg.date * 1000).toISOString() : new Date().toISOString(),
      text,
    }, log);
  } catch (err) {
    log?.(`recordDogfoodTelegramAudit(inbound) failed: ${err}`);
  }
}

const DOGFOOD_RESULT_SOURCE_PATTERN = /\b(agentops|estate|ob1|orca|harned)\s+dogfood\b/i;
const DOGFOOD_RESULT_CONTEXT_PATTERN = /\bdogfood\b/i;
const DOGFOOD_RESULT_SIGNAL_PATTERN = /\b(pass|fail|failed|blocked|warn|warning|result|proof|report|artifact|scenario|runner|assert|p[0-9]|qa|smoke|audit)\b/i;

function isDogfoodResultText(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  return DOGFOOD_RESULT_SOURCE_PATTERN.test(normalized)
    || (DOGFOOD_RESULT_CONTEXT_PATTERN.test(normalized) && DOGFOOD_RESULT_SIGNAL_PATTERN.test(normalized));
}

function dogfoodAuditKey(agentName: string, direction: 'inbound' | 'outbound', chatId: string, messageId: string | number): string {
  return [
    'dogfood-telegram',
    agentName,
    direction,
    chatId || 'unknown-chat',
    String(messageId || 'unknown-message'),
  ].join(':');
}

function alreadyAuditedDogfoodResult(ctxRoot: string, agentName: string, key: string): boolean {
  const stateDir = join(ctxRoot, 'state', agentName);
  mkdirSync(stateDir, { recursive: true });
  const ledgerPath = join(stateDir, 'dogfood-telegram-audit.jsonl');
  if (existsSync(ledgerPath)) {
    const raw = readFileSync(ledgerPath, 'utf-8');
    if (raw.split('\n').some(line => line.includes(`"key":"${key}"`))) {
      return true;
    }
  }
  appendFileSync(ledgerPath, JSON.stringify({
    key,
    audited_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  }) + '\n', 'utf-8');
  return false;
}

export function recordOutboundDogfoodTelegramAudit(
  paths: BusPaths,
  ctxRoot: string,
  agentName: string,
  org: string,
  chatId: string | number,
  messageId: number,
  text: string,
  log?: (m: string) => void,
): void {
  recordDogfoodTelegramAudit(paths, ctxRoot, agentName, org, 'outbound', {
    chatId: String(chatId),
    messageId,
    threadMessageId: null,
    fromName: agentName,
    timestamp: new Date().toISOString(),
    text,
  }, log);
}

function recordDogfoodTelegramAudit(
  paths: BusPaths,
  ctxRoot: string,
  agentName: string,
  org: string,
  direction: 'inbound' | 'outbound',
  data: {
    chatId: string;
    messageId: number;
    threadMessageId: number | null;
    fromName: string;
    timestamp: string;
    text: string;
  },
  log?: (m: string) => void,
): void {
  if (!isDogfoodResultText(data.text)) return;

  const key = dogfoodAuditKey(agentName, direction, data.chatId, data.messageId);
  if (alreadyAuditedDogfoodResult(ctxRoot, agentName, key)) return;

  const metadata = {
    audit_key: key,
    telegram_agent: agentName,
    direction,
    chat_id: data.chatId,
    message_id: data.messageId,
    thread_message_id: data.threadMessageId,
    from_name: data.fromName,
    telegram_timestamp: data.timestamp,
    text_chars: data.text.length,
    text: data.text.slice(0, 1000),
  };

  try {
    logEvent(paths, agentName, org, 'message', 'dogfood_telegram_audited', 'info', metadata);
  } catch (err) {
    log?.(`logEvent(dogfood_telegram_audited) failed: ${err}`);
  }
}

/**
 * Cache the last-sent text for a given chat.
 * Path: {ctxRoot}/state/{agentName}/last-telegram-{chatId}.txt
 */
export function cacheLastSent(
  ctxRoot: string,
  agentName: string,
  chatId: string | number,
  text: string,
): void {
  const stateDir = join(ctxRoot, 'state', agentName);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, `last-telegram-${chatId}.txt`), text, 'utf-8');
}

/**
 * Read the last-sent text for a given chat, or null if not cached.
 */
export function readLastSent(
  ctxRoot: string,
  agentName: string,
  chatId: string | number,
): string | null {
  const filePath = join(ctxRoot, 'state', agentName, `last-telegram-${chatId}.txt`);
  if (!existsSync(filePath)) {
    return null;
  }
  return readFileSync(filePath, 'utf-8');
}

/**
 * Build a short recent conversation snippet for context injection.
 * Reads the last cputime         unlimited
filesize        unlimited
datasize        unlimited
stacksize       7MB


/**
 * Build a short recent conversation snippet for context injection.
 * Reads the last `limit` messages (combined inbound + outbound) for the
 * given agent/chatId, sorts by timestamp, and returns a formatted string.
 * Returns null if no history is available.
 */
export function buildRecentHistory(
  ctxRoot: string,
  agentName: string,
  chatId: string | number,
  limit: number = 6,
): string | null {
  const logDir = join(ctxRoot, 'logs', agentName);
  const inboundPath = join(logDir, 'inbound-messages.jsonl');
  const outboundPath = join(logDir, 'outbound-messages.jsonl');
  const chatIdStr = String(chatId);

  interface Entry { ts: string; speaker: string; text: string; }
  const entries: Entry[] = [];

  const readLines = (filePath: string, speaker: string) => {
    if (!existsSync(filePath)) return;
    try {
      const raw = readFileSync(filePath, 'utf-8').trim();
      if (!raw) return;
      const lines = raw.split('\n').filter(Boolean);
      const tail = lines.slice(-(limit * 2));
      for (const line of tail) {
        try {
          const obj = JSON.parse(line);
          if (String(obj.chat_id) !== chatIdStr) continue;
          const text = (obj.text || '').trim();
          if (!text) continue;
          entries.push({ ts: obj.timestamp || obj.archived_at || '', speaker, text });
        } catch { /* skip malformed */ }
      }
    } catch { /* skip unreadable */ }
  };

  readLines(inboundPath, process.env.ADMIN_USERNAME ?? 'user');
  readLines(outboundPath, agentName);

  if (entries.length === 0) return null;

  entries.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const recent = entries.slice(-limit);

  const formatted = recent.map(e => {
    const preview = e.text.length > 200 ? e.text.slice(0, 200) + '...' : e.text;
    return '[' + e.speaker + ']: ' + preview;
  });

  return formatted.join('\n');
}
