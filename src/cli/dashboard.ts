import { Command } from 'commander';
import { existsSync } from 'fs';
import { join } from 'path';

export const dashboardCommand = new Command('dashboard')
  .option('--port <port>', 'Port to run dashboard on', '3000')
  .option('--install', 'Install dashboard dependencies first')
  .description('Start the cortextOS dashboard (Next.js)')
  .action(async (options: { port: string; install?: boolean }) => {
    const { execSync, spawn } = require('child_process');

    // Find dashboard directory
    const dashboardDir = findDashboardDir();
    if (!dashboardDir) {
      console.error('Dashboard not found. Expected at ./dashboard or in node_modules.');
      process.exit(1);
    }

    console.log(`Starting cortextOS dashboard from ${dashboardDir}`);

    // Install dependencies if needed or requested
    if (options.install || !existsSync(join(dashboardDir, 'node_modules'))) {
      console.log('Installing dashboard dependencies...');
      try {
        execSync('npm install', { cwd: dashboardDir, stdio: 'inherit', timeout: 120000 });
      } catch (err) {
        console.error('Failed to install dashboard dependencies:', err);
        process.exit(1);
      }
    }

    // Start Next.js dev server
    console.log(`\nDashboard starting on http://localhost:${options.port}\n`);

    // Require AUTH_SECRET — refuse to start with the default hardcoded value
    if (!process.env.AUTH_SECRET) {
      console.error(
        'ERROR: AUTH_SECRET is not set.\n' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"\n' +
        'Then add it to your shell profile or .env file.'
      );
      process.exit(1);
    }

    // Ensure AUTH_TRUST_HOST is set for local development
    const dashEnv = {
      ...process.env,
      PORT: options.port,
      AUTH_TRUST_HOST: process.env.AUTH_TRUST_HOST || 'true',
    };

    const child = spawn('npx', ['next', 'dev', '--port', options.port], {
      cwd: dashboardDir,
      stdio: 'inherit',
      env: dashEnv,
    });

    child.on('error', (err: Error) => {
      console.error('Failed to start dashboard:', err.message);
      process.exit(1);
    });

    child.on('exit', (code: number) => {
      process.exit(code || 0);
    });

    // Forward SIGINT/SIGTERM
    const cleanup = () => {
      child.kill('SIGTERM');
    };
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
  });

function findDashboardDir(): string | null {
  const candidates = [
    join(process.cwd(), 'dashboard'),
    join(__dirname, '..', '..', 'dashboard'),
    join(process.cwd(), 'node_modules', 'cortextos', 'dashboard'),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, 'package.json'))) return dir;
  }
  return null;
}
