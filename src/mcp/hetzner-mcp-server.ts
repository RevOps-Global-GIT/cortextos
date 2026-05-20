import process from 'node:process';

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: JsonObject;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonObject;
}

interface HetznerApiOptions {
  token?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

interface ServerLookupInput {
  server_id?: number;
  server_name?: string;
}

const API_BASE_URL = 'https://api.hetzner.cloud/v1';
const USER_AGENT = 'cortextos-hetzner-mcp-server/0.1.0';
const METRICS = ['cpu', 'memory', 'disk', 'network'] as const;
const API_METRICS = new Set(['cpu', 'disk', 'network']);

class McpError extends Error {
  constructor(
    message: string,
    public readonly code = -32603,
  ) {
    super(message);
  }
}

class HetznerApi {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HetznerApiOptions = {}) {
    const token = options.token ?? process.env.HETZNER_API_TOKEN;
    if (!token) {
      throw new McpError('HETZNER_API_TOKEN is required for Hetzner MCP tools');
    }
    this.token = token;
    this.baseUrl = options.baseUrl ?? API_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async request(path: string, init: RequestInit = {}): Promise<JsonValue> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        ...(init.headers ?? {}),
      },
    });
    const text = await response.text();
    const body = text ? parseJson(text) : null;
    if (!response.ok) {
      const detail = typeof body === 'object' && body !== null && 'error' in body
        ? JSON.stringify(body.error)
        : text || response.statusText;
      throw new McpError(`Hetzner API ${response.status}: ${detail}`);
    }
    return body;
  }

  async resolveServerId(input: ServerLookupInput): Promise<number> {
    if (typeof input.server_id === 'number') return input.server_id;
    if (!input.server_name) {
      throw new McpError('Provide server_id or server_name', -32602);
    }
    const result = await this.request(`/servers?name=${encodeURIComponent(input.server_name)}`);
    const servers = asArray(asObject(result).servers);
    const server = servers.map(asObject).find(candidate => candidate.name === input.server_name);
    const id = server?.id;
    if (typeof id !== 'number') {
      throw new McpError(`No Hetzner server found with name "${input.server_name}"`, -32602);
    }
    return id;
  }
}

export const hetznerTools: ToolDefinition[] = [
  {
    name: 'hetzner_list_servers',
    description: 'List Hetzner Cloud servers visible to HETZNER_API_TOKEN.',
    inputSchema: objectSchema({
      page: { type: 'integer', minimum: 1 },
      per_page: { type: 'integer', minimum: 1, maximum: 50 },
      name: { type: 'string' },
      label_selector: { type: 'string' },
      sort: { type: 'string' },
    }),
  },
  {
    name: 'hetzner_get_server_status',
    description: 'Get status and key details for one Hetzner Cloud server by id or exact name.',
    inputSchema: objectSchema(serverLookupProperties()),
  },
  {
    name: 'hetzner_reboot_server',
    description: 'Trigger a Hetzner Cloud server reboot action.',
    inputSchema: objectSchema(serverLookupProperties()),
  },
  {
    name: 'hetzner_poweroff',
    description: 'Power off a Hetzner Cloud server.',
    inputSchema: objectSchema(serverLookupProperties()),
  },
  {
    name: 'hetzner_poweron',
    description: 'Power on a Hetzner Cloud server.',
    inputSchema: objectSchema(serverLookupProperties()),
  },
  {
    name: 'hetzner_list_firewall_rules',
    description: 'List Hetzner Cloud firewall rules, optionally filtered by firewall id/name or server id.',
    inputSchema: objectSchema({
      firewall_id: { type: 'integer', minimum: 1 },
      firewall_name: { type: 'string' },
      server_id: { type: 'integer', minimum: 1 },
    }),
  },
  {
    name: 'hetzner_get_metrics',
    description: 'Get Hetzner Cloud server metrics. Hetzner Cloud API supports cpu, disk, and network; memory returns an unsupported marker.',
    inputSchema: objectSchema({
      ...serverLookupProperties(),
      metrics: {
        type: 'array',
        items: { type: 'string', enum: [...METRICS] },
        default: ['cpu', 'disk', 'network'],
      },
      start: { type: 'string', description: 'ISO-8601 start time. Defaults to one hour ago.' },
      end: { type: 'string', description: 'ISO-8601 end time. Defaults to now.' },
      step: { type: 'string', description: 'Resolution in seconds, passed to the Hetzner API.' },
    }),
  },
];

