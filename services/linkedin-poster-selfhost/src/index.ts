import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { readFileSync } from 'fs';
import type { PosterConfig } from './types.js';
import type {
  PostCommentRequest,
  SendConnectionRequest,
  SendDmRequest,
  PublishPostRequest,
} from './types.js';
import { BrowserManager } from './browser.js';
import {
  postLinkedInComment,
  sendConnectionRequest,
  sendDM,
  publishLinkedInPost,
  discoverLinkedInPosts,
} from './actions.js';
import { sendHeartbeat } from './heartbeat.js';
import { QueueConsumer } from './queue-consumer.js';

// ---------------------------------------------------------------------------
// Config from environment
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

const config: PosterConfig = {
  profileDir: process.env['PROFILE_DIR'] ?? '/var/lib/linkedin-poster/profiles/default',
  userId: process.env['USER_ID'] ?? 'default',
  senderUuid: requireEnv('SENDER_UUID'), // Supabase auth UUID — must be UUID, not string handle
  senderName: process.env['SENDER_NAME'] ?? 'LinkedIn Poster',
  senderLinkedInId: process.env['SENDER_LINKEDIN_ID'] ?? '',
  supabaseUrl: requireEnv('SUPABASE_URL'),
  supabaseKey: requireEnv('SUPABASE_KEY'),
  port: parseInt(process.env['PORT'] ?? '3100', 10),
};

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

const browser = new BrowserManager(config);
let inFlight = false;
let lastActionAt = 0;
const MIN_GAP_MS = 30_000;

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(json);
}

// ---------------------------------------------------------------------------
// Action guard
// ---------------------------------------------------------------------------

async function withActionGuard<T>(
  res: ServerResponse,
  handler: () => Promise<T>
): Promise<void> {
  if (inFlight) {
    send(res, 429, { success: false, error: 'Another action is in flight' });
    return;
  }
  const now = Date.now();
  const gap = now - lastActionAt;
  if (lastActionAt > 0 && gap < MIN_GAP_MS) {
    send(res, 429, {
      success: false,
      error: `Rate limited — wait ${Math.ceil((MIN_GAP_MS - gap) / 1000)}s`,
    });
    return;
  }
  inFlight = true;
  try {
    const result = await handler();
    lastActionAt = Date.now();
    send(res, 200, result);
  } catch (err) {
    send(res, 500, { success: false, error: (err as Error).message });
  } finally {
    inFlight = false;
  }
}

// ---------------------------------------------------------------------------
// Request router
// ---------------------------------------------------------------------------

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url ?? '/';
  const method = req.method ?? 'GET';

  // Health / readiness
  if (url === '/health' && method === 'GET') {
    const healthy = await browser.checkHealth();
    send(res, healthy ? 200 : 503, { ok: healthy, userId: config.userId });
    return;
  }

  if (method !== 'POST') {
    send(res, 405, { error: 'Method not allowed' });
    return;
  }

  let body: unknown;
  try {
    body = await readBody(req);
  } catch {
    send(res, 400, { error: 'Invalid JSON' });
    return;
  }

  const page = browser.getPage();

  switch (url) {
    case '/comment': {
      const { postUrl, commentText } = body as PostCommentRequest;
      await withActionGuard(res, () => postLinkedInComment(page, postUrl, commentText));
      break;
    }
    case '/connect': {
      const { profileUrl, noteText } = body as SendConnectionRequest;
      await withActionGuard(res, () => sendConnectionRequest(page, profileUrl, noteText));
      break;
    }
    case '/dm': {
      const { profileUrl, messageText } = body as SendDmRequest;
      await withActionGuard(res, () => sendDM(page, profileUrl, messageText));
      break;
    }
    case '/post': {
      const { postText, imagePaths } = body as PublishPostRequest;
      await withActionGuard(res, () => publishLinkedInPost(page, postText, imagePaths));
      break;
    }
    case '/discover-posts': {
      const { keywords, limit } = body as { keywords?: string[]; limit?: number };
      if (!Array.isArray(keywords) || keywords.length === 0) {
        send(res, 400, { error: 'keywords array required' });
        break;
      }
      if (inFlight) {
        send(res, 429, { error: 'Another action is in flight — retry in a moment' });
        break;
      }
      try {
        const posts = await discoverLinkedInPosts(page, keywords, limit ?? 10);
        send(res, 200, { posts, count: posts.length });
      } catch (err) {
        send(res, 500, { error: (err as Error).message });
      }
      break;
    }
    default:
      send(res, 404, { error: 'Not found' });
  }
}

