import { Command } from 'commander';
import { listAgents } from '../bus/agents.js';
import { getCtxRoot } from '../utils/paths.js';

export const listAgentsCommand = new Command('list-agents')
  .description('List all agents in the system')
  .option('--org <org>', 'Filter by organization')
  .option('--format <format>', 'Output format: json or text', 'text')
  .option('--instance <id>', 'Instance ID')
  .action(async (options: { org?: string; format: string; instance?: string }) => {
    const instanceId = options.instance || process.env.CTX_INSTANCE_ID || 'default';
    const ctxRoot = getCtxRoot(instanceId);
    const agents = await listAgents(ctxRoot, options.org);

    if (options.format === 'json') {
      console.log(JSON.stringify(agents, null, 2));
    } else {
      if (agents.length === 0) {
        console.log('No agents found.');
        return;
      }

      // Table header
      const header = '  Name              Display Name      Org              Role                          Status          Last Heartbeat        Host';
      const separator = '  ' + '-'.repeat(header.length - 2);
      console.log('\n  Agents\n');
      console.log(header);
      console.log(separator);

      for (const a of agents) {
        const name = a.name.padEnd(18);
        const displayName = (a.display_name || '-').padEnd(18);
        const org = (a.org || '-').padEnd(17);
        const role = (a.role || '-').substring(0, 29).padEnd(30);
        // Show health indicator emoji; remote agents get a different icon
        const healthIcon = a.running ? (a.remote ? '◉ ' : '● ') : '○ ';
        const statusText = a.running ? (a.remote ? 'remote' : 'running') : 'stopped';
        const status = (healthIcon + statusText).padEnd(16);
        const hb = a.last_heartbeat || '-';
        const host = a.remote ? (a.host || '-') : '';
        console.log(`  ${name}${displayName}${org}${role}${status}${hb.padEnd(22)}${host}`);
      }

      const localCount = agents.filter(a => !a.remote).length;
      const remoteCount = agents.filter(a => a.remote).length;
      const remoteSuffix = remoteCount > 0 ? ` (${localCount} local, ${remoteCount} remote)` : '';
      console.log(`\n  Total: ${agents.length} agents${remoteSuffix}\n`);
    }
  });
