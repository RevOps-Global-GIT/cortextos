import { existsSync, readFileSync, realpathSync } from 'fs';
import { join } from 'path';

// orch_approvals.org_id / orch_experiments.org_id is a UUID FK to
// organizations.id (RevOps Global). Both Supabase write paths
// (src/bus/approval.ts and src/bus/experiment.ts) tag rows with this UUID,
// so the same authorization gate must protect both — otherwise any cortextOS
// instance holding shared Supabase service creds can bleed approval/experiment
// rows into the RevOps queue under the hardcoded fallback.
export const REVOPS_ORG_UUID =
  process.env.SUPABASE_RGOS_ORG_UUID || 'a1b2c3d4-0000-0000-0000-000000000001';
export const REVOPS_ORG_SLUG = 'revops-global';

export type RevopsWriterAuth = {
  authorized: boolean;
  reason?: string;
};

export function isRevopsOrg(org: string): boolean {
  return org.trim().toLowerCase() === REVOPS_ORG_SLUG;
}

// Canonical agent dir layout is <frameworkRoot>/orgs/<org>/agents/<agent>.
// The experiment sync path only receives agentDir, so org / agentName /
// frameworkRoot are recovered from it. A path that does not match (e.g. a
// process.cwd() fallback) yields nulls, which callers treat as "cannot prove
// authorization" → skip the RevOps write.
const AGENT_DIR_RE = /^(.*)\/orgs\/([^/]+)\/agents\/([^/]+)\/?$/;

export function deriveOrgFromAgentDir(agentDir: string | undefined): string | null {
  if (!agentDir) return null;
  const m = agentDir.match(AGENT_DIR_RE);
  return m ? m[2] : null;
}

export function deriveAgentNameFromAgentDir(agentDir: string | undefined): string | null {
  if (!agentDir) return null;
  const m = agentDir.match(AGENT_DIR_RE);
  return m ? m[3] : null;
}

export function deriveFrameworkRootFromAgentDir(agentDir: string | undefined): string | null {
  if (!agentDir) return null;
  const m = agentDir.match(AGENT_DIR_RE);
  return m ? m[1] : null;
}

function realPathIfExists(filePath: string): string | null {
  try {
    return realpathSync(filePath);
  } catch {
    return null;
  }
}

// The writer must be listed as an enabled, non-decommissioned agent for `org`
// in the instance's enabled-agents.json registry.
export function enabledRegistryAuthorizes(
  ctxRoot: string,
  agentName: string,
  org: string,
): boolean {
  const registryPath = join(ctxRoot, 'config', 'enabled-agents.json');
  if (!existsSync(registryPath)) return false;

  let registry: unknown;
  try {
    registry = JSON.parse(readFileSync(registryPath, 'utf-8'));
  } catch {
    return false;
  }

  let record: Record<string, unknown> | undefined;
  if (Array.isArray(registry)) {
    const found = registry.find((entry) => {
      if (!entry || typeof entry !== 'object') return false;
      const item = entry as Record<string, unknown>;
      return item.name === agentName || item.agent_name === agentName;
    });
    record = found && typeof found === 'object' ? found as Record<string, unknown> : undefined;
  } else if (registry && typeof registry === 'object') {
    const value = (registry as Record<string, unknown>)[agentName];
    record = value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
  }

  if (!record) return false;
  if (record.org !== org) return false;
  if (record.enabled !== true) return false;
  if (record.status === 'deleted' || record.decommissioned === true) return false;
  return true;
}

// The agentDir must resolve to the framework's provisioned dir for that
// org/agent. realpath comparison defeats symlink/relative-path spoofing.
export function frameworkAgentDirAuthorizes(
  agentName: string,
  org: string,
  frameworkRoot: string | undefined,
  agentDir: string | undefined,
): boolean {
  if (!frameworkRoot) return false;

  const expectedAgentDir = join(frameworkRoot, 'orgs', org, 'agents', agentName);
  if (!existsSync(join(expectedAgentDir, 'config.json'))) return false;

  if (!agentDir) return false;
  const expectedReal = realPathIfExists(expectedAgentDir);
  const agentDirReal = realPathIfExists(agentDir);
  if (!expectedReal || !agentDirReal) return false;
  return agentDirReal === expectedReal;
}

/**
 * Gate a writer attempting to create a RevOps-org Supabase row.
 *
 * Non-revops orgs are returned authorized — callers that hardcode the RevOps
 * org_id must instead pre-screen with isRevopsOrg() and skip the write, since
 * a non-revops writer has no business tagging a RevOps row. For revops-global
 * writers, BOTH the enabled-agents registry AND the framework agent dir must
 * confirm the identity.
 */
export function authorizeRevopsWriter(args: {
  ctxRoot: string;
  agentName: string;
  org: string;
  frameworkRoot: string | undefined;
  agentDir: string | undefined;
}): RevopsWriterAuth {
  const { ctxRoot, agentName, org, frameworkRoot, agentDir } = args;
  if (!isRevopsOrg(org)) return { authorized: true };

  if (!enabledRegistryAuthorizes(ctxRoot, agentName, org)) {
    return {
      authorized: false,
      reason: `${agentName} is not enabled for ${org} in ${join(ctxRoot, 'config', 'enabled-agents.json')}`,
    };
  }

  if (!frameworkAgentDirAuthorizes(agentName, org, frameworkRoot, agentDir)) {
    return {
      authorized: false,
      reason: `${agentName} does not resolve to a provisioned ${org} agent directory`,
    };
  }

  return { authorized: true };
}
