import { NextRequest } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { getFrameworkRoot, getCTXRoot, getAllAgents } from '@/lib/config';
import { IPCClient } from '@/lib/ipc-client';
import { getHeartbeat, getHealthStatus } from '@/lib/data/heartbeats';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_NAME = /^[a-z0-9_-]+$/;
const VALID_TEMPLATES = ['agent', 'agent-codex', 'orchestrator', 'analyst'];

// Stale cutoff: heartbeats older than 2 h are excluded from the Supabase fallback.
const SUPABASE_STALE_MS = 2 * 60 * 60 * 1000;
// Healthy cutoff: heartbeat within 15 min → 'healthy', otherwise 'stale'.
const SUPABASE_HEALTHY_MS = 15 * 60 * 1000;

interface SupabaseHeartbeatRow {
  agent_name: string;
  org: string;
  last_heartbeat: string;
  status: string;
  current_task: string;
}

/**
 * Fallback agent list from Supabase orch_agent_heartbeats.
 * Used when getAllAgents() returns empty (e.g. VM deployment that lacks the
 * org-fork filesystem but has agents writing heartbeats to Supabase).
 */
async function getAgentsFromSupabase(): Promise<Array<Record<string, unknown>>> {
  const url = (
    process.env.SUPABASE_RGOS_URL ||
    process.env.RGOS_SUPABASE_URL ||
    process.env.SUPABASE_URL ||
    ''
  ).replace(/\/$/, '');
  const key =
    process.env.SUPABASE_RGOS_SERVICE_KEY ||
    process.env.RGOS_SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) return [];

  try {
    const res = await fetch(
      `${url}/rest/v1/orch_agent_heartbeats?select=agent_name,org,last_heartbeat,status,current_task&order=last_heartbeat.desc`,
      {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!res.ok) {
      console.warn(`[api/agents] Supabase fallback HTTP ${res.status}`);
      return [];
    }
    const rows = (await res.json()) as SupabaseHeartbeatRow[];
    const now = Date.now();
    const seen = new Set<string>();
    return rows
      .filter((r) => {
        if (!r.agent_name || seen.has(r.agent_name)) return false;
        seen.add(r.agent_name);
        return now - new Date(r.last_heartbeat).getTime() < SUPABASE_STALE_MS;
      })
      .map((r) => ({
        name: r.agent_name,
        org: r.org || 'revops-global',
        health:
          now - new Date(r.last_heartbeat).getTime() < SUPABASE_HEALTHY_MS
            ? 'healthy'
            : 'stale',
        lastHeartbeat: r.last_heartbeat,
        currentTask: r.current_task || undefined,
        status: r.status || undefined,
      }));
  } catch (err) {
    console.warn('[api/agents] Supabase fallback error:', err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// GET /api/agents - List all agents
// ---------------------------------------------------------------------------

export async function GET() {
  try {
    const agents = getAllAgents();

    // When the filesystem scan returns no agents (e.g. VM deployment where the
    // org-fork agent dirs are absent), fall back to Supabase heartbeat data so
    // the Fleet/Agents roster still reflects the live fleet.
    if (agents.length === 0) {
      return Response.json(await getAgentsFromSupabase());
    }

    const enriched = await Promise.all(
      agents.map(async (agent) => {
        const hb = await getHeartbeat(agent.name);
        const health = hb ? getHealthStatus(hb) : 'down';
        return {
          ...agent,
          health,
          lastHeartbeat: hb?.last_heartbeat ?? undefined,
          currentTask: hb?.current_task ?? undefined,
          status: hb?.status ?? undefined,
        };
      })
    );
    return Response.json(enriched);
  } catch (err) {
    console.error('[api/agents] GET error:', err);
    return Response.json({ error: 'Failed to list agents' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// POST /api/agents - Create a new agent
//
// Body: { name, org, template, botToken, chatId, allowedUser? }
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { name, org, template, botToken, chatId, allowedUser } = body as {
    name?: string;
    org?: string;
    template?: string;
    botToken?: string;
    chatId?: string;
    allowedUser?: string;
  };

  // --- Validation ---

  if (!name || typeof name !== 'string') {
    return Response.json({ error: 'name is required' }, { status: 400 });
  }
  if (!VALID_NAME.test(name)) {
    return Response.json(
      { error: 'name must match /^[a-z0-9_-]+$/' },
      { status: 400 },
    );
  }
  if (!org || typeof org !== 'string') {
    return Response.json({ error: 'org is required' }, { status: 400 });
  }
  // Security (C4): Validate org against allowlist before use in path.join and shell commands.
  if (!VALID_NAME.test(org)) {
    return Response.json(
      { error: 'org must match /^[a-z0-9_-]+$/' },
      { status: 400 },
    );
  }
  if (!template || !VALID_TEMPLATES.includes(template)) {
    return Response.json(
      { error: `template must be one of: ${VALID_TEMPLATES.join(', ')}` },
      { status: 400 },
    );
  }
  if (!botToken || typeof botToken !== 'string') {
    return Response.json({ error: 'botToken is required' }, { status: 400 });
  }
  if (!chatId || typeof chatId !== 'string') {
    return Response.json({ error: 'chatId is required' }, { status: 400 });
  }

  const frameworkRoot = getFrameworkRoot();
  const ctxRoot = getCTXRoot();
  const enabledAgentsPath = path.join(ctxRoot, 'config', 'enabled-agents.json');

  // Check for duplicate name in enabled-agents.json
  try {
    const raw = await fs.readFile(enabledAgentsPath, 'utf-8');
    const existing = JSON.parse(raw);
    if (existing[name]) {
      return Response.json(
        { error: `Agent "${name}" already exists` },
        { status: 409 },
      );
    }
  } catch {
    // File doesn't exist yet - that's fine, we'll create it
  }

  try {
    // 1. Copy template dir to orgs/{org}/agents/{name}/
    const templateDir = path.join(frameworkRoot, 'templates', template);
    const agentDir = path.join(frameworkRoot, 'orgs', org, 'agents', name);

    await fs.mkdir(agentDir, { recursive: true });
    await copyDir(templateDir, agentDir);

    // 2. Write .env file
    const envLines = [
      `BOT_TOKEN=${botToken}`,
      `CHAT_ID=${chatId}`,
    ];
    if (allowedUser) {
      envLines.push(`ALLOWED_USER=${allowedUser}`);
    }
    await fs.writeFile(path.join(agentDir, '.env'), envLines.join('\n') + '\n', 'utf-8');

    // 3. Create state dirs under CTX_ROOT
    const stateDirs = ['inbox', 'outbox', 'processed', 'inflight', 'logs', 'state'];
    for (const dir of stateDirs) {
      await fs.mkdir(path.join(ctxRoot, dir, name), { recursive: true });
    }

    // 4. Register with daemon via IPC (replaces Mac-only generate-launchd.sh + launchctl)
    const instanceId = process.env.CTX_INSTANCE_ID ?? 'default';
    const ipc = new IPCClient(instanceId);
    const daemonRunning = await ipc.isDaemonRunning();
    if (daemonRunning) {
      const ipcResult = await ipc.send({
        type: 'start-agent',
        agent: name,
        data: { dir: agentDir },
      });
      if (!ipcResult.success) {
        console.warn(`[api/agents] POST: daemon start-agent returned error for "${name}":`, ipcResult.error);
      }
    } else {
      console.info(`[api/agents] POST: daemon not running; "${name}" registered and will start with daemon.`);
    }

    // 5. Update enabled-agents.json
    let enabledAgents: Record<string, unknown> = {};
    try {
      const raw = await fs.readFile(enabledAgentsPath, 'utf-8');
      enabledAgents = JSON.parse(raw);
    } catch {
      // Start fresh
    }

    enabledAgents[name] = {
      enabled: true,
      org,
      template,
      createdAt: new Date().toISOString(),
    };

    await fs.mkdir(path.dirname(enabledAgentsPath), { recursive: true });
    await fs.writeFile(
      enabledAgentsPath,
      JSON.stringify(enabledAgents, null, 2) + '\n',
      'utf-8',
    );

    return Response.json({ success: true, agent: { name, org } }, { status: 201 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[api/agents] POST error:', message);
    return Response.json(
      { error: 'Failed to create agent' },
      { status: 500 },
    );
  }
}

// ---------------------------------------------------------------------------
// Recursive directory copy
// ---------------------------------------------------------------------------

async function copyDir(src: string, dest: string): Promise<void> {
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await fs.mkdir(destPath, { recursive: true });
      await copyDir(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}
