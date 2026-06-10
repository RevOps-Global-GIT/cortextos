import fs from 'fs';
import path from 'path';
import { parseDurationMs } from '@/lib/cron-utils';

export type AutomationRegistrySourceType = 'cron' | 'capability';
export type AutomationRegistryStatus = 'ok' | 'warn' | 'fail' | 'blocked' | 'unknown';
export type AutomationRegistryRisk = 'low' | 'medium' | 'high';

interface AgentRef {
  name: string;
  org: string;
}

interface CronDefinition {
  name: string;
  prompt?: string;
  schedule?: string;
  enabled?: boolean;
  created_at?: string;
  last_fired_at?: string;
  fire_count?: number;
  description?: string;
  fire_at?: string;
  metadata?: Record<string, unknown>;
}

interface CronExecutionLogEntry {
  ts: string;
  cron: string;
  status: 'fired' | 'retried' | 'failed';
  attempt?: number;
  duration_ms?: number;
  error?: string | null;
  phase?: 'fire' | 'result';
  result?: string;
  artifact?: string;
}

interface CapabilityMonitor {
  defaultCadence?: string;
  capabilities?: CapabilityDefinition[];
}

interface CapabilityDefinition {
  id: string;
  label: string;
  userCapability?: string;
  authority?: string;
  currentStatus?: string;
  freshnessTarget?: string;
  warnWhen?: string;
  failWhen?: string;
  renewalPath?: string;
  proofRequired?: string;
  lastCheckedAt?: string;
  lastAuthority?: string;
  observed?: string;
  proof?: string;
}

export interface AutomationRegistryItem {
  id: string;
  sourceType: AutomationRegistrySourceType;
  source: string;
  owner: string;
  org: string;
  label: string;
  cadence: string;
  status: AutomationRegistryStatus;
  freshness: string;
  lastObservedAt: string | null;
  nextExpectedAt: string | null;
  risk: AutomationRegistryRisk;
  noise: string;
  notificationBehavior: string;
  duplicateGroup: string;
  duplicateCount: number;
  nextAction: string;
  detail: string;
  proof: string | null;
}

export interface AutomationRegistrySummary {
  total: number;
  ok: number;
  warn: number;
  fail: number;
  blocked: number;
  unknown: number;
  highRisk: number;
  needsAction: number;
  duplicateGroups: number;
  duplicateRows: number;
}

export interface AutomationRegistryResponse {
  generatedAt: string;
  surface: 'fleet-schedules/automation-registry';
  sourceLineage: string[];
  items: AutomationRegistryItem[];
  summary: AutomationRegistrySummary;
  filters: {
    owners: string[];
    cadences: string[];
    risks: AutomationRegistryRisk[];
    notificationBehaviors: string[];
    duplicateGroups: string[];
  };
}

export interface BuildAutomationRegistryOptions {
  ctxRoot: string;
  dashboardRoot: string;
  agents: AgentRef[];
  now?: Date;
}

const CRONS_DIR = '.cortextOS/state/agents';
const MS_24H = 24 * 60 * 60 * 1000;

