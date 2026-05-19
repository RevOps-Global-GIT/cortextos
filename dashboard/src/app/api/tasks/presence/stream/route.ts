import { auth } from '@/lib/auth';
import type { AgentPresencePayload } from '@/lib/agent-presence';
import { isAgentPresencePayload } from '@/lib/agent-presence';
import { jwtVerify } from 'jose';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CHANNEL = 'agent-presence';
const TOPIC = `realtime:${CHANNEL}`;
const HEARTBEAT_INTERVAL_MS = 25_000;

function getRealtimeConfig() {
  const url = process.env.SUPABASE_RGOS_URL || process.env.RGOS_SUPABASE_URL || process.env.SUPABASE_URL;
  const key =
    process.env.SUPABASE_RGOS_SERVICE_KEY ||
    process.env.RGOS_SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return { url, key };
}

function realtimeWebSocketUrl(url: string, key: string) {
  const wsUrl = new URL('/realtime/v1/websocket', url);
  wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  wsUrl.searchParams.set('apikey', key);
  wsUrl.searchParams.set('vsn', '1.0.0');
  return wsUrl;
}

async function hasBearerAuth(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) return false;

  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!secret) return false;

  try {
    await jwtVerify(authHeader.slice(7), new TextEncoder().encode(secret));
    return true;
  } catch {
    return false;
  }
}

export function extractAgentPresencePayload(raw: string): AgentPresencePayload | null {
  const frame = JSON.parse(raw) as unknown;
  const event = Array.isArray(frame) ? frame[3] : (frame as { event?: unknown }).event;
  const payload = Array.isArray(frame) ? frame[4] : (frame as { payload?: unknown }).payload;

  if (event === 'presence_update' && isAgentPresencePayload(payload)) {
    return payload;
  }

  if (event !== 'broadcast' || !payload || typeof payload !== 'object') {
    return null;
  }

  const broadcast = payload as { event?: unknown; payload?: unknown; type?: unknown };
  if (broadcast.event !== 'presence_update' || broadcast.type !== 'broadcast') {
    return null;
  }

  return isAgentPresencePayload(broadcast.payload) ? broadcast.payload : null;
}

export async function GET(request: Request) {
  const session = await auth();
  if (!session && !(await hasBearerAuth(request))) {
    return new Response('Unauthorized', { status: 401 });
  }

  const config = getRealtimeConfig();
  if (!config) {
    return new Response('Supabase realtime is not configured', { status: 503 });
  }

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      let ref = 1;
      let socket: WebSocket | null = null;
      let heartbeat: ReturnType<typeof setInterval> | null = null;

      function sendSse(data: string) {
        controller.enqueue(encoder.encode(data));
      }

      function sendSocket(event: string, topic: string, payload: Record<string, unknown> = {}) {
        if (!socket || socket.readyState !== WebSocket.OPEN) return;
        socket.send(JSON.stringify({ topic, event, payload, ref: String(ref++) }));
      }

      function close() {
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = null;
        socket?.close();
        socket = null;
      }

      sendSse(': connected\n\n');

      try {
        socket = new WebSocket(realtimeWebSocketUrl(config.url, config.key), ['realtime']);

        socket.addEventListener('open', () => {
          sendSocket('phx_join', TOPIC, {
            config: {
              broadcast: { self: false, ack: false },
              presence: { key: '' },
              postgres_changes: [],
            },
          });
          heartbeat = setInterval(() => {
            sendSocket('heartbeat', 'phoenix');
            sendSse(': heartbeat\n\n');
          }, HEARTBEAT_INTERVAL_MS);
        });

        socket.addEventListener('message', (event) => {
          try {
            const payload = extractAgentPresencePayload(String(event.data));
            if (!payload) return;
            sendSse(`data: ${JSON.stringify(payload)}\n\n`);
          } catch {
            // Ignore malformed realtime frames.
          }
        });

        socket.addEventListener('close', () => {
          close();
          try {
            controller.close();
          } catch {
            // Client is already gone.
          }
        });

        socket.addEventListener('error', () => {
          close();
          try {
            controller.error(new Error('Supabase realtime connection failed'));
          } catch {
            // Client is already gone.
          }
        });
      } catch (error) {
        close();
        controller.error(error);
      }

      request.signal.addEventListener('abort', () => {
        close();
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
