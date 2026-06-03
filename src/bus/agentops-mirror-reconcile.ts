import type { BusPaths } from '../types/index.js';
import { listAgents } from './agents.js';
import { readCrons } from './crons.js';
import { listTasks } from './task.js';
import { isEnabled, mapStatus, mirrorAgentStatusToRgos, mirrorTaskToRgos, uuidv5 } from './rgos-mirror.js';

type DriftKind = 'task_missing' | 'task_status' | 'agent_missing' | 'agent_active';

export interface AgentOpsMirrorDrift {
  kind: DriftKind;
  id: string;
  title?: string;
  live: unknown;
  mirror: unknown;
}

export interface AgentOpsMirrorReconcileResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  live_tasks: number;
  mirror_tasks: number;
  live_agents: number;
  mirror_agents: number;
  drift_count: number;
  drifts: AgentOpsMirrorDrift[];
}

export interface AgentOpsMirrorRepairFailure {
  kind: 'task' | 'agent';
  id: string;
  error: string;
}

export interface AgentOpsCronAudit {
  live_crons: number;
  enabled_crons: number;
  disabled_crons: number;
  note: string;
}

export interface AgentOpsMirrorRepairResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  dry_run: boolean;
  before: AgentOpsMirrorReconcileResult;
  after?: AgentOpsMirrorReconcileResult;
  planned_tasks: number;
  planned_agents: number;
  repaired_tasks: number;
  repaired_agents: number;
  failures: AgentOpsMirrorRepairFailure[];
  crons: AgentOpsCronAudit;
}