export function buildAutomationRegistry({
  ctxRoot,
  dashboardRoot,
  agents,
  now = new Date(),
}: BuildAutomationRegistryOptions): AutomationRegistryResponse {
  const nowMs = now.getTime();
  const items: AutomationRegistryItem[] = [];

  for (const agent of agents) {
    const crons = readAgentCrons(ctxRoot, agent.name);
    const entries = readExecutionLog(ctxRoot, agent.name);

    for (const cron of crons) {
      const lastEntry = findLastExecution(entries, cron.name);
      const schedule = cron.schedule ?? '';
      const status = cronStatus(cron, lastEntry, nowMs);
      const lastObservedAt = lastEntry?.ts ?? cron.last_fired_at ?? null;
      const nextExpectedAt = computeNextExpectedAt(schedule, cron.last_fired_at, nowMs);
      const prompt = cron.prompt ?? '';
      const cadence = schedule || cron.fire_at || 'schedule unknown';
      const notifications = notificationBehavior(prompt);

      items.push({
        id: `cron:${agent.name}:${cron.name}`,
        sourceType: 'cron',
        source: `daemon cron: ${agent.name}/${cron.name}`,
        owner: agent.name,
        org: agent.org,
        label: cron.name,
        cadence,
        status,
        freshness: cronFreshness(status, lastObservedAt, nextExpectedAt),
        lastObservedAt,
        nextExpectedAt,
        risk: cronRisk(cron, prompt, status),
        noise: notifications,
        notificationBehavior: notifications,
        duplicateGroup: duplicateGroupKey(agent.name, cadence, notifications),
        duplicateCount: 1,
        nextAction: cronNextAction(status, cron, lastEntry),
        detail: cron.description || prompt || 'No prompt or description recorded.',
        proof: lastEntry ? `${lastEntry.status} at ${lastEntry.ts}` : null,
      });
    }
  }

  const monitor = readCapabilityMonitor(dashboardRoot);
  for (const cap of monitor.capabilities ?? []) {
    const status = normalizeStatus(cap.currentStatus);
    const authority = cap.lastAuthority || cap.authority || 'capability monitor';
    const cadence = cap.freshnessTarget || monitor.defaultCadence || 'freshness target unknown';
    const notifications = 'status-only monitor; no outbound notification from this view';
    items.push({
      id: `capability:${cap.id}`,
      sourceType: 'capability',
      source: `capability monitor: ${cap.id}`,
      owner: authority,
      org: 'revops-global',
      label: cap.label || cap.id,
      cadence,
      status,
      freshness: cap.lastCheckedAt ? `last checked ${cap.lastCheckedAt}` : 'no check timestamp',
      lastObservedAt: cap.lastCheckedAt ?? null,
      nextExpectedAt: null,
      risk: capabilityRisk(status),
      noise: notifications,
      notificationBehavior: notifications,
      duplicateGroup: duplicateGroupKey(authority, cadence, notifications),
      duplicateCount: 1,
      nextAction: status === 'ok'
        ? 'Continue routine probe cadence.'
        : cap.renewalPath || cap.proofRequired || 'Document blocker and required authority.',
      detail: cap.observed || cap.userCapability || cap.authority || 'No capability detail recorded.',
      proof: cap.proof || cap.observed || null,
    });
  }

  applyDuplicateCounts(items);

  items.sort((a, b) => {
    const statusRank = statusOrder(a.status) - statusOrder(b.status);
    if (statusRank !== 0) return statusRank;
    const riskRank = riskOrder(a.risk) - riskOrder(b.risk);
    if (riskRank !== 0) return riskRank;
    return a.label.localeCompare(b.label);
  });

  return {
    generatedAt: now.toISOString(),
    surface: 'fleet-schedules/automation-registry',
    sourceLineage: [
      'daemon crons.json registry',
      'cron-execution.log freshness/status',
      'capability-monitor.json probe registry',
    ],
    items,
    summary: summarize(items),
    filters: buildFilters(items),
  };
}

function readAgentCrons(ctxRoot: string, agentName: string): CronDefinition[] {
  const filePath = path.join(ctxRoot, CRONS_DIR, agentName, 'crons.json');
  if (!fs.existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as { crons?: unknown };
    return Array.isArray(parsed.crons) ? parsed.crons as CronDefinition[] : [];
  } catch {
    return [];
  }
}

function readExecutionLog(ctxRoot: string, agentName: string): CronExecutionLogEntry[] {
  const logPath = path.join(ctxRoot, CRONS_DIR, agentName, 'cron-execution.log');
  if (!fs.existsSync(logPath)) return [];
  try {
    return fs.readFileSync(logPath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as CronExecutionLogEntry];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function readCapabilityMonitor(dashboardRoot: string): CapabilityMonitor {
  const monitorPath = path.join(dashboardRoot, 'src', 'data', 'capability-monitor.json');
  if (!fs.existsSync(monitorPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(monitorPath, 'utf-8')) as CapabilityMonitor;
  } catch {
    return {};
  }
}

function findLastExecution(
  entries: CronExecutionLogEntry[],
  cronName: string,
): CronExecutionLogEntry | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].cron === cronName) return entries[i];
  }
  return null;
}

function cronStatus(
  cron: CronDefinition,
  lastEntry: CronExecutionLogEntry | null,
  nowMs: number,
): AutomationRegistryStatus {
  if (cron.enabled === false) return 'blocked';
  if (!lastEntry) return 'unknown';
  if (lastEntry.status === 'failed') return 'fail';
  if (lastEntry.status === 'retried') return 'warn';

  const schedule = cron.schedule ?? '';
  const intervalMs = parseDurationMs(schedule);
  if (!Number.isNaN(intervalMs) && intervalMs > 0) {
    const gapMs = nowMs - new Date(lastEntry.ts).getTime();
    if (gapMs > intervalMs * 2) return 'warn';
  }

  return 'ok';
}

function normalizeStatus(status: string | undefined): AutomationRegistryStatus {
  if (status === 'ok') return 'ok';
  if (status === 'warn' || status === 'pending_wiring') return 'warn';
  if (status === 'fail') return 'fail';
  if (status === 'blocked') return 'blocked';
  return 'unknown';
}

function computeNextExpectedAt(
  schedule: string,
  lastFiredAt: string | undefined,
  nowMs: number,
): string | null {
  const intervalMs = parseDurationMs(schedule);
  if (Number.isNaN(intervalMs) || intervalMs <= 0) return null;
  const referenceMs = lastFiredAt ? new Date(lastFiredAt).getTime() : nowMs;
  const next = referenceMs + intervalMs;
  return new Date(next <= nowMs ? nowMs + intervalMs : next).toISOString();
}

