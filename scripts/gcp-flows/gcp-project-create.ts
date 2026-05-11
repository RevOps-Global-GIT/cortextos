#!/usr/bin/env node

import { getAccessToken } from './lib/gcp-auth';

type Args = Record<string, string | boolean>;

interface OperationResponse {
  name?: string;
  done?: boolean;
  error?: { code?: number; message?: string; details?: unknown[] };
  response?: ProjectResponse;
}

interface ProjectResponse {
  name?: string;
  projectId?: string;
  displayName?: string;
  projectNumber?: string;
}

const API_BASE = 'https://cloudresourcemanager.googleapis.com/v3';

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

async function gcpFetch(accessToken: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${accessToken}`);

  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  return fetch(`${API_BASE}${path}`, { ...init, headers });
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

function operationPath(operationName: string): string {
  if (!operationName) {
    throw new Error('Create project response did not include an operation name');
  }

  if (operationName.startsWith('https://')) {
    const url = new URL(operationName);
    return url.pathname.replace('/v3', '');
  }

  return operationName.startsWith('/') ? operationName : `/${operationName}`;
}

function projectNumberFrom(project?: ProjectResponse): string | undefined {
  if (!project) return undefined;
  if (project.projectNumber) return project.projectNumber;
  if (project.name?.startsWith('projects/')) return project.name.split('/').pop();
  return undefined;
}

async function pollOperation(accessToken: string, operationName: string): Promise<OperationResponse> {
  const path = operationPath(operationName);
  const timeoutAt = Date.now() + 30 * 60 * 1000;

  while (Date.now() < timeoutAt) {
    const operation = await expectJson<OperationResponse>(
      await gcpFetch(accessToken, path),
      `Poll operation ${operationName}`,
    );

    if (operation.done) {
      if (operation.error) {
        throw new Error(`Project create operation failed: ${operation.error.message || JSON.stringify(operation.error)}`);
      }
      return operation;
    }

    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }

  throw new Error(`Timed out waiting for operation ${operationName} to finish`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const projectId = requiredString(args, '--project-id');
  const displayName = requiredString(args, '--display-name');
  const parentFolder = optionalString(args, '--parent-folder');

  if (parentFolder && !/^folders\/\d+$/.test(parentFolder)) {
    throw new Error('--parent-folder must use format folders/123456789');
  }

  const accessToken = await getAccessToken();
  const existing = await gcpFetch(accessToken, `/projects/${encodeURIComponent(projectId)}`);

  if (existing.status === 200) {
    console.log(`Project ${projectId} already exists -- skipping`);
    return;
  }

  if (existing.status !== 404) {
    const body = await existing.text();
    throw new Error(`Project lookup failed with HTTP ${existing.status}: ${body || existing.statusText}`);
  }

  const createBody: Record<string, string> = { projectId, displayName };
  if (parentFolder) createBody.parent = parentFolder;

  const operation = await expectJson<OperationResponse>(
    await gcpFetch(accessToken, '/projects', {
      method: 'POST',
      body: JSON.stringify(createBody),
    }),
    `Create project ${projectId}`,
  );

  const completed = await pollOperation(accessToken, operation.name || '');
  const projectResponse = completed.response;

  const projectLookup = await gcpFetch(accessToken, `/projects/${encodeURIComponent(projectId)}`);
  const finalProject = projectLookup.ok
    ? await readJson<ProjectResponse>(projectLookup)
    : projectResponse;

  const projectNumber = projectNumberFrom(finalProject) || projectNumberFrom(projectResponse) || 'unknown';
  console.log(`Project ${projectId} created with number ${projectNumber}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
