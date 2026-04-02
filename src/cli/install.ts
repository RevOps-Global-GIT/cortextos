import { Command } from 'commander';
import { existsSync, mkdirSync, writeFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import { randomBytes } from 'crypto';

export const installCommand = new Command('install')
  .option('--instance <id>', 'Instance ID', 'default')
  .description('Install cortextOS - create state directories and check dependencies')
  .action(async (options: { instance: string }) => {
    const instanceId = options.instance;
    const ctxRoot = join(homedir(), '.cortextos', instanceId);

    console.log('\ncortextOS Installation\n');

    // Check dependencies
    console.log('Checking dependencies...');
    const deps = [
      { name: 'node', cmd: 'node --version', required: true },
      { name: 'claude', cmd: 'claude --version', required: true },
      { name: 'pm2', cmd: 'pm2 --version', required: false },
      { name: 'jq', cmd: 'jq --version', required: false },
      { name: 'tmux', cmd: 'tmux -V', required: false },
    ];

    let allRequired = true;
    for (const dep of deps) {
      try {
        const version = execSync(dep.cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
        console.log(`  ✓ ${dep.name}: ${version}`);
      } catch {
        if (dep.required) {
          console.log(`  ✗ ${dep.name}: NOT FOUND (required)`);
          allRequired = false;
        } else {
          console.log(`  - ${dep.name}: not found (optional)`);
        }
      }
    }

    if (!allRequired) {
      console.error('\nMissing required dependencies. Install them and try again.');
      process.exit(1);
    }

    // Create state directories
    // Rule: install = instance-level dirs only. init = org-level dirs (tasks, approvals, analytics).
    console.log('\nCreating state directories...');
    const dirs = [
      ctxRoot,
      join(ctxRoot, 'config'),
      join(ctxRoot, 'state'),
      join(ctxRoot, 'state', 'oauth'),   // OAuth token store (accounts.json)
      join(ctxRoot, 'state', 'usage'),   // Usage monitoring snapshots
      join(ctxRoot, 'inbox'),
      join(ctxRoot, 'inflight'),
      join(ctxRoot, 'processed'),
      join(ctxRoot, 'outbox'),
      join(ctxRoot, 'logs'),
      join(ctxRoot, 'orgs'),
    ];

    for (const dir of dirs) {
      mkdirSync(dir, { recursive: true });
      try { chmodSync(dir, 0o700); } catch { /* ignore on Windows */ }
    }
    console.log(`  Created ${dirs.length} directories at ${ctxRoot}`);

    // Create enabled-agents.json
    const enabledPath = join(ctxRoot, 'config', 'enabled-agents.json');
    if (!existsSync(enabledPath)) {
      writeFileSync(enabledPath, '{}', 'utf-8');
      console.log('  Created enabled-agents.json');
    }

    // Create .env
    const envPath = join(ctxRoot, '.env');
    if (!existsSync(envPath)) {
      writeFileSync(envPath, [
        `CTX_INSTANCE_ID=${instanceId}`,
        `CTX_ROOT=${ctxRoot}`,
        '',
      ].join('\n'), 'utf-8');
      console.log('  Created .env');
    }

    // Security (H10): Generate bus signing key for HMAC message authentication.
    const signingKeyPath = join(ctxRoot, 'config', 'bus-signing-key');
    if (!existsSync(signingKeyPath)) {
      const signingKey = randomBytes(32).toString('hex');
      writeFileSync(signingKeyPath, signingKey, 'utf-8');
      chmodSync(signingKeyPath, 0o600);
      console.log('  Generated bus-signing-key (HMAC-SHA256)');
    }

    console.log('\n  Installation complete.');
    console.log(`  State directory: ${ctxRoot}`);
    console.log('\n  Next steps:');
    console.log('    1. cortextos init <org-name>');
    console.log('    2. cortextos add-agent <name> --template orchestrator');
    console.log('    3. cortextos start\n');
  });
