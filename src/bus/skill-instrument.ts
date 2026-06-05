/**
 * skill-instrument.ts — Log implicit skill invocations from bus subcommands.
 *
 * Bus commands like update-heartbeat, create-task, and log-event are canonical
 * entrypoints for skills (heartbeat, tasks, event-logging) but never go through
 * the Skill tool, so orch_skill_invocations stays at 0 for those skills even
 * though they fire 1000+ times per week.
 *
 * Call logImplicitInvocation(slug, agentDir, agentRole) at the end of each such
 * subcommand. The call is always fire-and-forget — errors are logged to stderr
 * and the bus command's own process.exit(0) is not delayed.
 */

import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';

/** Maps bus subcommand names to their canonical skill slugs. */
export const SUBCOMMAND_SKILL_MAP: Record<string, string> = {
  'update-heartbeat': 'heartbeat',
  'create-approval': 'approvals',
  'log-event': 'event-logging',
  'send-message': 'comms',
  'create-task': 'tasks',
};

/**
 * Insert a row into orch_skill_invocations for an implicit bus-layer invocation.
 * Reads Supabase credentials from `agentDir/.env`. No-ops when credentials are
 * absent, and logs non-fatal telemetry errors to stderr.
 */
export type SkillInvocationSource = 'bus_implicit' | 'cron';

export interface LogImplicitInvocationOptions {
  source?: SkillInvocationSource;
}

function readEnvFileValue(file: string, key: string): string | undefined {
  if (!existsSync(file)) return undefined;
  const content = readFileSync(file, 'utf-8');
  return content.match(new RegExp(`^${key}=(.+)$`, 'm'))?.[1]?.trim();
}

function envValue(agentDir: string, key: string): string | undefined {
  const agentEnv = join(agentDir, '.env');
  const orgEnv = join(dirname(dirname(agentDir)), 'secrets.env');
  return process.env[key]?.trim()
    || readEnvFileValue(agentEnv, key)
    || readEnvFileValue(orgEnv, key);
}

async function responseText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

function warn(message: string): void {
  process.stderr.write(`skill-instrument: ${message}\n`);
}

function titleizeSkillSlug(slug: string): string {
  return slug
    .split(/[-_:]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || slug;
}

async function resolveOrCreateSkillId(
  sbUrl: string,
  headers: { apikey: string; Authorization: string },
  skillSlug: string,
): Promise<string | null> {
  const encodedSlug = encodeURIComponent(skillSlug);
  const skillRes = await fetch(
    `${sbUrl}/rest/v1/orch_skills?slug=eq.${encodedSlug}&select=id&limit=1`,
    { headers },
  );
  if (skillRes.ok) {
    const rows = (await skillRes.json()) as Array<{ id: string }>;
    if (rows[0]?.id) return rows[0].id;
  } else {
    warn(`skill lookup failed for "${skillSlug}" (${skillRes.status}): ${await responseText(skillRes)}`);
  }

  const createRes = await fetch(`${sbUrl}/rest/v1/orch_skills?on_conflict=slug`, {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify({
      slug: skillSlug,
      name: titleizeSkillSlug(skillSlug),
      description: 'Auto-discovered from skill invocation telemetry.',
      category: 'general',
      is_active: true,
      trigger_keywords: [],
      applicable_roles: [],
      library: false,
    }),
  });

  if (!createRes.ok) {
    warn(`skill auto-create failed for "${skillSlug}" (${createRes.status}): ${await responseText(createRes)}`);
    return null;
  }

  const created = (await createRes.json()) as Array<{ id: string }>;
  return created[0]?.id ?? null;
}

export async function logImplicitInvocation(
  skillSlug: string,
  agentDir: string,
  agentRole?: string,
  options: LogImplicitInvocationOptions = {},
): Promise<void> {
  try {
    if (!agentDir) return;
    const sbUrl = envValue(agentDir, 'SUPABASE_RGOS_URL') || envValue(agentDir, 'RGOS_SUPABASE_URL');
    const sbKey = envValue(agentDir, 'SUPABASE_RGOS_SERVICE_KEY') || envValue(agentDir, 'RGOS_SUPABASE_SERVICE_KEY');
    if (!sbUrl || !sbKey) return;

    const headers = { apikey: sbKey, Authorization: `Bearer ${sbKey}` };

    const skillId = await resolveOrCreateSkillId(sbUrl, headers, skillSlug);
    if (!skillId) return;

    // Resolve agent_id (nullable)
    let agentId: string | null = null;
    if (agentRole) {
      const agentRes = await fetch(
        `${sbUrl}/rest/v1/orch_agents?title=ilike.${encodeURIComponent(agentRole)}&select=id&limit=1`,
        { headers },
      );
      if (agentRes.ok) {
        const rows = (await agentRes.json()) as Array<{ id: string }>;
        agentId = rows[0]?.id ?? null;
      } else {
        warn(`agent lookup failed for "${agentRole}" (${agentRes.status}): ${await responseText(agentRes)}`);
      }
    }

    const body: Record<string, unknown> = {
      skill_slug: skillSlug,
      source: options.source ?? 'bus_implicit',
      succeeded: true,
      skill_id: skillId,
    };
    if (agentId) body.agent_id = agentId;
    if (agentRole) body.agent_role = agentRole;

    const insertRes = await fetch(`${sbUrl}/rest/v1/orch_skill_invocations`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(body),
    });
    if (!insertRes.ok) {
      warn(`insert failed for "${skillSlug}" (${insertRes.status}): ${await responseText(insertRes)}`);
    }
  } catch (err) {
    // Never throw — must not block the bus command that called us.
    warn(`error logging "${skillSlug}": ${err instanceof Error ? err.message : String(err)}`);
  }
}