export async function callHetznerTool(
  toolName: string,
  rawArgs: JsonObject = {},
  options: HetznerApiOptions = {},
): Promise<JsonValue> {
  const api = new HetznerApi(options);
  switch (toolName) {
    case 'hetzner_list_servers':
      return api.request(`/servers${queryString(pickQuery(rawArgs, ['page', 'per_page', 'name', 'label_selector', 'sort']))}`);
    case 'hetzner_get_server_status':
      return getServerStatus(api, rawArgs);
    case 'hetzner_reboot_server':
      return serverAction(api, rawArgs, 'reboot');
    case 'hetzner_poweroff':
      return serverAction(api, rawArgs, 'poweroff');
    case 'hetzner_poweron':
      return serverAction(api, rawArgs, 'poweron');
    case 'hetzner_list_firewall_rules':
      return listFirewallRules(api, rawArgs);
    case 'hetzner_get_metrics':
      return getMetrics(api, rawArgs);
    default:
      throw new McpError(`Unknown Hetzner tool: ${toolName}`, -32601);
  }
}

async function getServerStatus(api: HetznerApi, args: JsonObject): Promise<JsonValue> {
  const serverId = await api.resolveServerId(readServerLookup(args));
  const result = asObject(await api.request(`/servers/${serverId}`));
  const server = asObject(result.server);
  return {
    id: server.id,
    name: server.name,
    status: server.status,
    created: server.created,
    server_type: server.server_type,
    datacenter: server.datacenter,
    public_net: server.public_net,
    private_net: server.private_net,
    labels: server.labels,
  };
}

async function serverAction(api: HetznerApi, args: JsonObject, action: 'reboot' | 'poweroff' | 'poweron'): Promise<JsonValue> {
  const serverId = await api.resolveServerId(readServerLookup(args));
  return api.request(`/servers/${serverId}/actions/${action}`, { method: 'POST' });
}

async function listFirewallRules(api: HetznerApi, args: JsonObject): Promise<JsonValue> {
  const firewallId = readOptionalNumber(args, 'firewall_id');
  const firewallName = readOptionalString(args, 'firewall_name');
  const serverId = readOptionalNumber(args, 'server_id');
  const result = firewallId
    ? asObject(await api.request(`/firewalls/${firewallId}`))
    : asObject(await api.request(`/firewalls${queryString(pickQuery(args, ['name']))}`));
  const firewalls = firewallId ? [asObject(result.firewall)] : asArray(result.firewalls).map(asObject);
  const filtered = firewalls.filter(firewall => {
    if (firewallName && firewall.name !== firewallName) return false;
    if (!serverId) return true;
    return asArray(firewall.applied_to).some(item => {
      const applied = asObject(item);
      const server = typeof applied.server === 'object' && applied.server !== null ? asObject(applied.server) : {};
      return applied.type === 'server' && server.id === serverId;
    });
  });
  return {
    firewalls: filtered.map(firewall => ({
      id: firewall.id,
      name: firewall.name,
      rules: firewall.rules,
      applied_to: firewall.applied_to,
    })),
  };
}

async function getMetrics(api: HetznerApi, args: JsonObject): Promise<JsonValue> {
  const serverId = await api.resolveServerId(readServerLookup(args));
  const requested = readMetrics(args);
  const now = new Date();
  const end = readOptionalString(args, 'end') ?? now.toISOString();
  const start = readOptionalString(args, 'start') ?? new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const step = readOptionalString(args, 'step');
  const metrics: JsonObject = {};

  for (const metric of requested) {
    if (!API_METRICS.has(metric)) {
      metrics[metric] = {
        supported: false,
        reason: 'Hetzner Cloud server metrics API exposes cpu, disk, and network metrics, not memory metrics.',
      };
      continue;
    }
    metrics[metric] = await api.request(`/servers/${serverId}/metrics${queryString({ type: metric, start, end, step })}`);
  }

  return { server_id: serverId, start, end, step: step ?? null, metrics };
}

