import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import type { BusPaths } from '../types/index.js';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { randomString } from '../utils/random.js';
import { validateAgentName } from '../utils/validate.js';
import { sendMessage } from './message.js';
import { createDispatchToken } from './token.js';

export type WhisperMode = 'silent' | 'manual_forward';

export interface VoiceSettings {
  whisper?: {
    enabled?: boolean;
    mode?: WhisperMode;
    timeout_ms?: number;
    participants?: string[];
    manual_forward_only?: boolean;
    summarize_max_messages?: number;
  };
}

export interface ResolvedVoiceSettings {
  enabled: boolean;
  mode: WhisperMode;
  timeout_ms: number;
  participants: string[];
  manual_forward_only: boolean;
  summarize_max_messages: number;
  source_path: string | null;
}

export interface WhisperMessage {
  id: string;
  room_id: string;
  from: string;
  to: string;
  text: string;
  timestamp: string;
  dispatch_token: string;
  bus_message_id: string;
}

export interface WhisperSession {
  room_id: string;
  participants: string[];
  created_at: string;
  updated_at: string;
  expires_at: string;
  status: 'open' | 'closed' | 'timeout';
  mode: WhisperMode;
  closed_at?: string;
  close_reason?: string;
}

const DEFAULT_SETTINGS: ResolvedVoiceSettings = {
  enabled: true,
  mode: 'silent',
  timeout_ms: 5 * 60 * 1000,
  participants: ['codex-talk', 'analyst-talk'],
  manual_forward_only: true,
  summarize_max_messages: 20,
  source_path: null,
};

function parseSettings(raw: string, sourcePath: string): ResolvedVoiceSettings {
  const parsed = JSON.parse(raw) as VoiceSettings;
  const whisper = parsed.whisper || {};
  const mode = whisper.mode === 'manual_forward' ? 'manual_forward' : 'silent';
  const timeoutMs = Number(whisper.timeout_ms);
  const summarizeMaxMessages = Number(whisper.summarize_max_messages);

  return {
    enabled: whisper.enabled !== false,
    mode,
    timeout_ms: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_SETTINGS.timeout_ms,
    participants: Array.isArray(whisper.participants) && whisper.participants.length > 0
      ? whisper.participants.filter((p): p is string => typeof p === 'string' && p.length > 0)
      : DEFAULT_SETTINGS.participants,
    manual_forward_only: whisper.manual_forward_only !== false,
    summarize_max_messages: Number.isFinite(summarizeMaxMessages) && summarizeMaxMessages > 0
      ? summarizeMaxMessages
      : DEFAULT_SETTINGS.summarize_max_messages,
    source_path: sourcePath,
  };
}

export function readVoiceSettings(paths: BusPaths, agentDir?: string): ResolvedVoiceSettings {
  const candidates = [
    agentDir ? join(agentDir, 'voice-settings.json') : '',
    join(paths.ctxRoot, 'config', 'voice-settings.json'),
    join(paths.ctxRoot, 'voice-settings.json'),
    join(process.cwd(), 'voice-settings.json'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      return parseSettings(readFileSync(candidate, 'utf-8'), candidate);
    } catch {
      continue;
    }
  }

  return { ...DEFAULT_SETTINGS };
}

export function whisperRoomId(a: string, b: string): string {
  validateAgentName(a);
  validateAgentName(b);
  return [a, b].sort().join('__');
}

function roomsRoot(paths: BusPaths): string {
  return join(paths.ctxRoot, 'whisper-rooms');
}

function roomDir(paths: BusPaths, roomId: string): string {
  return join(roomsRoot(paths), roomId);
}

function messagesDir(paths: BusPaths, roomId: string): string {
  return join(roomDir(paths, roomId), 'messages');
}

function sessionPath(paths: BusPaths, roomId: string): string {
  return join(roomDir(paths, roomId), 'session.json');
}

function readSession(paths: BusPaths, roomId: string): WhisperSession | null {
  const file = sessionPath(paths, roomId);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as WhisperSession;
  } catch {
    return null;
  }
}

function writeSession(paths: BusPaths, session: WhisperSession): void {
  atomicWriteSync(sessionPath(paths, session.room_id), JSON.stringify(session, null, 2));
}

function ensureSession(paths: BusPaths, roomId: string, participants: string[], settings: ResolvedVoiceSettings, timeoutMs?: number): WhisperSession {
  ensureDir(messagesDir(paths, roomId));
  const now = new Date();
  const existing = readSession(paths, roomId);
  const expiresAt = new Date(now.getTime() + (timeoutMs || settings.timeout_ms)).toISOString();

  const session: WhisperSession = existing && existing.status === 'open'
    ? {
        ...existing,
        participants: Array.from(new Set([...existing.participants, ...participants])),
        updated_at: now.toISOString(),
        expires_at: expiresAt,
        mode: settings.mode,
      }
    : {
        room_id: roomId,
        participants: Array.from(new Set(participants)),
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
        expires_at: expiresAt,
        status: 'open',
        mode: settings.mode,
      };

  writeSession(paths, session);
  return session;
}

