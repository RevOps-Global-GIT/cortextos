import { execSync } from 'child_process';
import { writeFileSync } from 'fs';
import { ensureDir } from '../utils/atomic.js';

export type Severity = 'critical' | 'high' | 'moderate' | 'low' | 'info';

export interface AuditVuln {
  name: string;
  severity: Severity;
  via: string[];
  fixAvailable: boolean | { name: string; version: string; isSemVerMajor: boolean };
  range: string;
  nodes: string[];
}

export interface SecurityAuditResult {
  date: string;
  cwd: string;
  vulns: AuditVuln[];
  criticalCount: number;
  highCount: number;
  actionable: AuditVuln[];
}

const ACTIONABLE_SEVERITIES: Severity[] = ['critical', 'high'];

/**
 * Run `npm audit --json` in the given directory and parse the output.
 * Returns an empty result (no error thrown) if npm audit is unavailable or
 * the directory has no package.json.
 */
export function runNpmAudit(cwd: string): { vulns: AuditVuln[]; rawJson: string } {
  let raw = '';
  try {
    // npm audit exits non-zero when vulnerabilities are found — ignore exit code
    raw = execSync('npm audit --json 2>/dev/null || true', {
      cwd,
      encoding: 'utf-8',
      timeout: 60000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return { vulns: [], rawJson: '' };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { vulns: [], rawJson: raw };
  }

  const vulnerabilities = parsed['vulnerabilities'] as Record<string, unknown> | undefined;
  if (!vulnerabilities) return { vulns: [], rawJson: raw };

  const vulns: AuditVuln[] = [];
  for (const [, v] of Object.entries(vulnerabilities)) {
    const vuln = v as Record<string, unknown>;
    vulns.push({
      name: String(vuln['name'] ?? ''),
      severity: String(vuln['severity'] ?? 'low') as Severity,
      via: Array.isArray(vuln['via'])
        ? vuln['via'].map(x => (typeof x === 'string' ? x : String((x as Record<string, unknown>)['name'] ?? x)))
        : [],
      fixAvailable: (vuln['fixAvailable'] as AuditVuln['fixAvailable']) ?? false,
      range: String(vuln['range'] ?? ''),
      nodes: Array.isArray(vuln['nodes']) ? vuln['nodes'].map(String) : [],
    });
  }

  return { vulns, rawJson: raw };
}

/**
 * Run the full security audit and write a Markdown report.
 *
 * @param cwd         Directory to audit (must contain package.json)
 * @param outputPath  Full path to the output .md file
 */
export function runSecurityAudit(cwd: string, outputPath: string): SecurityAuditResult {
  const date = new Date().toISOString().slice(0, 10);
  const { vulns } = runNpmAudit(cwd);

  const actionable = vulns.filter(
    v => ACTIONABLE_SEVERITIES.includes(v.severity) && v.fixAvailable !== false,
  );
  const criticalCount = vulns.filter(v => v.severity === 'critical').length;
  const highCount = vulns.filter(v => v.severity === 'high').length;

  const result: SecurityAuditResult = { date, cwd, vulns, criticalCount, highCount, actionable };

  const lines: string[] = [
    `# Security Audit — ${date}`,
    '',
    `**Directory:** \`${cwd}\`  `,
    `**Generated:** ${new Date().toISOString()}`,
    '',
    '## Summary',
    '',
    '| Severity | Count |',
    '|----------|-------|',
    `| Critical | ${criticalCount} |`,
    `| High | ${highCount} |`,
    `| Moderate | ${vulns.filter(v => v.severity === 'moderate').length} |`,
    `| Low | ${vulns.filter(v => v.severity === 'low').length} |`,
    `| **Actionable (critical/high with fix)** | **${actionable.length}** |`,
    '',
  ];

  if (actionable.length === 0) {
    lines.push('_No actionable critical/high vulnerabilities with available fixes._');
  } else {
    lines.push('## Actionable Vulnerabilities', '');
    lines.push('| Package | Severity | Fix Available | Via |');
    lines.push('|---------|----------|---------------|-----|');
    for (const v of actionable) {
      const fix = typeof v.fixAvailable === 'object'
        ? `${v.fixAvailable.name}@${v.fixAvailable.version}${v.fixAvailable.isSemVerMajor ? ' (breaking)' : ''}`
        : 'yes';
      const via = v.via.slice(0, 3).join(', ');
      lines.push(`| \`${v.name}\` | **${v.severity}** | ${fix} | ${via} |`);
    }
  }

  if (vulns.length > 0 && actionable.length < vulns.length) {
    const nonActionable = vulns.filter(v => !actionable.includes(v));
    lines.push('', '## Non-Actionable (no fix available or low severity)', '');
    lines.push('| Package | Severity |');
    lines.push('|---------|----------|');
    for (const v of nonActionable.slice(0, 20)) {
      lines.push(`| \`${v.name}\` | ${v.severity} |`);
    }
    if (nonActionable.length > 20) lines.push(`| _(+${nonActionable.length - 20} more)_ | |`);
  }

  ensureDir(outputPath.replace(/\/[^/]+$/, ''));
  writeFileSync(outputPath, lines.join('\n'), 'utf-8');

  return result;
}
