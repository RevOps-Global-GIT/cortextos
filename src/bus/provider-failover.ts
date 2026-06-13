import { existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import type { CronDefinition } from '../types/index.js';
import { readCrons, writeCrons } from './crons.js';
import { atomicWriteSync } from '../utils/atomic.js';

export type ProviderHealthState = 'available' | 'capped' | 'unhealthy' | 'unknown';

export interface ProviderHealth {
  state: ProviderHealthState;
  reason?: string;
}

export interface ProviderFailoverPlanInput {
  currentProviderId: string;
  preferredProviderIds: string[];
  providerHealth: Record<string, ProviderHealth>;
  cronNames: string[];
  degradedCronAllowlist: string[];
}

export interface ProviderFailoverPlan {
  currentProviderId: string;
  selectedProviderId: string;
  shouldSwitch: boolean;
  degradedMode: boolean;
  cronsToDisable: string[];
  reason: string;
}

export interface ProviderRuntimeSpec {
  id: string;
  runtime: string;
  model?: string;
  tier?: string;
  home?: string;
  codex_app_server_transport?: string;
}

export interface ProviderFailoverConfig {
  preferred_order?: string[];
  degraded_cron_allowlist?: string[];
  providers?: ProviderRuntimeSpec[];
}

export interface AgentRuntimeConfig {
  runtime?: string;
  model?: string;
  tier?: string;
  home?: string;
  codex_app_server_transport?: string;
  telegram_polling?: boolean;
  provider_failover?: ProviderFailoverConfig;
  codex_account_pool?: Array<{ codex_home?: string; status?: string; priority?: number }>;
  fallbackModel?: string | string[];
  [key: string]: unknown;
}

export interface FailoverCronState {
  active: boolean;
  agent_name: string;
  selected_provider_id: string;
  previous_provider_id: string;
  started_at: string;
  ended_at?: string;
  reason: string;
  previous_enabled_by_name: Record<string, boolean>;
}

export interface ApplyCronPlanInput {
  agentName: string;
  selectedProviderId: string;
  previousProviderId: string;
  cronsToDisable: string[];
  reason: string;
  stateRoot?: string;
}

export interface ApplyCronPlanResult {
  statePath: string;
  disabledCronNames: string[];
  state: FailoverCronState;
}

export interface RestoreCronsInput {
  agentName: string;
  stateRoot?: string;
}

export interface RestoreCronsResult {
  statePath: string;
  restoredCronNames: string[];
  hadActiveState: boolean;
}

const DEFAULT_PROVIDER_ORDER = ['claude', 'codex', 'gemini'];

const DEFAULT_DEGRADED_CRON_ALLOWLIST = [
  'hero-publish-watchdog',
  'provider-failover-watchdog',
  'human-blockers-digest',
  'wip-enforcer',
  'idle-overlap-watcher',
  'deliverables-snapshot',
];

function nowIso(): string {
  return new Date().toISOString();
}

function defaultStateRoot(): string {
  return process.env.CTX_ROOT ?? join(homedir(), '.cortextos', process.env.CTX_INSTANCE_ID ?? 'default');
}

export function providerFailoverStatePath(agentName: string, stateRoot = defaultStateRoot()): string {
  return join(stateRoot, 'state', 'provider-failover', `${agentName}.json`);
}

function readJsonFile<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function writeJsonFile(path: string, value: unknown, keepBak = true): void {
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteSync(path, JSON.stringify(value, null, 2), keepBak);
}

export function readProviderFailoverState(agentName: string, stateRoot = defaultStateRoot()): FailoverCronState | null {
  return readJsonFile<FailoverCronState>(providerFailoverStatePath(agentName, stateRoot));
}

function healthIsUsable(health: ProviderHealth | undefined): boolean {
  return health?.state === 'available';
}

function healthProblem(health: ProviderHealth | undefined): string {
  if (!health) return 'unknown';
  return health.reason ? `${health.state}: ${health.reason}` : health.state;
}

export function planProviderFailover(input: ProviderFailoverPlanInput): ProviderFailoverPlan {
  const currentHealth = input.providerHealth[input.currentProviderId];
  const currentUsable = healthIsUsable(currentHealth);
  const selected = currentUsable
    ? input.currentProviderId
    : input.preferredProviderIds.find(id => healthIsUsable(input.providerHealth[id])) ?? input.currentProviderId;

  const shouldSwitch = selected !== input.currentProviderId;
  const degradedMode = shouldSwitch || !currentUsable;
  const allow = new Set(input.degradedCronAllowlist);
  const cronsToDisable = degradedMode
    ? input.cronNames.filter(name => !allow.has(name))
    : [];

  const reason = shouldSwitch
    ? `${input.currentProviderId} ${healthProblem(currentHealth)}; selected ${selected}`
    : currentUsable
      ? `${input.currentProviderId} available`
      : `${input.currentProviderId} ${healthProblem(currentHealth)}; no available fallback`;

  return {
    currentProviderId: input.currentProviderId,
    selectedProviderId: selected,
    shouldSwitch,
    degradedMode,
    cronsToDisable,
    reason,
  };
}

function updateCronEnabled(crons: CronDefinition[], enabledByName: Record<string, boolean>): CronDefinition[] {
  return crons.map(cron => (
    Object.prototype.hasOwnProperty.call(enabledByName, cron.name)
      ? { ...cron, enabled: enabledByName[cron.name] }
      : cron
  ));
}

export function applyFailoverCronPlan(input: ApplyCronPlanInput): ApplyCronPlanResult {
  const statePath = providerFailoverStatePath(input.agentName, input.stateRoot);
  const existingState = readProviderFailoverState(input.agentName, input.stateRoot);
  const existingPrevious = existingState?.active ? existingState.previous_enabled_by_name : {};
  const crons = readCrons(input.agentName);
  const requested = new Set(input.cronsToDisable);
  const previousEnabledByName: Record<string, boolean> = { ...existingPrevious };
  const patch: Record<string, boolean> = {};

  for (const cron of crons) {
    if (!requested.has(cron.name)) continue;
    if (!Object.prototype.hasOwnProperty.call(previousEnabledByName, cron.name)) {
      previousEnabledByName[cron.name] = cron.enabled;
    }
    if (previousEnabledByName[cron.name] === true) {
      patch[cron.name] = false;
    }
  }

  if (Object.keys(patch).length > 0) {
    writeCrons(input.agentName, updateCronEnabled(crons, patch));
  }

  const state: FailoverCronState = {
    active: true,
    agent_name: input.agentName,
    selected_provider_id: input.selectedProviderId,
    previous_provider_id: input.previousProviderId,
    started_at: existingState?.active ? existingState.started_at : nowIso(),
    reason: input.reason,
    previous_enabled_by_name: previousEnabledByName,
  };
  writeJsonFile(statePath, state);

  return {
    statePath,
    disabledCronNames: Object.entries(previousEnabledByName)
      .filter(([, wasEnabled]) => wasEnabled)
      .map(([name]) => name),
    state,
  };
}

export function restoreFailoverCrons(input: RestoreCronsInput): RestoreCronsResult {
  const statePath = providerFailoverStatePath(input.agentName, input.stateRoot);
  const state = readProviderFailoverState(input.agentName, input.stateRoot);
  if (!state?.active) {
    return { statePath, restoredCronNames: [], hadActiveState: false };
  }

  const crons = readCrons(input.agentName);
  writeCrons(input.agentName, updateCronEnabled(crons, state.previous_enabled_by_name));
  const restoredCronNames = Object.entries(state.previous_enabled_by_name)
    .filter(([, wasEnabled]) => wasEnabled)
    .map(([name]) => name);

  writeJsonFile(statePath, {
    ...state,
    active: false,
    ended_at: nowIso(),
  });

  return { statePath, restoredCronNames, hadActiveState: true };
}

export function providerIdFromConfig(config: AgentRuntimeConfig): string {
  if (config.runtime === 'codex-app-server') return 'codex';
  if (config.runtime === 'claude-code' || String(config.model ?? '').startsWith('claude-')) return 'claude';
  if (config.runtime === 'gemini-cli' || String(config.model ?? '').startsWith('gemini-')) return 'gemini';
  return String(config.runtime ?? config.model ?? 'unknown');
}

function defaultProviderSpecs(config: AgentRuntimeConfig): ProviderRuntimeSpec[] {
  const codexHomes = [...(config.codex_account_pool ?? [])]
    .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))
    .map(entry => entry.codex_home)
    .filter((home): home is string => Boolean(home));
  const claudeFallback = Array.isArray(config.fallbackModel)
    ? config.fallbackModel[0]
    : config.fallbackModel;

  return [
    {
      id: 'claude',
      runtime: 'claude-code',
      model: claudeFallback || (String(config.model ?? '').startsWith('claude-') ? config.model : 'claude-opus-4-7'),
      tier: config.tier,
      home: '/home/cortextos',
    },
    {
      id: 'codex',
      runtime: 'codex-app-server',
      model: String(config.model ?? '').startsWith('gpt-') ? config.model : 'gpt-5.5',
      home: codexHomes[0] || config.home || '/home/cortextos',
      codex_app_server_transport: 'ws',
    },
  ];
}

