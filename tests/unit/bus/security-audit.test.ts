/**
 * Unit tests for the security-audit bus module.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execSync: vi.fn() };
});

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, writeFileSync: vi.fn(), mkdirSync: vi.fn() };
});

const { execSync } = await import('child_process');
const { writeFileSync } = await import('fs');
const { runNpmAudit, runSecurityAudit } = await import('../../../src/bus/security-audit.js');

const mockExecSync = vi.mocked(execSync);
const mockWriteFileSync = vi.mocked(writeFileSync);

function makeAuditJson(vulns: Record<string, unknown>): string {
  return JSON.stringify({ vulnerabilities: vulns });
}

beforeEach(() => { vi.resetAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('runNpmAudit', () => {
  it('returns empty vulns when execSync throws', () => {
    mockExecSync.mockImplementation(() => { throw new Error('no npm'); });
    const { vulns } = runNpmAudit('/fake');
    expect(vulns).toEqual([]);
  });

  it('returns empty vulns when output is not valid JSON', () => {
    mockExecSync.mockReturnValue('not json');
    const { vulns } = runNpmAudit('/fake');
    expect(vulns).toEqual([]);
  });

  it('parses critical vulnerability correctly', () => {
    mockExecSync.mockReturnValue(makeAuditJson({
      'lodash': {
        name: 'lodash',
        severity: 'critical',
        via: ['prototype-pollution'],
        fixAvailable: { name: 'lodash', version: '4.17.21', isSemVerMajor: false },
        range: '<4.17.21',
        nodes: ['node_modules/lodash'],
      },
    }));
    const { vulns } = runNpmAudit('/fake');
    expect(vulns).toHaveLength(1);
    expect(vulns[0].severity).toBe('critical');
    expect(vulns[0].name).toBe('lodash');
    expect(vulns[0].fixAvailable).toMatchObject({ name: 'lodash', version: '4.17.21' });
  });

  it('returns empty when vulnerabilities key is missing', () => {
    mockExecSync.mockReturnValue(JSON.stringify({ metadata: {} }));
    const { vulns } = runNpmAudit('/fake');
    expect(vulns).toEqual([]);
  });
});

describe('runSecurityAudit', () => {
  it('writes markdown report and returns result', () => {
    mockExecSync.mockReturnValue(makeAuditJson({
      'axios': {
        name: 'axios',
        severity: 'high',
        via: ['ssrf'],
        fixAvailable: { name: 'axios', version: '1.6.0', isSemVerMajor: false },
        range: '<1.6.0',
        nodes: ['node_modules/axios'],
      },
    }));

    const result = runSecurityAudit('/fake/cwd', '/fake/output/2026-01-01-npm-audit.md');

    expect(mockWriteFileSync).toHaveBeenCalledOnce();
    const [, content] = mockWriteFileSync.mock.calls[0];
    expect(typeof content).toBe('string');
    expect(content as string).toContain('# Security Audit');
    expect(content as string).toContain('axios');
    expect(result.highCount).toBe(1);
    expect(result.actionable).toHaveLength(1);
  });

  it('reports no actionable when fixAvailable is false', () => {
    mockExecSync.mockReturnValue(makeAuditJson({
      'semver': {
        name: 'semver',
        severity: 'high',
        via: ['ReDoS'],
        fixAvailable: false,
        range: '<7.5.2',
        nodes: ['node_modules/semver'],
      },
    }));

    const result = runSecurityAudit('/fake/cwd', '/fake/output/2026-01-01-npm-audit.md');
    expect(result.actionable).toHaveLength(0);
    expect(result.highCount).toBe(1);
  });

  it('returns zero counts on empty audit', () => {
    mockExecSync.mockReturnValue(makeAuditJson({}));
    const result = runSecurityAudit('/fake/cwd', '/fake/output/2026-01-01-npm-audit.md');
    expect(result.criticalCount).toBe(0);
    expect(result.highCount).toBe(0);
    expect(result.actionable).toHaveLength(0);
  });
});
