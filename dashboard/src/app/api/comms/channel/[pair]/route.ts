import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getCTXRoot } from '@/lib/config';
import { resolveIdentity, buildPairKey } from '@/lib/comms-identity';

export const dynamic = 'force-dynamic';

interface BusMessage {
  id: string;
  from: string;
  to: string;
  priority: string;
  timestamp: string;
  text: string;
  reply_to: string | null;
  /** Optional origin marker — set when the message came from a Telegram voice
   *  note so the UI can render a microphone indicator next to the transcript. */
  media_type?: string;
}

interface SupabaseMessage {
  id: string;
  from_agent: string;
  to_agent: string;
  body: string;
  created_at: string;
  message_type: string | null;
  reply_to_id: string | null;
  payload: Record<string, unknown> | null;
}

/**
 * Query agent↔agent message history from Supabase cortex_messages table.
 * Returns messages bidirectionally for the given agent pair, ordered by
 * created_at ascending (oldest first for chat view), limited to maxRows.
 */
async function fetchAgentPairFromSupabase(
  a1: string,
  a2: string,
  maxRows: number,
  before?: string | null,
): Promise<BusMessage[]> {
  const supabaseUrl = process.env.RGOS_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceKey = process.env.RGOS_SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    // Credentials not configured — return empty rather than crashing.
    return [];
  }

  // Bidirectional filter: (A→B) OR (B→A)
  // PostgREST: use `or` query param with parenthesised conditions
  const beforeFilter = before ? `&created_at=lt.${encodeURIComponent(before)}` : '';
  const orFilter = `(and(from_agent.eq.${a1},to_agent.eq.${a2}),and(from_agent.eq.${a2},to_agent.eq.${a1}))`;
  const url =
    `${supabaseUrl}/rest/v1/cortex_messages` +
    `?or=${encodeURIComponent(orFilter)}` +
    `&order=created_at.asc` +
    `&limit=${maxRows}` +
    beforeFilter;

  let rows: SupabaseMessage[];
  try {
    const res = await fetch(url, {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        Accept: 'application/json',
      },
      // Next.js: don't cache — always fresh
      cache: 'no-store',
    });
    if (!res.ok) {
      console.warn(`[comms-channel] Supabase query failed: ${res.status} ${res.statusText}`);
      return [];
    }
    rows = (await res.json()) as SupabaseMessage[];
  } catch (err) {
    console.warn('[comms-channel] Supabase fetch error:', err);
    return [];
  }

  return rows.map(row => ({
    id: row.id,
    from: row.from_agent,
    to: row.to_agent,
    priority: row.message_type ?? 'normal',
    timestamp: row.created_at,
    text: row.body ?? '',
    reply_to: row.reply_to_id ?? null,
    // Carry through media_type if stored in payload
    ...(row.payload?.media_type ? { media_type: String(row.payload.media_type) } : {}),
  }));
}

