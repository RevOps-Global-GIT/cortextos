import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { BusPaths } from '../types/index.js';
import { readAllHeartbeats } from './heartbeat.js';
import { logEvent } from './event.js';

export const DEFAULT_LEASE_SECONDS = 14400; // 4 hours

export interface WatchdogResult {
  agent: string;
  org: string;
  status: string;
  last_heartbeat: string;
  age_seconds: number;
  lease_seconds: number;
  expired: boolean;
}

export interface WatchdogOptions {
  /** Path to the cortextos project root (used to load per-agent config.json). */
  projectRoot?: string;
  /** Default lease threshold in seconds when no per-agent config is present. */
  defaultLeaseSeconds?: number;
}

/**
 * Read per-agent lease threshold from {projectRoot}/orgs/{org}/agents/{agent}/config.json.
 * Returns `defaultLease` when the file is absent or has no watchdog.lease_seconds field.
 */
function readAgentLease(
  projectRoot: string,
  org: string,
  agent: string,
  defaultLease: number,
): number {
  if (!org) return defaultLease;
  const cfgPath = join(projectRoot, 'orgs', org, 'agents', agent, 'config.json');
  if (!existsSync(cfgPath)) return defaultLease;
  try {
    const cfg: Record<string, unknown> = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    const wd = cfg['watchdog'];
    if (wd && typeof wd === 'object' && !Array.isArray(wd)) {
      const ls = (wd as Record<string, unknown>)['lease_seconds'];
      if (typeof ls === 'number' && ls > 0) return ls;
    }
  } catch {
    // Malformed config — use default
  }
  return defaultLease;
}

/**
 * Check all agents' heartbeats against their lease thresholds.
 *
 * Returns one WatchdogResult per agent found in the state directory.
 * `expired` is true when the agent's last heartbeat is older than its lease.
 */
export function checkWatchdog(paths: BusPaths, options?: WatchdogOptions): WatchdogResult[] {
  const heartbeats = readAllHeartbeats(paths);
  const now = Date.now();
  const defaultLease = options?.defaultLeaseSeconds ?? DEFAULT_LEASE_SECONDS;

  return heartbeats.map(hb => {
    const ageMs = now - new Date(hb.last_heartbeat).getTime();
    const ageSeconds = Math.floor(ageMs / 1000);

    const leaseSeconds =
      options?.projectRoot
        ? readAgentLease(options.projectRoot, hb.org ?? '', hb.agent, defaultLease)
        : defaultLease;

    return {
      agent: hb.agent,
      org: hb.org ?? '',
      status: hb.status ?? '',
      last_heartbeat: hb.last_heartbeat,
      age_seconds: ageSeconds,
      lease_seconds: leaseSeconds,
      expired: ageSeconds > leaseSeconds,
    };
  });
}

/**
 * Run the watchdog check and emit an `error/agent_lease_expired` event for every
 * expired agent. Returns the full result list so callers can act on it.
 */
export function pollWatchdog(
  paths: BusPaths,
  callerAgent: string,
  callerOrg: string,
  options?: WatchdogOptions,
): WatchdogResult[] {
  const results = checkWatchdog(paths, options);

  for (const r of results) {
    if (!r.expired) continue;
    logEvent(
      paths,
      callerAgent,
      callerOrg,
      'error',
      'agent_lease_expired',
      'warning',
      {
        expired_agent: r.agent,
        expired_org: r.org,
        age_seconds: r.age_seconds,
        lease_seconds: r.lease_seconds,
        last_heartbeat: r.last_heartbeat,
      },
    );
  }

  return results;
}
