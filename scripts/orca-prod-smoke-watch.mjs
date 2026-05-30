#!/usr/bin/env node
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const agentName = process.env.CTX_AGENT_NAME || 'codex-2';
const outputRoot = path.join(repoRoot, 'orgs/revops-global/agents', agentName, 'output/orca-prod-smoke-watch');
const runStamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.join(outputRoot, runStamp);
const url = process.env.ORCA_PROD_URL || 'https://orca.revopsglobal.com/';

const checks = [
  { label: 'root', path: '/' },
  { label: 'manifest-webmanifest', path: '/manifest.webmanifest', optional: true },
  { label: 'manifest-json', path: '/manifest.json', optional: true },
  { label: 'apple-touch-icon', path: '/apple-touch-icon.png' },
  { label: 'favicon', path: '/favicon.ico', optional: true },
  { label: 'voice-token-unauthorized-shape', path: '/api/voice-token', optional: true },
];

function target(pathname) {
  return new URL(pathname, url).toString();
}

async function curlCheck(check) {
  const startedAt = Date.now();
  const headerFile = path.join(outDir, `${check.label}.headers.txt`);
  const bodyFile = path.join(outDir, `${check.label}.body`);
  const meta = {
    label: check.label,
    url: target(check.path),
    optional: Boolean(check.optional),
    startedAt: new Date().toISOString(),
  };

  try {
    const { stdout, stderr } = await execFileAsync('curl', [
      '--silent',
      '--show-error',
      '--location',
      '--max-time', '15',
      '--connect-timeout', '5',
      '--dump-header', headerFile,
      '--output', bodyFile,
      '--write-out', '\\n%{http_code}\\n%{content_type}\\n%{time_total}\\n%{size_download}',
      meta.url,
    ], { timeout: 20000, maxBuffer: 1024 * 1024 });

    const [statusRaw, contentType, totalRaw, sizeRaw] = stdout.trim().split('\n').slice(-4);
    const status = Number(statusRaw);
    const body = await fs.readFile(bodyFile).catch(() => Buffer.from(''));
    meta.status = status;
    meta.contentType = contentType || null;
    meta.durationMs = Math.round(Number(totalRaw || 0) * 1000);
    meta.size = Number(sizeRaw || body.length || 0);
    meta.stderr = stderr.trim() || null;
    meta.bodyPreview = body.toString('utf8').slice(0, 500);
    meta.ok = status >= 200 && status < 400;
  } catch (error) {
    meta.ok = false;
    meta.error = error.message;
    meta.stdout = error.stdout?.toString?.().slice(0, 500) || '';
    meta.stderr = error.stderr?.toString?.().slice(0, 500) || '';
  }

  meta.finishedAt = new Date().toISOString();
  meta.durationMs = meta.durationMs ?? (Date.now() - startedAt);
  return meta;
}

function rootHasExpectedShape(check) {
  if (!check.ok) return false;
  return /orca|root|app|script|vite|manifest/i.test(check.bodyPreview || '');
}

await fs.mkdir(outDir, { recursive: true });
const results = [];
for (const check of checks) results.push(await curlCheck(check));

const root = results.find((item) => item.label === 'root');
const manifestOk = results.some((item) => item.label.startsWith('manifest-') && item.ok);
const icon = results.find((item) => item.label === 'apple-touch-icon');
const requiredOk = rootHasExpectedShape(root) && manifestOk && icon?.ok;
const hardFailures = results.filter((item) => !item.ok && !item.optional);

const proof = {
  generatedAt: new Date().toISOString(),
  testedUrl: url,
  outputDir: outDir,
  verdict: requiredOk && hardFailures.length === 0 ? 'PASS' : 'FAIL',
  results,
  assertions: {
    rootReachableAndExpectedShape: rootHasExpectedShape(root),
    atLeastOneManifestReachable: manifestOk,
    appleTouchIconReachable: Boolean(icon?.ok),
    noRequiredHttpFailures: hardFailures.length === 0,
  },
};

const report = `# Orca Production Smoke Watch

Generated: ${proof.generatedAt}
URL: ${url}
Verdict: ${proof.verdict}

## Assertions

- Root reachable and expected shape: ${proof.assertions.rootReachableAndExpectedShape ? 'PASS' : 'FAIL'}
- At least one manifest reachable: ${proof.assertions.atLeastOneManifestReachable ? 'PASS' : 'FAIL'}
- Apple touch icon reachable: ${proof.assertions.appleTouchIconReachable ? 'PASS' : 'FAIL'}
- No required HTTP failures: ${proof.assertions.noRequiredHttpFailures ? 'PASS' : 'FAIL'}

## Checks

${results.map((item) => `- ${item.label}: ${item.ok ? 'PASS' : 'FAIL'}${item.optional ? ' (optional)' : ''}; status=${item.status ?? 'n/a'}; type=${item.contentType || 'n/a'}; size=${item.size ?? 'n/a'}; duration=${item.durationMs}ms${item.error ? `; error=${item.error}` : ''}`).join('\n')}

## Artifacts

- proof.json: ${path.join(outDir, 'proof.json')}
- raw headers/bodies: ${outDir}

## Scope

Read-only HTTP/PWA smoke. No deploys, config writes, data mutation, paid tooling, or external alerting.
`;

await fs.writeFile(path.join(outDir, 'proof.json'), JSON.stringify(proof, null, 2));
await fs.writeFile(path.join(outDir, 'report.md'), report);

console.log(JSON.stringify({
  verdict: proof.verdict,
  report: path.join(outDir, 'report.md'),
  outputDir: outDir,
  assertions: proof.assertions,
  checks: results.map(({ label, ok, optional, status, contentType, size, durationMs, error }) => ({
    label,
    ok,
    optional,
    status,
    contentType,
    size,
    durationMs,
    error,
  })),
}, null, 2));

if (proof.verdict !== 'PASS') process.exit(1);