export function sendWhisper(
  paths: BusPaths,
  from: string,
  to: string,
  text: string,
  opts: { roomId?: string; timeoutMs?: number; agentDir?: string } = {},
): WhisperMessage {
  validateAgentName(from);
  validateAgentName(to);
  if (!text.trim()) throw new Error('Whisper text cannot be empty');

  const settings = readVoiceSettings(paths, opts.agentDir);
  if (!settings.enabled) throw new Error('Whisper mode is disabled in voice-settings.json');

  const roomId = opts.roomId || whisperRoomId(from, to);
  const session = ensureSession(paths, roomId, [from, to], settings, opts.timeoutMs);
  if (session.status !== 'open') throw new Error(`Whisper room ${roomId} is ${session.status}`);

  const dispatch = createDispatchToken('whisper');
  const busText = `[whisper:${roomId}] ${text}`;
  const busMessageId = sendMessage(paths, from, to, 'low', busText, undefined, dispatch.token);
  const timestamp = new Date().toISOString();
  const message: WhisperMessage = {
    id: `${Date.now()}-${from}-${randomString(6)}`,
    room_id: roomId,
    from,
    to,
    text,
    timestamp,
    dispatch_token: dispatch.token,
    bus_message_id: busMessageId,
  };

  const file = join(messagesDir(paths, roomId), `${timestamp.replace(/[-:.TZ]/g, '')}-${message.id}.json`);
  atomicWriteSync(file, JSON.stringify(message, null, 2));
  writeSession(paths, { ...session, updated_at: timestamp });
  return message;
}

export function readWhispers(paths: BusPaths, roomId: string): WhisperMessage[] {
  const dir = messagesDir(paths, roomId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .flatMap((file) => {
      try {
        return [JSON.parse(readFileSync(join(dir, file), 'utf-8')) as WhisperMessage];
      } catch {
        return [];
      }
    });
}

export function summarizeWhisperRoom(paths: BusPaths, roomId: string, maxMessages?: number): string {
  const settings = readVoiceSettings(paths);
  const limit = maxMessages || settings.summarize_max_messages;
  const session = readSession(paths, roomId);
  const messages = readWhispers(paths, roomId);
  const recent = messages.slice(-limit);
  const header = `Whisper room ${roomId}: ${messages.length} message(s), status ${session?.status || 'missing'}`;
  if (recent.length === 0) return header;
  return [
    header,
    ...recent.map((msg) => `- ${msg.timestamp} ${msg.from} -> ${msg.to}: ${msg.text}`),
  ].join('\n');
}

export function closeWhisperRoom(paths: BusPaths, roomId: string, reason = 'manual'): WhisperSession {
  const existing = readSession(paths, roomId);
  if (!existing) throw new Error(`Whisper room ${roomId} does not exist`);
  const now = new Date().toISOString();
  const status: WhisperSession['status'] = reason === 'timeout' ? 'timeout' : 'closed';
  const closed = {
    ...existing,
    status,
    updated_at: now,
    closed_at: now,
    close_reason: reason,
  };
  writeSession(paths, closed);
  return closed;
}

export async function watchWhisperRoom(
  paths: BusPaths,
  roomId: string,
  opts: { timeoutMs?: number; pollMs?: number; summarize?: boolean } = {},
): Promise<{ room_id: string; status: WhisperSession['status']; message_count: number; summary?: string }> {
  const settings = readVoiceSettings(paths);
  const timeoutMs = opts.timeoutMs || settings.timeout_ms;
  const pollMs = opts.pollMs || 1000;
  const started = Date.now();
  const dir = messagesDir(paths, roomId);
  mkdirSync(dir, { recursive: true });
  if (!readSession(paths, roomId)) {
    const inferredParticipants = roomId.includes('__') ? roomId.split('__').filter(Boolean) : settings.participants;
    ensureSession(paths, roomId, inferredParticipants, settings, timeoutMs);
  }

  while (Date.now() - started < timeoutMs) {
    const session = readSession(paths, roomId);
    if (session && session.status !== 'open') {
      const messages = readWhispers(paths, roomId);
      return {
        room_id: roomId,
        status: session.status,
        message_count: messages.length,
        ...(opts.summarize ? { summary: summarizeWhisperRoom(paths, roomId) } : {}),
      };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  const closed = closeWhisperRoom(paths, roomId, 'timeout');
  const messages = readWhispers(paths, roomId);
  return {
    room_id: roomId,
    status: closed.status,
    message_count: messages.length,
    ...(opts.summarize ? { summary: summarizeWhisperRoom(paths, roomId) } : {}),
  };
}

export function whisperRoomLastActivity(paths: BusPaths, roomId: string): string | null {
  const dir = messagesDir(paths, roomId);
  if (!existsSync(dir)) return null;
  const mtimes = readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => statSync(join(dir, file)).mtimeMs)
    .sort((a, b) => b - a);
  return mtimes[0] ? new Date(mtimes[0]).toISOString() : null;
}
