import { appendFileSync, existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import type { Approval, ApprovalCategory, BusPaths } from '../types/index.js';
import { ensureDir } from '../utils/atomic.js';
import { createApproval } from './approval.js';

export interface LastPassCredOptions {
  agentName: string;
  org: string;
  frameworkRoot?: string;
  agentDir?: string;
  sshHost?: string;
  remoteScript?: string;
}

export interface LastPassCredResult {
  credential: string;
  approvalId?: string;
}

class LastPassCredError extends Error {
  code: string;
  approvalId?: string;

  constructor(code: string, message: string, approvalId?: string) {
    super(message);
    this.name = 'LastPassCredError';
    this.code = code;
    this.approvalId = approvalId;
  }
}

export class LastPassCredApprovalRequiredError extends LastPassCredError {
  constructor(message: string, approvalId: string) {
    super('APPROVAL_REQUIRED', message, approvalId);
  }
}

export class LastPassCredRejectedError extends LastPassCredError {
  constructor(message: string, approvalId: string) {
    super('APPROVAL_REJECTED', message, approvalId);
  }
}

export class LastPassCredFetchError extends LastPassCredError {
  constructor(message: string) {
    super('FETCH_FAILED', message);
  }
}

const DEFAULT_SSH_HOST = 'gregs-mac';
const DEFAULT_REMOTE_SCRIPT = '/Users/gregharned/.cortextos/bin/lastpass-cred-fetch.sh';

function normalizeService(service: string): string {
  const trimmed = service.trim();
  if (!trimmed) {
    throw new LastPassCredFetchError('service is required');
  }
  if (!/^[A-Za-z0-9._/@:+-]+$/.test(trimmed)) {
    throw new LastPassCredFetchError('service may only contain letters, numbers, dot, dash, underscore, slash, at, colon, or plus');
  }
  return trimmed;
}

function markerFor(service: string): string {
  return `lastpass_credential_first_access service=${service}`;
}

function auditPath(paths: BusPaths): string {
  return join(paths.analyticsDir, 'security', 'lastpass-cred-access.jsonl');
}

function audit(paths: BusPaths, agentName: string, org: string, event: string, service: string, meta: Record<string, unknown> = {}): void {
  const file = auditPath(paths);
  ensureDir(join(paths.analyticsDir, 'security'));
  appendFileSync(file, JSON.stringify({
    ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    agent: agentName,
    org,
    event,
    service,
    ...meta,
  }) + '\n', { encoding: 'utf-8', mode: 0o600 });
}

function readApprovals(dir: string): Approval[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .flatMap((name) => {
      try {
        return [JSON.parse(readFileSync(join(dir, name), 'utf-8')) as Approval];
      } catch {
        return [];
      }
    });
}

function findRelevantApproval(paths: BusPaths, service: string): Approval | undefined {
  const marker = markerFor(service);
  const approvals = [
    ...readApprovals(join(paths.approvalDir, 'pending')),
    ...readApprovals(join(paths.approvalDir, 'resolved')),
  ].filter((approval) => approval.description.includes(marker));

  approvals.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return approvals[0];
}

async function ensureFirstAccessApproval(paths: BusPaths, service: string, opts: LastPassCredOptions): Promise<string | undefined> {
  const existing = findRelevantApproval(paths, service);
  if (existing?.status === 'approved') return existing.id;
  if (existing?.status === 'rejected') {
    audit(paths, opts.agentName, opts.org, 'approval_rejected', service, { approval_id: existing.id });
    throw new LastPassCredRejectedError(`first LastPass access for ${service} was rejected`, existing.id);
  }
  if (existing?.status === 'pending') {
    audit(paths, opts.agentName, opts.org, 'approval_pending', service, { approval_id: existing.id });
    throw new LastPassCredApprovalRequiredError(`first LastPass access for ${service} is pending approval`, existing.id);
  }

  const context = [
    `First-access approval for LastPass credential service: ${service}`,
    markerFor(service),
    'Security model: no master password is requested or stored; approved access is audited per invocation.',
  ].join('\n');
  const approvalId = await createApproval(
    paths,
    opts.agentName,
    opts.org,
    `First LastPass credential access: ${service}`,
    'other' as ApprovalCategory,
    context,
    opts.frameworkRoot,
    opts.agentDir,
  );
  audit(paths, opts.agentName, opts.org, 'approval_requested', service, { approval_id: approvalId });
  throw new LastPassCredApprovalRequiredError(`approval requested for first LastPass access to ${service}`, approvalId);
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function fetchFromMac(service: string, opts: LastPassCredOptions): string {
  const host = opts.sshHost || process.env.MAC_SSH_HOST || DEFAULT_SSH_HOST;
  const remoteScript = opts.remoteScript || process.env.LASTPASS_CRED_REMOTE_SCRIPT || DEFAULT_REMOTE_SCRIPT;
  const remoteCommand = `${shellSingleQuote(remoteScript)} ${shellSingleQuote(service)}`;
  const result = spawnSync('ssh', [host, remoteCommand], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });

  if (result.status !== 0) {
    const stderr = result.stderr.trim() || result.error?.message || `ssh exited ${result.status}`;
    throw new LastPassCredFetchError(stderr);
  }

  const credential = result.stdout.replace(/\r?\n$/, '');
  if (!credential) {
    throw new LastPassCredFetchError('Mac fetcher returned empty credential');
  }
  return credential;
}

export async function lastpassCred(paths: BusPaths, serviceInput: string, opts: LastPassCredOptions): Promise<LastPassCredResult> {
  const service = normalizeService(serviceInput);
  const approvalId = await ensureFirstAccessApproval(paths, service, opts);
  audit(paths, opts.agentName, opts.org, 'fetch_started', service, { approval_id: approvalId });

  try {
    const credential = fetchFromMac(service, opts);
    audit(paths, opts.agentName, opts.org, 'fetch_succeeded', service, { approval_id: approvalId });
    return { credential, approvalId };
  } catch (err) {
    audit(paths, opts.agentName, opts.org, 'fetch_failed', service, {
      approval_id: approvalId,
      error: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
    });
    throw err;
  }
}
