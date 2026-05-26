#!/usr/bin/env tsx
import { readFileSync } from 'fs';
import { join } from 'path';

type WatchdogStatus = 'fresh' | 'pending' | 'stale' | 'unknown';

interface ThetaRow {
  session_id: string;
  ran_at: string;
  status: string;
  created_at?: string;
}

interface CronLogEntry {
  ts?: string;
  timestamp?: string;
  cron?: string;
  name?: string;
  status?: string;
}

interface WatchdogInput {
  now: Date;
  latestThetaRow: ThetaRow | null;
  expectedSessionId: string;
  expectedFireAt: Date;
  graceMinutes: number;
  latestCronFireAt?: Date | null;
}

export interface WatchdogResult {
  status: WatchdogStatus;
  expected_session_id: string;
  expected_fire_at: string;
  grace_minutes: number;
  latest_theta_session: ThetaRow | null;
  latest_cron_fire_at: string | null;
  reason: string;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function expectedThetaSessionId(now: Date): string {
  return `theta-${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`;
}

export function expectedFireAtForSession(sessionId: string): Date {
  const match = /^theta-(\d{4})-(\d{2})-(\d{2})$/.exec(sessionId);
  if (!match) throw new Error(`invalid theta session id: ${sessionId}`);
  return new Date(`${match[1]}-${match[2]}-${match[3]}T05:00:00.000Z`);
}

export function evaluateThetaFreshness(input: WatchdogInput): WatchdogResult {
  const graceMs = input.graceMinutes * 60 * 1000;
  const staleAfter = input.expectedFireAt.getTime() + graceMs;
  const nowMs = input.now.getTime();
  const latest = input.latestThetaRow;

  if (latest?.session_id === input.expectedSessionId) {
    const healthy = latest.status === 'complete' || latest.status === 'error';
    return {
      status: healthy ? 'fresh' : 'pending',
      expected_session_id: input.expectedSessionId,
      expected_fire_at: input.expectedFireAt.toISOString(),
      grace_minutes: input.graceMinutes,
      latest_theta_session: latest,
      latest_cron_fire_at: input.latestCronFireAt?.toISOString() ?? null,
      reason: healthy
        ? `latest theta_sessions row matches ${input.expectedSessionId} with terminal status ${latest.status}`
        : `latest theta_sessions row matches ${input.expectedSessionId} but status is ${latest.status}`,
    };
  }

  if (nowMs < staleAfter) {
    return {
      status: 'pending',
      expected_session_id: input.expectedSessionId,
      expected_fire_at: input.expectedFireAt.toISOString(),
      grace_minutes: input.graceMinutes,
      latest_theta_session: latest,
      latest_cron_fire_at: input.latestCronFireAt?.toISOString() ?? null,
      reason: `within ${input.graceMinutes} minute grace window for ${input.expectedSessionId}`,
    };
  }

  return {
    status: 'stale',
    expected_session_id: input.expectedSessionId,
    expected_fire_at: input.expectedFireAt.toISOString(),
    grace_minutes: input.graceMinutes,
    latest_theta_session: latest,
    latest_cron_fire_at: input.latestCronFireAt?.toISOString() ?? null,
    reason: latest
      ? `latest theta_sessions row is ${latest.session_id}, expected ${input.expectedSessionId}`
      : `no theta_sessions rows found, expected ${input.expectedSessionId}`,
  };
}

function argValue(name: string, fallback?: string): string | undefined {
  const prefix = `--${name}=`;
  const direct = process.argv.find(arg => arg.startsWith(prefix));
  if (direct) return direct.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1];
  return fallback;
}

function readEnvFile(path: string): void {
  try {
    const raw = readFileSync(path, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
      const [key, ...rest] = trimmed.split('=');
      if (!process.env[key]) process.env[key] = rest.join('=').replace(/^['"]|['"]$/g, '');
    }
  } catch {
    // Optional local env hydration; explicit process env still wins.
  }
}

async function fetchLatestThetaRow(): Promise<ThetaRow | null> {
  const root = process.env.CTX_ROOT ?? '/home/cortextos/cortextos';
  readEnvFile(join(root, 'orgs/revops-global/secrets.env'));
  const url = process.env.SUPABASE_RGOS_URL ?? process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_RGOS_SERVICE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('missing SUPABASE_RGOS_URL/SUPABASE_RGOS_SERVICE_KEY');

  const endpoint = new URL('/rest/v1/theta_sessions', url);
  endpoint.searchParams.set('select', 'session_id,ran_at,status,created_at');
  endpoint.searchParams.set('order', 'ran_at.desc');
  endpoint.searchParams.set('limit', '1');

  const response = await fetch(endpoint, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: 'application/json',
    },
  });
  if (!response.ok) throw new Error(`theta_sessions query failed: ${response.status} ${response.statusText}`);
  const rows = await response.json() as ThetaRow[];
  return rows[0] ?? null;
}

function latestCronFire(agent: string, cronName: string): Date | null {
  const root = process.env.CTX_ROOT ?? '/home/cortextos/cortextos';
  const logPath = join(root, '.cortextOS/state/agents', agent, 'cron-execution.log');
  try {
    const raw = readFileSync(logPath, 'utf8');
    const entries = raw.split(/\r?\n/)
      .filter(Boolean)
      .map(line => {
        try { return JSON.parse(line) as CronLogEntry; } catch { return null; }
      })
      .filter((entry): entry is CronLogEntry => Boolean(entry));
    const match = entries.reverse().find(entry => (entry.cron ?? entry.name) === cronName && entry.status === 'fired');
    const timestamp = match?.ts ?? match?.timestamp;
    return timestamp ? new Date(timestamp) : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const agent = argValue('agent', 'analyst')!;
  const cronName = argValue('cron', 'theta-wave')!;
  const graceMinutes = Number(argValue('grace-minutes', '90'));
  if (!Number.isFinite(graceMinutes) || graceMinutes < 0) throw new Error('--grace-minutes must be a non-negative number');

  const now = new Date(argValue('now') ?? Date.now());
  const expectedSession = argValue('expected-session') ?? expectedThetaSessionId(now);
  const expectedFireAt = expectedFireAtForSession(expectedSession);
  const latestThetaRow = await fetchLatestThetaRow();
  const result = evaluateThetaFreshness({
    now,
    latestThetaRow,
    expectedSessionId: expectedSession,
    expectedFireAt,
    graceMinutes,
    latestCronFireAt: latestCronFire(agent, cronName),
  });

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`${result.status.toUpperCase()}: ${result.reason}`);
    console.log(`expected: ${result.expected_session_id} at ${result.expected_fire_at}`);
    console.log(`latest: ${result.latest_theta_session?.session_id ?? 'none'} (${result.latest_theta_session?.status ?? 'n/a'})`);
  }

  if (result.status === 'stale' || result.status === 'unknown') process.exitCode = 1;
}

if (require.main === module) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  });
}
