#!/usr/bin/env node

import * as fs from 'fs';
import * as path from 'path';
import { vercelFetch } from './lib/vercel-api';

type Args = Record<string, string | boolean>;

interface VercelProject {
  id?: string;
  name?: string;
}

interface VercelEnvVar {
  id: string;
  key: string;
  value?: string;
  target?: string[];
  type?: string;
}

interface VercelEnvList {
  envs?: VercelEnvVar[];
}

interface VercelDeployment {
  id?: string;
  uid?: string;
  url?: string;
  readyState?: string;
  state?: string;
  errorMessage?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};

  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (!current.startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${current}`);
    }

    const eq = current.indexOf('=');
    if (eq !== -1) {
      args[current.slice(0, eq)] = current.slice(eq + 1);
      continue;
    }

    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[current] = true;
    } else {
      args[current] = next;
      i += 1;
    }
  }

  return args;
}

function requiredString(args: Args, flag: string): string {
  const value = args[flag];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Missing required CLI arg: ${flag}`);
  }
  return value.trim();
}

function optionalString(args: Args, flag: string): string | undefined {
  const value = args[flag];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalStringWithDefault(args: Args, flag: string, fallback: string): string {
  return optionalString(args, flag) || fallback;
}

function hasFlag(args: Args, flag: string): boolean {
  return args[flag] === true;
}

function normalizeEnvValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return '';
  return JSON.stringify(value);
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  return (text ? JSON.parse(text) : {}) as T;
}

async function expectJson<T>(response: Response, action: string): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${action} failed with HTTP ${response.status}: ${text || response.statusText}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

async function getProject(projectName: string): Promise<VercelProject | undefined> {
  const response = await vercelFetch(`/v9/projects/${encodeURIComponent(projectName)}`);

  if (response.status === 404) {
    return undefined;
  }

  return expectJson<VercelProject>(response, `Get Vercel project ${projectName}`);
}

async function createProject(projectName: string, framework: string, gitRepo?: string): Promise<VercelProject> {
  const body: Record<string, unknown> = { name: projectName, framework };

  if (gitRepo) {
    if (!/^[^/]+\/[^/]+$/.test(gitRepo)) {
      throw new Error('--git-repo must use format owner/repo');
    }

    body.gitRepository = { type: 'github', repo: gitRepo };
  }

  return expectJson<VercelProject>(
    await vercelFetch('/v10/projects', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    `Create Vercel project ${projectName}`,
  );
}

function readEnvFile(filePath: string): Record<string, string> {
  const resolved = path.resolve(filePath);
  const raw = JSON.parse(fs.readFileSync(resolved, 'utf8')) as unknown;

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`--env-vars must point to a JSON object mapping names to values: ${resolved}`);
  }

  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).map(([key, value]) => [key, normalizeEnvValue(value)]),
  );
}

async function syncEnvVars(projectName: string, envFile: string): Promise<void> {
  const desiredEnv = readEnvFile(envFile);
  const envResponse = await expectJson<VercelEnvList>(
    await vercelFetch(`/v9/projects/${encodeURIComponent(projectName)}/env`),
    `List env vars for ${projectName}`,
  );
  const existingEnv = envResponse.envs || [];

  for (const [key, value] of Object.entries(desiredEnv)) {
    const existing = existingEnv.find((envVar) => envVar.key === key);
    const body = {
      key,
      value,
      type: 'encrypted',
      target: ['production', 'preview', 'development'],
    };

    if (existing?.value === value) {
      console.log(`Env var ${key} already matches -- skipping`);
      continue;
    }

    if (existing) {
      await expectJson<unknown>(
        await vercelFetch(`/v9/projects/${encodeURIComponent(projectName)}/env/${encodeURIComponent(existing.id)}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        }),
        `Patch env var ${key}`,
      );
      console.log(`Env var ${key} updated`);
      continue;
    }

    await expectJson<unknown>(
      await vercelFetch(`/v9/projects/${encodeURIComponent(projectName)}/env`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
      `Create env var ${key}`,
    );
    console.log(`Env var ${key} created`);
  }
}

function deploymentIdFrom(deployment: VercelDeployment): string {
  const id = deployment.id || deployment.uid;
  if (!id) {
    throw new Error(`Deployment response did not include id or uid: ${JSON.stringify(deployment)}`);
  }
  return id;
}

function deploymentUrlFrom(deployment: VercelDeployment): string {
  if (!deployment.url) return 'unknown';
  return deployment.url.startsWith('http') ? deployment.url : `https://${deployment.url}`;
}

async function redeployProject(projectName: string): Promise<void> {
  const deployment = await expectJson<VercelDeployment>(
    await vercelFetch(`/v13/deployments/${encodeURIComponent(projectName)}`, {
      method: 'POST',
      body: JSON.stringify({ name: projectName, target: 'production' }),
    }),
    `Redeploy Vercel project ${projectName}`,
  );

  const deploymentId = deploymentIdFrom(deployment);
  const timeoutAt = Date.now() + 30 * 60 * 1000;

  while (Date.now() < timeoutAt) {
    const current = await expectJson<VercelDeployment>(
      await vercelFetch(`/v13/deployments/${encodeURIComponent(deploymentId)}`),
      `Poll deployment ${deploymentId}`,
    );
    const state = current.readyState || current.state || 'UNKNOWN';

    if (state === 'READY') {
      console.log(`Deployment ready: ${deploymentUrlFrom(current)}`);
      return;
    }

    if (['ERROR', 'CANCELED', 'FAILED'].includes(state)) {
      throw new Error(`Deployment ${deploymentId} failed with state ${state}: ${current.errorMessage || 'no error message'}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }

  throw new Error(`Timed out waiting for deployment ${deploymentId}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const projectName = requiredString(args, '--project-name');
  const framework = optionalStringWithDefault(args, '--framework', 'nextjs');
  const gitRepo = optionalString(args, '--git-repo');
  const envVars = optionalString(args, '--env-vars');
  const redeploy = hasFlag(args, '--redeploy');

  const existing = await getProject(projectName);
  if (existing) {
    console.log(`Project ${projectName} already exists`);
  } else {
    const created = await createProject(projectName, framework, gitRepo);
    console.log(`Project ${projectName} created with ID ${created.id || 'unknown'}`);
  }

  if (envVars) {
    await syncEnvVars(projectName, envVars);
  }

  if (redeploy) {
    await redeployProject(projectName);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