/**
 * GET /api/comms/channel/[pair] — Messages for a specific agent pair.
 * pair = "agent1--agent2" (alphabetically sorted).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ pair: string }> },
) {
  const { pair } = await params;
  const agents = pair.split('--');
  if (agents.length !== 2 || !agents.every(a => /^[a-z0-9_-]+$/.test(a))) {
    return Response.json({ error: 'Invalid pair format. Use agent1--agent2' }, { status: 400 });
  }

  const { searchParams } = request.nextUrl;
  const limit = Math.min(Math.max(parseInt(searchParams.get('limit') ?? '100', 10) || 100, 1), 500);
  const before = searchParams.get('before');
  const search = searchParams.get('search')?.toLowerCase().trim() || '';
  let searchRegex: RegExp | null = null;
  if (search) {
    try {
      searchRegex = new RegExp(`\\b${search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
    } catch { searchRegex = null; }
  }
  function matchesSearch(text: string): boolean {
    if (!search) return true;
    if (searchRegex) return searchRegex.test(text);
    return text.toLowerCase().includes(search);
  }

  const ctxRoot = getCTXRoot();
  const [a1, a2] = agents;

  // Resolve user identity so inbound and outbound Telegram messages
  // land in the same channel as bus messages for the same conversation.
  const identity = resolveIdentity(ctxRoot);

  const messages: BusMessage[] = [];
  const seen = new Set<string>();

  // ---------------------------------------------------------------------------
  // Primary source: Supabase cortex_messages (written by bus rgos-mirror).
  // This replaces the previous filesystem reads (message-history.jsonl +
  // inbox/processed scanning) which were never written by the bus.
  // ---------------------------------------------------------------------------
  const agentMessages = await fetchAgentPairFromSupabase(a1, a2, limit, before);
  for (const msg of agentMessages) {
    if (!matchesSearch(msg.text)) continue;
    seen.add(msg.id);
    messages.push(msg);
  }

  // ---------------------------------------------------------------------------
  // Telegram log fallback for human↔agent channels.
  //
  // Voice transcript dedup — Telegram voice notes produce two log entries
  // with the same message_id: a stub (empty text, written immediately on
  // delivery) and a transcript (full text + media_type, written after
  // Whisper/Gemini transcription completes). A naive iteration keeps
  // whichever entry appears first, which is the empty stub.
  //
  // Two-pass approach: first pass builds a bestByMsgId map where entries
  // with non-empty text always beat empty stubs sharing the same id.
  // Second pass emits only the winners. Applies to inbound and outbound.
  // ---------------------------------------------------------------------------
  const logsBase = path.join(ctxRoot, 'logs');
  if (fs.existsSync(logsBase)) {
    interface RawTelegramEntry {
      id: string;
      from: string;
      to: string;
      priority: string;
      timestamp: string;
      text: string;
      reply_to: null;
      media_type?: string;
    }
    for (const agent of [a1, a2]) {
      for (const logFile of ['inbound-messages.jsonl', 'outbound-messages.jsonl']) {
        const filePath = path.join(logsBase, agent, logFile);
        if (!fs.existsSync(filePath)) continue;
        const bestByMsgId = new Map<string, RawTelegramEntry>();
        try {
          const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
          const isInbound = logFile.startsWith('inbound');
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const raw = JSON.parse(line);
              if (!raw.timestamp) continue;
              const msgId = `tg-${isInbound ? 'in' : 'out'}-${agent}-${raw.message_id || raw.timestamp}`;
              if (seen.has(msgId)) continue;

              // Resolve both sides through the identity layer so inbound
              // (user→agent) and outbound (agent→user) land in the same channel.
              const fromName = isInbound ? identity.canonicalUser : agent;
              const toName = isInbound ? agent : identity.canonicalUser;
              const msgPair = buildPairKey(fromName, toName, identity);
              if (msgPair !== pair) continue;

              // Build the candidate. Text may be empty here — that is fine
              // for the dedup map, the second-pass write-out only emits
              // entries that actually have text.
              const candidate: RawTelegramEntry = {
                id: msgId,
                from: fromName,
                to: toName,
                priority: 'normal',
                timestamp: raw.timestamp,
                text: raw.text || raw.transcript || '',
                reply_to: null,
                ...(raw.media_type ? { media_type: raw.media_type } : {}),
              };

              const existing = bestByMsgId.get(msgId);
              if (!existing) {
                bestByMsgId.set(msgId, candidate);
              } else if (!existing.text && candidate.text) {
                // Upgrade: this entry has real text, the previous one was
                // a stub. Prefer this one. Also carry over media_type if
                // the upgrade brought it along.
                bestByMsgId.set(msgId, candidate);
              }
              // else: both have text, keep the first one (stable order).
              //       or both are stubs, no change.
            } catch { /* skip malformed line */ }
          }
        } catch { /* skip unreadable file */ }

        // Second pass: write the winners to the messages array, filtering
        // out any final entry that still has empty text (pure stubs with
        // no transcript ever arriving). Search filter applied here.
        for (const msg of bestByMsgId.values()) {
          if (!msg.text) continue;
          if (!matchesSearch(msg.text)) continue;
          if (before && msg.timestamp >= before) continue;
          seen.add(msg.id);
          messages.push(msg);
        }
      }
    }
  }

  // Sort by timestamp ascending (oldest first for chat view)
  messages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  return Response.json(messages.slice(-limit));
}