export function providerSpecsFromConfig(config: AgentRuntimeConfig): ProviderRuntimeSpec[] {
  const custom = config.provider_failover?.providers ?? [];
  const defaults = defaultProviderSpecs(config);
  const merged = new Map<string, ProviderRuntimeSpec>();
  for (const spec of defaults) merged.set(spec.id, spec);
  for (const spec of custom) merged.set(spec.id, { ...merged.get(spec.id), ...spec });
  return [...merged.values()];
}

export function preferredProviderOrder(config: AgentRuntimeConfig): string[] {
  return config.provider_failover?.preferred_order?.length
    ? config.provider_failover.preferred_order
    : DEFAULT_PROVIDER_ORDER;
}

export function degradedCronAllowlist(config: AgentRuntimeConfig): string[] {
  return config.provider_failover?.degraded_cron_allowlist?.length
    ? config.provider_failover.degraded_cron_allowlist
    : DEFAULT_DEGRADED_CRON_ALLOWLIST;
}

export function patchConfigForProvider(
  config: AgentRuntimeConfig,
  spec: ProviderRuntimeSpec,
): AgentRuntimeConfig {
  return {
    ...config,
    runtime: spec.runtime,
    model: spec.model ?? config.model,
    tier: spec.tier ?? config.tier,
    home: spec.home ?? config.home,
    codex_app_server_transport: spec.codex_app_server_transport ?? config.codex_app_server_transport,
    telegram_polling: true,
    provider_failover_last_switch: {
      provider: spec.id,
      runtime: spec.runtime,
      model: spec.model ?? config.model ?? null,
      switched_at: nowIso(),
    },
  };
}

export interface BuildFailoverPlanInput {
  config: AgentRuntimeConfig;
  crons: CronDefinition[];
  providerHealth: Record<string, ProviderHealth>;
  fromProviderId?: string;
}

export function buildFailoverPlan(input: BuildFailoverPlanInput): ProviderFailoverPlan {
  return planProviderFailover({
    currentProviderId: input.fromProviderId ?? providerIdFromConfig(input.config),
    preferredProviderIds: preferredProviderOrder(input.config),
    providerHealth: input.providerHealth,
    cronNames: input.crons.map(c => c.name),
    degradedCronAllowlist: degradedCronAllowlist(input.config),
  });
}

export function readAgentRuntimeConfig(configPath: string): AgentRuntimeConfig {
  const config = readJsonFile<AgentRuntimeConfig>(configPath);
  if (!config) throw new Error(`failed to read agent config: ${configPath}`);
  return config;
}

export function writeAgentRuntimeConfig(configPath: string, config: AgentRuntimeConfig): void {
  writeJsonFile(configPath, config, true);
}
