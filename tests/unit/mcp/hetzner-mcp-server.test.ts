import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  callHetznerTool,
  handleMcpRequest,
  hetznerTools,
} from '../../../src/mcp/hetzner-mcp-server.js';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Bad Request',
    text: async () => JSON.stringify(body),
  } as Response;
}

describe('hetzner-mcp-server', () => {
  beforeEach(() => {
    process.env.HETZNER_API_TOKEN = 'test-token';
  });

  afterEach(() => {
    delete process.env.HETZNER_API_TOKEN;
    vi.restoreAllMocks();
  });

  it('exposes the requested Hetzner MCP tools', () => {
    expect(hetznerTools.map(tool => tool.name)).toEqual([
      'hetzner_list_servers',
      'hetzner_get_server_status',
      'hetzner_reboot_server',
      'hetzner_poweroff',
      'hetzner_poweron',
      'hetzner_list_firewall_rules',
      'hetzner_get_metrics',
    ]);
  });

  it('lists servers using HETZNER_API_TOKEN', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ servers: [{ id: 42, name: 'app-1' }] }));

    const result = await callHetznerTool('hetzner_list_servers', { per_page: 10 }, { fetchImpl });

    expect(result).toEqual({ servers: [{ id: 42, name: 'app-1' }] });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.hetzner.cloud/v1/servers?per_page=10',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
      }),
    );
  });

  it('resolves server names and posts reboot actions', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ servers: [{ id: 7, name: 'web' }] }))
      .mockResolvedValueOnce(jsonResponse({ action: { id: 99, command: 'reboot' } }));

    const result = await callHetznerTool('hetzner_reboot_server', { server_name: 'web' }, { fetchImpl });

    expect(result).toEqual({ action: { id: 99, command: 'reboot' } });
    expect(fetchImpl).toHaveBeenNthCalledWith(1, 'https://api.hetzner.cloud/v1/servers?name=web', expect.any(Object));
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://api.hetzner.cloud/v1/servers/7/actions/reboot',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('filters firewall rules by applied server id', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      firewalls: [
        {
          id: 1,
          name: 'web-fw',
          rules: [{ direction: 'in', protocol: 'tcp', port: '443' }],
          applied_to: [{ type: 'server', server: { id: 7 } }],
        },
        {
          id: 2,
          name: 'db-fw',
          rules: [{ direction: 'in', protocol: 'tcp', port: '5432' }],
          applied_to: [{ type: 'server', server: { id: 8 } }],
        },
      ],
    }));

    const result = await callHetznerTool('hetzner_list_firewall_rules', { server_id: 7 }, { fetchImpl });

    expect(result).toEqual({
      firewalls: [{
        id: 1,
        name: 'web-fw',
        rules: [{ direction: 'in', protocol: 'tcp', port: '443' }],
        applied_to: [{ type: 'server', server: { id: 7 } }],
      }],
    });
  });

  it('gets supported metrics and marks memory unsupported', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ metrics: { time_series: { cpu: { values: [['1', '0.5']] } } } }));

    const result = await callHetznerTool(
      'hetzner_get_metrics',
      {
        server_id: 7,
        metrics: ['cpu', 'memory'],
        start: '2026-05-20T00:00:00Z',
        end: '2026-05-20T01:00:00Z',
        step: '60',
      },
      { fetchImpl },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.hetzner.cloud/v1/servers/7/metrics?type=cpu&start=2026-05-20T00%3A00%3A00Z&end=2026-05-20T01%3A00%3A00Z&step=60',
      expect.any(Object),
    );
    expect(result).toMatchObject({
      server_id: 7,
      metrics: {
        cpu: { metrics: { time_series: { cpu: { values: [['1', '0.5']] } } } },
        memory: { supported: false },
      },
    });
  });

  it('handles MCP initialize, tools/list, and tools/call requests', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ server: { id: 7, name: 'web', status: 'running' } }));

    await expect(handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'initialize' })).resolves.toMatchObject({
      serverInfo: { name: 'hetzner-mcp-server' },
    });
    await expect(handleMcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).resolves.toMatchObject({
      tools: expect.any(Array),
    });
    const call = await handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'hetzner_get_server_status', arguments: { server_id: 7 } },
      },
      { fetchImpl },
    );

    expect(call).toMatchObject({
      content: [{ type: 'text', text: expect.stringContaining('"status": "running"') }],
    });
  });
});