function cronFreshness(
  status: AutomationRegistryStatus,
  lastObservedAt: string | null,
  nextExpectedAt: string | null,
): string {
  if (!lastObservedAt) return 'no execution history';
  if (status === 'fail') return `last failed ${lastObservedAt}`;
  if (status === 'warn') return `stale or retried; last observed ${lastObservedAt}`;
  if (nextExpectedAt) return `last observed ${lastObservedAt}; next expected ${nextExpectedAt}`;
  return `last observed ${lastObservedAt}`;
}

function cronRisk(
  cron: CronDefinition,
  prompt: string,
  status: AutomationRegistryStatus,
): AutomationRegistryRisk {
  const text = `${cron.name} ${prompt}`.toLowerCase();
  if (status === 'fail' || status === 'blocked') return 'high';
  if (/(deploy|merge|delete|remove|email|slack|telegram|linkedin|send-message|send-telegram|approval|financial)/.test(text)) {
    return 'high';
  }
  if (/(report|artifact|browser|qa|probe|ingest|sync|scorecard|health|cron)/.test(text)) {
    return 'medium';
  }
  return 'low';
}

function capabilityRisk(status: AutomationRegistryStatus): AutomationRegistryRisk {
  if (status === 'fail' || status === 'blocked') return 'high';
  if (status === 'warn' || status === 'unknown') return 'medium';
  return 'low';
}

function notificationBehavior(prompt: string): string {
  const lower = prompt.toLowerCase();
  if (lower.includes('send-telegram')) return 'Telegram notification path in prompt';
  if (lower.includes('send-message')) return 'agent message notification path in prompt';
  if (lower.includes('report only if') || lower.includes('stay silent') || lower.includes('do nothing')) {
    return 'quiet unless drift, errors, or assigned work appear';
  }
  if (lower.includes('log-event')) return 'activity-feed logging expected';
  return 'no explicit notification behavior recorded';
}

function duplicateGroupKey(owner: string, cadence: string, notification: string): string {
  return `${owner} | ${cadence} | ${notification}`;
}

function applyDuplicateCounts(items: AutomationRegistryItem[]) {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item.duplicateGroup, (counts.get(item.duplicateGroup) ?? 0) + 1);
  }
  for (const item of items) {
    item.duplicateCount = counts.get(item.duplicateGroup) ?? 1;
  }
}

function cronNextAction(
  status: AutomationRegistryStatus,
  cron: CronDefinition,
  lastEntry: CronExecutionLogEntry | null,
): string {
  if (cron.enabled === false) return 'Review disabled schedule before re-enabling.';
  if (!lastEntry) return 'Trigger a safe dry run or wait for first scheduled fire.';
  if (status === 'fail') return lastEntry.error || 'Inspect failed execution log and rerun after fix.';
  if (status === 'warn') return 'Check freshness gap and last retry before changing cadence.';
  return 'No action required; monitor next scheduled fire.';
}

function summarize(items: AutomationRegistryItem[]): AutomationRegistrySummary {
  const summary: AutomationRegistrySummary = {
    total: items.length,
    ok: 0,
    warn: 0,
    fail: 0,
    blocked: 0,
    unknown: 0,
    highRisk: 0,
    needsAction: 0,
    duplicateGroups: 0,
    duplicateRows: 0,
  };
  const duplicateGroups = new Set<string>();

  for (const item of items) {
    summary[item.status]++;
    if (item.risk === 'high') summary.highRisk++;
    if (item.status !== 'ok') summary.needsAction++;
    if (item.duplicateCount > 1) {
      summary.duplicateRows++;
      duplicateGroups.add(item.duplicateGroup);
    }
  }
  summary.duplicateGroups = duplicateGroups.size;

  return summary;
}

function buildFilters(items: AutomationRegistryItem[]): AutomationRegistryResponse['filters'] {
  return {
    owners: uniqueSorted(items.map(item => item.owner)),
    cadences: uniqueSorted(items.map(item => item.cadence)),
    risks: ['high', 'medium', 'low'],
    notificationBehaviors: uniqueSorted(items.map(item => item.notificationBehavior)),
    duplicateGroups: uniqueSorted(items.filter(item => item.duplicateCount > 1).map(item => item.duplicateGroup)),
  };
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function statusOrder(status: AutomationRegistryStatus): number {
  return { fail: 0, blocked: 1, warn: 2, unknown: 3, ok: 4 }[status];
}

function riskOrder(risk: AutomationRegistryRisk): number {
  return { high: 0, medium: 1, low: 2 }[risk];
}