export async function handleMcpRequest(request: JsonRpcRequest, options: HetznerApiOptions = {}): Promise<JsonValue | undefined> {
  if (request.method === 'notifications/initialized') return undefined;
  if (request.method === 'initialize') {
    return {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'hetzner-mcp-server', version: '0.1.0' },
    };
  }
  if (request.method === 'tools/list') {
    return { tools: hetznerTools.map(tool => ({ ...tool })) };
  }
  if (request.method === 'tools/call') {
    const params = request.params ?? {};
    const toolName = readRequiredString(params, 'name');
    const args = typeof params.arguments === 'object' && params.arguments !== null ? asObject(params.arguments) : {};
    const result = await callHetznerTool(toolName, args, options);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }
  throw new McpError(`Unsupported MCP method: ${request.method}`, -32601);
}

export function startHetznerMcpServer(): void {
  let buffer = '';
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', chunk => {
    buffer += chunk;
    for (;;) {
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex === -1) break;
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) continue;
      void handleLine(line);
    }
  });
}

async function handleLine(line: string): Promise<void> {
  let request: JsonRpcRequest | null = null;
  try {
    request = parseJson(line) as unknown as JsonRpcRequest;
    const result = await handleMcpRequest(request);
    if (request.id !== undefined && result !== undefined) {
      writeRpc({ jsonrpc: '2.0', id: request.id, result });
    }
  } catch (error) {
    const mcpError = error instanceof McpError ? error : new McpError(error instanceof Error ? error.message : String(error));
    writeRpc({
      jsonrpc: '2.0',
      id: request?.id ?? null,
      error: { code: mcpError.code, message: mcpError.message },
    });
  }
}

function writeRpc(message: JsonObject): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function objectSchema(properties: JsonObject): JsonObject {
  return { type: 'object', properties, additionalProperties: false };
}

function serverLookupProperties(): JsonObject {
  return {
    server_id: { type: 'integer', minimum: 1 },
    server_name: { type: 'string', description: 'Exact Hetzner server name. Used when server_id is omitted.' },
  };
}

function queryString(params: Record<string, JsonValue | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

function pickQuery(args: JsonObject, keys: string[]): Record<string, JsonValue | undefined> {
  const query: Record<string, JsonValue | undefined> = {};
  for (const key of keys) query[key] = args[key];
  return query;
}

function readServerLookup(args: JsonObject): ServerLookupInput {
  const serverId = readOptionalNumber(args, 'server_id');
  const serverName = readOptionalString(args, 'server_name');
  if (serverId === undefined && serverName === undefined) {
    throw new McpError('Provide server_id or server_name', -32602);
  }
  return { server_id: serverId, server_name: serverName };
}

function readMetrics(args: JsonObject): string[] {
  const value = args.metrics;
  if (value === undefined) return ['cpu', 'disk', 'network'];
  if (!Array.isArray(value)) throw new McpError('metrics must be an array', -32602);
  const metrics = value.map(item => {
    if (typeof item !== 'string' || !METRICS.includes(item as (typeof METRICS)[number])) {
      throw new McpError(`metrics entries must be one of: ${METRICS.join(', ')}`, -32602);
    }
    return item;
  });
  return [...new Set(metrics)];
}

function readRequiredString(args: JsonObject, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new McpError(`${key} is required`, -32602);
  }
  return value;
}

function readOptionalString(args: JsonObject, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) throw new McpError(`${key} must be a non-empty string`, -32602);
  return value;
}

function readOptionalNumber(args: JsonObject, key: string): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new McpError(`${key} must be a positive integer`, -32602);
  }
  return value;
}

function parseJson(value: string): JsonValue {
  return JSON.parse(value) as JsonValue;
}

function asObject(value: JsonValue | undefined): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}

function asArray(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : [];
}

if (require.main === module) {
  startHetznerMcpServer();
}
