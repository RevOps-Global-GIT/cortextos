/**
 * attachSlackToAgent — wire up the SlackPoller for an agent so its inbound
 * Slack messages are injected into the running Claude Code process via the
 * same FastChecker queue that TelegramPoller uses.
 *
 * Usage (from agent-manager.ts after the agent's process is spawned):
 *
 *   const slack = await attachSlackToAgent({
 *     agentName: name,
 *     checker,
 *     log,
 *     staggerMs: this.agents.size * 2000,
 *   });
 *   if (slack) entry.slackPoller = slack;
 *
 * Resolves the orch_agents.id UUID from agent title via Supabase on
 * startup. If SUPABASE_RGOS_URL / SUPABASE_RGOS_SERVICE_KEY env vars are not
 * set, or the agent's orch_agents row can't be found, returns null and logs
 * a warning — the daemon continues running Telegram as before.
 */

import { SlackPoller, type SlackInboxRow } from './poller.js';
import { formatSlackTextMessage } from './formatter.js';

export interface FastCheckerLike {
  queueTelegramMessage: (formatted: string) => void;
  isDuplicate: (formatted: string) => boolean;
}

export interface AttachSlackParams {
  agentName: string;
  agentDir: string;
  checker: FastCheckerLike;
  log: (msg: string) => void;
  staggerMs?: number;
}

export async function attachSlackToAgent(params: AttachSlackParams): Promise<SlackPoller | null> {
  const { agentName, agentDir, checker, log, staggerMs } = params;

  // Read SUPABASE_RGOS_URL + SUPABASE_RGOS_SERVICE_KEY from the agent's .env
  // file. The daemon process itself does not have these; they are per-agent.
  const { readFileSync, existsSync } = await import('fs');
  const { join } = await import('path');
  const envFile = join(agentDir, '.env');
  let url: string | undefined;
  let key: string | undefined;
  if (existsSync(envFile)) {
    const content = readFileSync(envFile, 'utf-8');
    url = content.match(/^SUPABASE_RGOS_URL=(.+)$/m)?.[1]?.trim();
    key = content.match(/^SUPABASE_RGOS_SERVICE_KEY=(.+)$/m)?.[1]?.trim();
  }
  if (!url || !key) {
    log(`[slack] SUPABASE_RGOS_URL/SUPABASE_RGOS_SERVICE_KEY not in ${envFile} — Slack poller not started for ${agentName}`);
    return null;
  }

  // Resolve orch_agents.id for this agent title. cortextOS agent names are
  // lowercase ("orchestrator") and orch_agents.title is capitalized
  // ("Orchestrator"). Use ilike to be tolerant of case + spacing.
  const lookupUrl = `${url}/rest/v1/orch_agents?select=id,title&title=ilike.${encodeURIComponent(agentName)}&limit=1`;
  let agentId: string | null = null;
  try {
    const res = await fetch(lookupUrl, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!res.ok) {
      log(`[slack] orch_agents lookup for ${agentName} returned ${res.status}`);
      return null;
    }
    const rows = (await res.json()) as Array<{ id: string; title: string }>;
    agentId = rows[0]?.id ?? null;
    if (!agentId) {
      log(`[slack] no orch_agents row found for ${agentName} — Slack poller not started`);
      return null;
    }
  } catch (err) {
    log(`[slack] orch_agents lookup threw: ${err instanceof Error ? err.message : err}`);
    return null;
  }

  const poller = new SlackPoller(
    { url, serviceKey: key },
    agentId,
    5000,
    `slack-${agentName}`,
  );

  poller.onMessage((row: SlackInboxRow) => {
    const formatted = formatSlackTextMessage(row);
    if (checker.isDuplicate(formatted)) {
      log(`[slack] duplicate inbox row ${row.id} suppressed for ${agentName}`);
      return;
    }
    checker.queueTelegramMessage(formatted);
  });

  // Stagger identically to TelegramPoller to avoid thundering herd on
  // daemon boot when many agents come up at once.
  const delay = staggerMs ?? 0;
  poller.start(delay).catch((err) => {
    log(`[slack] poller error for ${agentName}: ${err}`);
  });

  log(`[slack] poller started for ${agentName} (agent_id=${agentId})`);
  return poller;
}