async function fetchMirrorRows<T>(table: string, params: URLSearchParams): Promise<T[]> {
  const url = process.env.SUPABASE_RGOS_URL!;
  const serviceKey = process.env.SUPABASE_RGOS_SERVICE_KEY!;
  const endpoint = `${url}/rest/v1/${table}?${params.toString()}`;
  const response = await fetch(endpoint, {
    method: 'GET',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Supabase ${table} fetch failed: ${response.status} ${body.slice(0, 160)}`);
  }
  return await response.json().catch(() => []) as T[];
}

async function fetchAllMirrorRows<T>(
  table: string,
  baseParams: URLSearchParams,
  pageSize = 1000,
): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; offset < 20_000; offset += pageSize) {
    const params = new URLSearchParams(baseParams);
    params.set('limit', String(pageSize));
    params.set('offset', String(offset));
    const page = await fetchMirrorRows<T>(table, params);
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

interface MirrorTaskRow {
  id?: string;
  status?: string;
  title?: string;
  metadata?: Record<string, unknown>;
}

interface MirrorAgentRow {
  role_id?: string;
  is_active?: boolean;
}

export async function reconcileAgentOpsMirror(
  paths: BusPaths,
  options?: { org?: string; maxDrifts?: number },
): Promise<AgentOpsMirrorReconcileResult> {
  if (!isEnabled()) {
    return {
      ok: true,
      skipped: true,
      reason: 'RGOS mirror disabled or Supabase env missing',
      live_tasks: 0,
      mirror_tasks: 0,
      live_agents: 0,
      mirror_agents: 0,
      drift_count: 0,
      drifts: [],
    };
  }

  const maxDrifts = options?.maxDrifts ?? 50;
  const drifts: AgentOpsMirrorDrift[] = [];
  let driftCount = 0;
  const pushDrift = (drift: AgentOpsMirrorDrift) => {
    driftCount++;
    if (drifts.length < maxDrifts) drifts.push(drift);
  };

  const taskParams = new URLSearchParams({
    select: 'id,status,title,metadata',
    source: 'eq.cortextos_bus_mirror',
  });
  const mirrorTasks = await fetchAllMirrorRows<MirrorTaskRow>('orch_tasks', taskParams);
  const mirrorTasksByBusId = new Map<string, MirrorTaskRow>();
  const mirrorTasksByUuid = new Map<string, MirrorTaskRow>();
  for (const row of mirrorTasks) {
    if (typeof row.id === 'string') mirrorTasksByUuid.set(row.id, row);
    const busTaskId = row.metadata?.bus_task_id;
    if (typeof busTaskId === 'string') mirrorTasksByBusId.set(busTaskId, row);
  }

  const liveTasks = listTasks(paths);
  for (const task of liveTasks) {
    const mirror = mirrorTasksByBusId.get(task.id) ?? mirrorTasksByUuid.get(uuidv5(task.id));
    const liveStatus = mapStatus(task.status);
    if (!mirror) {
      pushDrift({
        kind: 'task_missing',
        id: task.id,
        title: task.title,
        live: liveStatus,
        mirror: null,
      });
      continue;
    }
    if (mirror.status !== liveStatus) {
      pushDrift({
        kind: 'task_status',
        id: task.id,
        title: task.title,
        live: liveStatus,
        mirror: mirror.status ?? null,
      });
    }
  }

  const agentParams = new URLSearchParams({
    select: 'role_id,is_active',
  });
  const mirrorAgents = await fetchAllMirrorRows<MirrorAgentRow>('orch_agents', agentParams);
  const mirrorAgentsByRoleId = new Map(
    mirrorAgents
      .filter(row => typeof row.role_id === 'string')
      .map(row => [row.role_id as string, row]),
  );

  const liveAgents = await listAgents(paths.ctxRoot, options?.org);
  for (const agent of liveAgents) {
    const roleId = `cortextos-${agent.name}`;
    const mirror = mirrorAgentsByRoleId.get(roleId);
    const liveActive = agent.enabled !== false && agent.running === true;
    if (!mirror) {
      pushDrift({
        kind: 'agent_missing',
        id: roleId,
        live: liveActive,
        mirror: null,
      });
      continue;
    }
    if (mirror.is_active !== liveActive) {
      pushDrift({
        kind: 'agent_active',
        id: roleId,
        live: liveActive,
        mirror: mirror.is_active ?? null,
      });
    }
  }

  return {
    ok: true,
    live_tasks: liveTasks.length,
    mirror_tasks: mirrorTasks.length,
    live_agents: liveAgents.length,
    mirror_agents: mirrorAgents.length,
    drift_count: driftCount,
    drifts,
  };
}

function taskMirrorEvent(taskStatus: string): 'update' | 'complete' {
  return taskStatus === 'completed' ? 'complete' : 'update';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function auditCrons(agentNames: string[]): AgentOpsCronAudit {
  let liveCrons = 0;
  let enabledCrons = 0;
  let disabledCrons = 0;

  for (const agentName of agentNames) {
    const crons = readCrons(agentName);
    liveCrons += crons.length;
    for (const cron of crons) {
      if (cron.enabled === false) disabledCrons++;
      else enabledCrons++;
    }
  }

  return {
    live_crons: liveCrons,
    enabled_crons: enabledCrons,
    disabled_crons: disabledCrons,
    note: 'crons enumerated only; AgentOps currently mirrors cron disablement as Activity events, not persistent cron rows',
  };
}

export async function repairAgentOpsMirror(
  paths: BusPaths,
  options?: { org?: string; maxDrifts?: number; dryRun?: boolean },
): Promise<AgentOpsMirrorRepairResult> {
  const before = await reconcileAgentOpsMirror(paths, options);
  const liveTasks = listTasks(paths);
  const liveAgents = await listAgents(paths.ctxRoot, options?.org);
  const crons = auditCrons(liveAgents.map(agent => agent.name));
  const dryRun = options?.dryRun === true;

  if (before.skipped || !isEnabled()) {
    return {
      ok: true,
      skipped: true,
      reason: before.reason ?? 'RGOS mirror disabled or Supabase env missing',
      dry_run: dryRun,
      before,
      planned_tasks: liveTasks.length,
      planned_agents: liveAgents.length,
      repaired_tasks: 0,
      repaired_agents: 0,
      failures: [],
      crons,
    };
  }

  if (dryRun) {
    return {
      ok: true,
      dry_run: true,
      before,
      planned_tasks: liveTasks.length,
      planned_agents: liveAgents.length,
      repaired_tasks: 0,
      repaired_agents: 0,
      failures: [],
      crons,
    };
  }

  const failures: AgentOpsMirrorRepairFailure[] = [];
  let repairedTasks = 0;
  let repairedAgents = 0;

  for (const task of liveTasks) {
    try {
      await mirrorTaskToRgos(task, taskMirrorEvent(task.status));
      repairedTasks++;
    } catch (err) {
      failures.push({ kind: 'task', id: task.id, error: errorMessage(err) });
    }
  }

  for (const agent of liveAgents) {
    try {
      await mirrorAgentStatusToRgos(agent.name, {
        isActive: agent.enabled !== false && agent.running === true,
        currentTask: agent.current_task ?? null,
        lastHeartbeat: agent.last_heartbeat ?? null,
        mode: agent.mode ?? null,
        reason: 'agentops_mirror_repair',
        instanceId: agent.instance_id ?? process.env.CTX_INSTANCE_ID,
        org: agent.org || options?.org,
      });
      repairedAgents++;
    } catch (err) {
      failures.push({ kind: 'agent', id: agent.name, error: errorMessage(err) });
    }
  }

  const after = await reconcileAgentOpsMirror(paths, options);

  return {
    ok: failures.length === 0 && after.drift_count === 0,
    dry_run: false,
    before,
    after,
    planned_tasks: liveTasks.length,
    planned_agents: liveAgents.length,
    repaired_tasks: repairedTasks,
    repaired_agents: repairedAgents,
    failures,
    crons,
  };
}
