import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { isAgentDirScaffolded, resolveAgentCwd, resolvePaths } from '../../../src/utils/paths.js';

describe('resolvePaths', () => {
  it('returns paths under ctxRoot when explicitly provided', () => {
    const customRoot = '/custom/ctx/root';
    const paths = resolvePaths('paul', 'default', undefined, customRoot);
    expect(paths.ctxRoot).toBe(customRoot);
    expect(paths.inbox).toBe('/custom/ctx/root/inbox/paul');
    expect(paths.inflight).toBe('/custom/ctx/root/inflight/paul');
    expect(paths.processed).toBe('/custom/ctx/root/processed/paul');
    expect(paths.logDir).toBe('/custom/ctx/root/logs/paul');
    expect(paths.stateDir).toBe('/custom/ctx/root/state/paul');
    expect(paths.taskDir).toBe('/custom/ctx/root/tasks');
    expect(paths.approvalDir).toBe('/custom/ctx/root/approvals');
    expect(paths.analyticsDir).toBe('/custom/ctx/root/analytics');
    expect(paths.deliverablesDir).toBe('/custom/ctx/root/deliverables');
  });

  it('uses homedir() behavior when ctxRoot is not provided', () => {
    const paths = resolvePaths('paul', 'default', undefined);
    expect(paths.ctxRoot).toMatch(/\.cortextos\/default$/);
    expect(paths.inbox).toContain('/.cortextos/default/inbox/paul');
    expect(paths.inflight).toContain('/.cortextos/default/inflight/paul');
    expect(paths.processed).toContain('/.cortextos/default/processed/paul');
    expect(paths.logDir).toContain('/.cortextos/default/logs/paul');
    expect(paths.stateDir).toContain('/.cortextos/default/state/paul');
  });

  it('applies org to org-scoped paths when provided', () => {
    const customRoot = '/custom/ctx/root';
    const paths = resolvePaths('paul', 'default', 'acme', customRoot);
    expect(paths.taskDir).toBe('/custom/ctx/root/orgs/acme/tasks');
    expect(paths.approvalDir).toBe('/custom/ctx/root/orgs/acme/approvals');
    expect(paths.analyticsDir).toBe('/custom/ctx/root/orgs/acme/analytics');
    expect(paths.deliverablesDir).toBe('/custom/ctx/root/orgs/acme/deliverables');
  });

  it('still validates instanceId even when ctxRoot is provided', () => {
    expect(() => resolvePaths('paul', 'invalid/id', undefined, '/custom/root')).toThrow();
    expect(() => resolvePaths('paul', 'Invalid', undefined, '/custom/root')).toThrow();
    expect(() => resolvePaths('paul', '../traversal', undefined, '/custom/root')).toThrow();
    expect(() => resolvePaths('paul', '', undefined, '/custom/root')).toThrow();
    expect(() => resolvePaths('paul', 'My Instance', undefined, '/custom/root')).toThrow();
  });

  it('accepts valid instanceIds with explicit ctxRoot', () => {
    const paths = resolvePaths('paul', 'default', undefined, '/custom/root');
    expect(paths.ctxRoot).toBe('/custom/root');
  });

  it('empty string ctxRoot falls back to homedir default', () => {
    const paths = resolvePaths('paul', 'default', undefined, '');
    expect(paths.ctxRoot).toMatch(/\.cortextos\/default$/);
  });
});

describe('isAgentDirScaffolded', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-paths-scaffold-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns true when AGENTS.md exists in the dir', () => {
    writeFileSync(join(testDir, 'AGENTS.md'), '# agent');
    expect(isAgentDirScaffolded(testDir)).toBe(true);
  });

  it('returns false when AGENTS.md is missing (bare dir)', () => {
    expect(isAgentDirScaffolded(testDir)).toBe(false);
  });

  it('returns false when the dir itself does not exist', () => {
    const missing = join(testDir, 'never-created');
    expect(isAgentDirScaffolded(missing)).toBe(false);
  });

  it('returns false for undefined input', () => {
    expect(isAgentDirScaffolded(undefined)).toBe(false);
  });
});

describe('resolveAgentCwd', () => {
  let testDir: string;
  let agentDir: string;
  let overrideDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-paths-cwd-'));
    agentDir = join(testDir, 'agent');
    overrideDir = join(testDir, 'override');
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(overrideDir, { recursive: true });
    // Default: agentDir is scaffolded (so it's a valid fallback target).
    writeFileSync(join(agentDir, 'AGENTS.md'), '# agent');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns agentDir when no working_directory override is set', () => {
    expect(resolveAgentCwd(agentDir, undefined)).toBe(agentDir);
    expect(resolveAgentCwd(agentDir, '')).toBe(agentDir);
    expect(resolveAgentCwd(agentDir, '   ')).toBe(agentDir);
  });

  it('honors working_directory when the override dir has AGENTS.md', () => {
    writeFileSync(join(overrideDir, 'AGENTS.md'), '# override');
    expect(resolveAgentCwd(agentDir, overrideDir)).toBe(overrideDir);
  });

  it('falls back to agentDir when working_directory has no AGENTS.md and warns', () => {
    // 2026-05-15 regression: director/analyst config.json pointed at
    // /Users/.../work/team-brain which has its own AGENTS.md for a different
    // system. The override dir not being a scaffolded agent must be treated
    // the same as a typo — fall back, do not silently misroute.
    const warn = vi.fn();
    // overrideDir exists but lacks AGENTS.md
    expect(resolveAgentCwd(agentDir, overrideDir, warn)).toBe(agentDir);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/not a scaffolded agent dir/);
  });

  it('falls back to agentDir when working_directory does not exist and warns', () => {
    const warn = vi.fn();
    const missing = join(testDir, 'never-created');
    expect(resolveAgentCwd(agentDir, missing, warn)).toBe(agentDir);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('falls back to process.cwd() when both override and agentDir are unusable', () => {
    expect(resolveAgentCwd(undefined, undefined)).toBe(process.cwd());
  });

  it('does not invoke warn when the override is empty/whitespace', () => {
    const warn = vi.fn();
    resolveAgentCwd(agentDir, '   ', warn);
    expect(warn).not.toHaveBeenCalled();
  });
});
