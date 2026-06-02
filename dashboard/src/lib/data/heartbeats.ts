// cortextOS Dashboard - Heartbeat data fetcher
// Reads directly from filesystem (heartbeats change frequently; SQLite may lag).

import fs from 'fs/promises';
import path from 'path';
import { CTX_ROOT, getHeartbeatPath } from '@/lib/config';
import type { Heartbeat, HealthStatus, HealthSummary } from '@/lib/types';

// Default staleness thresholds (minutes).
// STALE_THRESHOLD_MIN is the minimum — actual threshold is cadence-aware:
// agents that set loop_interval get a 2× grace period over their cycle length.
const STALE_THRESHOLD_MIN = 120; // 2 hours: day-mode running agents need actionable recovery before a 4h+ gap
const DOWN_THRESHOLD_MIN = 1440; // 24 hours

/**
 * Parse a loop_interval value into minutes.
 * Accepts a string ("30m", "1h", "4h"), a number (already minutes), or undefined.
 * Returns 0 if missing, empty, or unparseable.
 */
function parseIntervalMinutes(interval: string | number | undefined): number {
  if (interval === undefined || interval === null || interval === '') return 0;
  if (typeof interval === 'number') return interval;
  const match = interval.trim().match(/^(\d+(?:\.\d+)?)(m|h)$/i);
  if (!match) return 0;
  const value = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  return unit === 'h' ? value * 60 : value;
}

/**
 * Get heartbeat for a single agent. Returns null if not found.
 */
export async function getHeartbeat(agentName: string): Promise<Heartbeat | null> {
  const hbPath = getHeartbeatPath(agentName);
  try {
    const raw = await fs.readFile(hbPath, 'utf-8');
    const data = JSON.parse(raw);
    const lastHeartbeat = data.last_heartbeat ?? data.timestamp ?? undefined;

    // Stale-starting guard: if the agent wrote a "starting" heartbeat on boot
    // but never progressed to "online" (crash before first update-heartbeat
    // call), the heartbeat.json stays at "starting" indefinitely. Any
    // "starting" entry older than 10 minutes is a boot failure — surface it
    // as "offline" so fleet views show the true state rather than implying
    // the agent is in the middle of booting up.
    let status: string = data.status ?? 'unknown';
    if (status === 'starting' && lastHeartbeat) {
      const ageMs = Date.now() - new Date(lastHeartbeat).getTime();
      if (ageMs > 10 * 60 * 1000) {
        status = 'offline';
      }
    }

    return {
      agent: agentName,
      org: data.org ?? '',
      status,
      current_task: data.current_task ?? undefined,
      mode: data.mode ?? undefined,
      last_heartbeat: lastHeartbeat,
      loop_interval: data.loop_interval ?? undefined,
      uptime_seconds: data.uptime_seconds ?? undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Get all heartbeats by scanning the state directory.
 */
export async function getAllHeartbeats(): Promise<Heartbeat[]> {
  const stateDir = path.join(CTX_ROOT, 'state');
  const heartbeats: Heartbeat[] = [];

  try {
    const entries = await fs.readdir(stateDir, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory());

    const results = await Promise.allSettled(
      dirs.map((d) => getHeartbeat(d.name))
    );

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        heartbeats.push(result.value);
      }
    }
  } catch {
    // state dir doesn't exist yet - return empty
  }

  return heartbeats;
}

/**
 * Get heartbeats filtered by org. If no org, returns all.
 */
export async function getHeartbeats(org?: string): Promise<Heartbeat[]> {
  const all = await getAllHeartbeats();
  if (!org) return all;
  // Include agents with matching org OR empty org (agents may not write org to heartbeat)
  return all.filter((hb) => hb.org === org || !hb.org);
}

/**
 * Compute health status from a heartbeat based on staleness.
 */
export function computeHealth(
  heartbeat: Heartbeat,
  thresholdMinutes?: number
): HealthStatus {
  return isAgentHealthy(heartbeat, thresholdMinutes) ? 'healthy' : 'stale';
}

/**
 * Check whether an agent heartbeat is healthy (not stale).
 */
export function isAgentHealthy(
  heartbeat: Heartbeat,
  thresholdMinutes: number = STALE_THRESHOLD_MIN
): boolean {
  if (!heartbeat.last_heartbeat) return false;

  const lastBeat = new Date(heartbeat.last_heartbeat).getTime();
  const now = Date.now();
  const diffMinutes = (now - lastBeat) / (1000 * 60);

  return diffMinutes <= thresholdMinutes;
}

/**
 * Get detailed health status (healthy / stale / down).
 */
export function getHealthStatus(heartbeat: Heartbeat): HealthStatus {
  if (!heartbeat.last_heartbeat) return 'down';

  const lastBeat = new Date(heartbeat.last_heartbeat).getTime();
  const now = Date.now();
  const diffMinutes = (now - lastBeat) / (1000 * 60);

  const parsedInterval = parseIntervalMinutes(heartbeat.loop_interval);
  const effectiveThreshold =
    parsedInterval > 0
      ? Math.max(parsedInterval * 2, STALE_THRESHOLD_MIN)
      : STALE_THRESHOLD_MIN;

  if (diffMinutes <= effectiveThreshold) return 'healthy';
  if (diffMinutes <= DOWN_THRESHOLD_MIN) return 'stale';
  return 'down';
}

/**
 * Get agents with stale or down heartbeats.
 */
export async function getStaleAgents(): Promise<Heartbeat[]> {
  const all = await getAllHeartbeats();
  return all.filter((hb) => !isAgentHealthy(hb));
}

/**
 * Get a health summary across all agents (optionally filtered by org).
 */
export async function getHealthSummary(org?: string): Promise<HealthSummary> {
  const heartbeats = await getHeartbeats(org);

  const summary: HealthSummary = {
    healthy: 0,
    stale: 0,
    down: 0,
    agents: [],
  };

  for (const hb of heartbeats) {
    const health = getHealthStatus(hb);

    if (health === 'healthy') summary.healthy++;
    else if (health === 'stale') summary.stale++;
    else summary.down++;

    summary.agents.push({
      agent: hb.agent,
      org: hb.org,
      health,
      lastHeartbeat: hb.last_heartbeat,
      currentTask: hb.current_task,
    });
  }

  return summary;
}