// ---------------------------------------------------------------------------
// Engagement batch scheduler
// (Replaces engage-batch-local.mjs which ran on Mac via the LaunchAgent.
//  Fires at 6am and 12pm PT Mon-Fri — same windows as the old Mac scheduler.)
// ---------------------------------------------------------------------------

const DEFAULT_DISCOVERY_KEYWORDS = [
  'revenue operations strategy',
  'MQL definition',
  'marketing operations',
  'HubSpot workflows',
  'RevOps',
  'RevOps and AI',
  'lead scoring model',
  'sales marketing alignment B2B',
  'CRM data hygiene',
  'marketing ops strategy',
  'buying group automation',
  'revenue attribution model',
];

let lastBatchWindow = '';
let batchRunning = false;

async function pickBatchKeywords(supabaseUrl: string, supabaseKey: string, n: number): Promise<string[]> {
  const shuffle = <T>(arr: T[]): T[] => [...arr].sort(() => Math.random() - 0.5);
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/team_members?is_active_sender=eq.true&select=name,topic_keywords`,
      { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } },
    );
    if (!res.ok) throw new Error(`team_members ${res.status}`);
    const senders = await res.json() as Array<{ name: string; topic_keywords: string[] | null }>;
    const picked: string[] = [];
    for (const s of shuffle(senders)) {
      if (picked.length >= n) break;
      const ownKw = (s.topic_keywords ?? []).filter(k => !picked.includes(k));
      if (ownKw.length) picked.push(shuffle(ownKw)[0]);
    }
    const remaining = shuffle(DEFAULT_DISCOVERY_KEYWORDS.filter(k => !picked.includes(k)));
    while (picked.length < n && remaining.length) picked.push(remaining.shift()!);
    return picked;
  } catch {
    return shuffle(DEFAULT_DISCOVERY_KEYWORDS).slice(0, n);
  }
}

function startEngageBatchScheduler(): void {
  const BATCH_HOURS_PT = [6, 12];
  const CHECK_INTERVAL_MS = 5 * 60 * 1000;

  const tick = async () => {
    // Skip if another action or batch is already running
    if (inFlight || batchRunning) return;

    const nowPT = new Date(
      new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }),
    );
    const dayPT = nowPT.getDay();
    const hourPT = nowPT.getHours();
    const minutePT = nowPT.getMinutes();

    // Weekdays only, within the first 5 minutes of a target hour
    if (dayPT === 0 || dayPT === 6) return;
    if (!BATCH_HOURS_PT.includes(hourPT) || minutePT > 5) return;

    const windowKey = `${nowPT.toDateString()}-${hourPT}`;
    if (lastBatchWindow === windowKey) return;

    console.log(`[engage-batch-sched] Firing window ${windowKey}`);
    batchRunning = true;
    inFlight = true; // hold the browser page for discovery navigation
    lastBatchWindow = windowKey;

    // Hygiene: mark pending drafts older than 7 days as skipped — past the engagement window.
    try {
      const staleCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const hygieneRes = await fetch(
        `${config.supabaseUrl}/rest/v1/linkedin_engagement_queue?status=eq.pending&session_date=lt.${staleCutoff}`,
        {
          method: 'PATCH',
          headers: {
            apikey: config.supabaseKey,
            Authorization: `Bearer ${config.supabaseKey}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal',
          },
          body: JSON.stringify({ status: 'skipped', skip_reason: 'stale: >7 days past engagement window' }),
        },
      );
      if (hygieneRes.ok) {
        console.log(`[engage-batch-sched] Hygiene: marked stale pending drafts as skipped (cutoff ${staleCutoff})`);
      }
    } catch (err) {
      console.warn(`[engage-batch-sched] Hygiene cleanup failed: ${(err as Error).message}`);
    }

    try {
      const keywords = await pickBatchKeywords(config.supabaseUrl, config.supabaseKey, 4);
      console.log(`[engage-batch-sched] Keywords: ${keywords.join(', ')}`);

      const page = browser.getPage();
      const posts = await discoverLinkedInPosts(page, keywords, 10);
      console.log(`[engage-batch-sched] Discovered ${posts.length} posts`);
      lastActionAt = Date.now(); // reset cooldown after navigation

      if (posts.length === 0) {
        console.log('[engage-batch-sched] No posts found — skipping edge function call');
        return;
      }

      const BATCH_SIZE = 3;
      let totalGenerated = 0;

      for (let i = 0; i < posts.length; i += BATCH_SIZE) {
        const batch = posts.slice(i, i + BATCH_SIZE);
        console.log(
          `[engage-batch-sched] Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.length} posts`,
        );
        try {
          const res = await fetch(`${config.supabaseUrl}/functions/v1/engage-batch-generate`, {
            method: 'POST',
            headers: {
              apikey: config.supabaseKey,
              Authorization: `Bearer ${config.supabaseKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ force: true, posts: batch }),
            signal: AbortSignal.timeout(180_000),
          });

          if (!res.ok) {
            const errText = await res.text().catch(() => '');
            console.error(`[engage-batch-sched] Edge fn failed: ${res.status} ${errText.slice(0, 200)}`);
            continue;
          }

          const result = await res.json() as { generated?: number; errors?: string[] };
          totalGenerated += result.generated ?? 0;
          console.log(
            `[engage-batch-sched] Generated: ${result.generated ?? 0}, errors: ${(result.errors ?? []).length}`,
          );
          if (result.errors?.length) result.errors.forEach(e => console.log(`  ${e}`));
        } catch (err) {
          console.error(`[engage-batch-sched] Batch error: ${(err as Error).message}`);
        }

        if (i + BATCH_SIZE < posts.length) {
          await new Promise(r => setTimeout(r, 2000));
        }
      }

      console.log(`[engage-batch-sched] Done: ${totalGenerated} total drafts generated`);
    } catch (err) {
      console.error(`[engage-batch-sched] Error: ${(err as Error).message}`);
    } finally {
      inFlight = false;
      batchRunning = false;
    }
  };

  // First check after 30s (give server time to fully start), then every 5min
  setTimeout(() => { void tick(); }, 30_000);
  setInterval(() => { void tick(); }, CHECK_INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// Queue consumer (engagement + RPC jobs)
// ---------------------------------------------------------------------------

function startQueueConsumer(): QueueConsumer {
  const consumer = new QueueConsumer(config);
  consumer.start();
  return consumer;
}

// ---------------------------------------------------------------------------
// Heartbeat loop
// ---------------------------------------------------------------------------

async function runHeartbeatLoop(): Promise<void> {
  const INTERVAL_MS = 60_000;

  const tick = async () => {
    try {
      const healthy = await browser.checkHealth();
      await sendHeartbeat(config, {
        agentName: `linkedin-poster-selfhost-${config.userId}`,
        browserHealthy: healthy,
        status: inFlight ? 'busy' : 'idle',
        profilePath: config.profileDir,
        metadata: { senderName: config.senderName, lastActionAt },
      });
    } catch (err) {
      console.error('[heartbeat-loop] Error:', (err as Error).message);
    }
  };

  await tick(); // immediate first beat
  setInterval(tick, INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await browser.init();

  const queue = startQueueConsumer();

  const server = createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error('[server] Unhandled error:', err);
      res.writeHead(500).end('Internal server error');
    });
  });

  server.listen(config.port, () => {
    console.log(`[server] linkedin-poster-selfhost listening on :${config.port}`);
    console.log(`[server] userId=${config.userId} profileDir=${config.profileDir}`);
  });

  await runHeartbeatLoop();

  // Engagement batch scheduler — replaces engage-batch-local.mjs on Mac
  startEngageBatchScheduler();

  // Graceful shutdown
  const shutdown = async () => {
    console.log('[server] Shutting down...');
    queue.stop();
    server.close();
    await browser.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('[main] Fatal:', err);
  process.exit(1);
});
