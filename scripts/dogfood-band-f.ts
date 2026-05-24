#!/usr/bin/env node
/**
 * Band F dogfood validation checks.
 *
 * Asset size budget gate:
 *   - scan public/vignettes, public/heroes, and public/reference
 *   - fail any image above 500KB or above 2K on either dimension
 *   - emit a mozjpeg compression suggestion for oversized JPEGs
 */

import * as fs from 'fs';
import * as path from 'path';
import { fingerprint, type CheckResult } from './dogfood-check-result';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ASSET_ROOT = path.resolve(process.env.DOGFOOD_BAND_F_ASSET_ROOT ?? process.env.OB1_APP_ROOT ?? REPO_ROOT);
const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const OUTPUT_DIR = process.env.DOGFOOD_OUTPUT_DIR
  ? path.resolve(process.env.DOGFOOD_OUTPUT_DIR)
  : path.resolve(REPO_ROOT, 'orgs/revops-global/agents/hub-dogfood/output/band-f', RUN_STAMP);
const MAX_BYTES = Number.parseInt(process.env.DOGFOOD_BAND_F_MAX_BYTES ?? String(500 * 1024), 10);
const MAX_DIMENSION = Number.parseInt(process.env.DOGFOOD_BAND_F_MAX_DIMENSION ?? '2048', 10);
const TARGET_DIRS = ['public/vignettes', 'public/heroes', 'public/reference'];
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);

interface AssetFinding {
  relPath: string;
  bytes: number;
  width?: number;
  height?: number;
  failures: string[];
  suggestion: string;
}

const results: CheckResult[] = [];
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

function record(result: CheckResult): void {
  results.push(result);
  const icon = result.status === 'PASS' ? '✓' : result.status === 'FAIL' ? '✗' : result.status === 'WARN' ? '!' : '-';
  console.log(`${result.status.padEnd(4)} ${icon} ${fingerprint(result)}`);
  if (result.status !== 'PASS') console.log(`       ${result.evidence}`);
}

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(fullPath);
    else if (entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) yield fullPath;
  }
}

function readUInt24BE(buffer: Buffer, offset: number): number {
  return (buffer[offset] << 16) + (buffer[offset + 1] << 8) + buffer[offset + 2];
}

function imageDimensions(filePath: string): { width?: number; height?: number; type: string } {
  const buffer = fs.readFileSync(filePath);
  if (buffer.length < 32) return { type: 'unknown' };
  if (buffer.readUInt32BE(0) === 0x89504e47) {
    return { type: 'png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset < buffer.length - 9) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      if (length < 2) break;
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        return { type: 'jpeg', height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      offset += 2 + length;
    }
    return { type: 'jpeg' };
  }
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    const fourcc = buffer.toString('ascii', 12, 16);
    if (fourcc === 'VP8X' && buffer.length >= 30) {
      return { type: 'webp', width: 1 + readUInt24BE(buffer, 24), height: 1 + readUInt24BE(buffer, 27) };
    }
    if (fourcc === 'VP8 ' && buffer.length >= 30) {
      return { type: 'webp', width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
    }
    if (fourcc === 'VP8L' && buffer.length >= 25) {
      const bits = buffer.readUInt32LE(21);
      return { type: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    return { type: 'webp' };
  }
  if (buffer.toString('ascii', 0, 3) === 'GIF') {
    return { type: 'gif', width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  return { type: 'unknown' };
}

function compressionSuggestion(relPath: string, fullPath: string, dims: { width?: number; height?: number; type: string }): string {
  const quoted = relPath.replace(/'/g, "'\\''");
  const ext = path.extname(fullPath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') {
    return `mozjpeg -quality 82 -progressive -outfile '${quoted}.tmp' '${quoted}' && mv '${quoted}.tmp' '${quoted}'`;
  }
  if (dims.width && dims.height && (dims.width > MAX_DIMENSION || dims.height > MAX_DIMENSION)) {
    return `resize to <=${MAX_DIMENSION}px on the longest edge, then encode JPEG with mozjpeg quality 82 progressive`;
  }
  return `re-encode/compress asset; JPEG targets should use mozjpeg quality 82 progressive`;
}

function scanAssets(): AssetFinding[] {
  const findings: AssetFinding[] = [];
  for (const relDir of TARGET_DIRS) {
    const absDir = path.join(ASSET_ROOT, relDir);
    if (!fs.existsSync(absDir)) continue;
    for (const fullPath of walk(absDir)) {
      const stat = fs.statSync(fullPath);
      const relPath = path.relative(ASSET_ROOT, fullPath);
      const dims = imageDimensions(fullPath);
      const failures: string[] = [];
      if (stat.size > MAX_BYTES) failures.push(`size ${(stat.size / 1024).toFixed(1)}KB > ${(MAX_BYTES / 1024).toFixed(0)}KB`);
      if (dims.width && dims.width > MAX_DIMENSION) failures.push(`width ${dims.width}px > ${MAX_DIMENSION}px`);
      if (dims.height && dims.height > MAX_DIMENSION) failures.push(`height ${dims.height}px > ${MAX_DIMENSION}px`);
      if (failures.length) {
        findings.push({
          relPath,
          bytes: stat.size,
          width: dims.width,
          height: dims.height,
          failures,
          suggestion: compressionSuggestion(relPath, fullPath, dims),
        });
      }
    }
  }
  return findings;
}

function writeReport(findings: AssetFinding[]): string {
  const rows = findings.map(finding =>
    `| ${finding.relPath} | ${(finding.bytes / 1024).toFixed(1)}KB | ${finding.width ?? '?'}x${finding.height ?? '?'} | ${finding.failures.join('; ').replace(/\|/g, '/')} | \`${finding.suggestion.replace(/`/g, "'")}\` |`
  ).join('\n');
  const report = [
    '# Dogfood Band F Asset Budget Report',
    '',
    `Run: ${RUN_STAMP}`,
    `Asset root: ${ASSET_ROOT}`,
    `Directories: ${TARGET_DIRS.join(', ')}`,
    `Budget: <=${(MAX_BYTES / 1024).toFixed(0)}KB and <=${MAX_DIMENSION}px on either dimension`,
    `Failures: ${findings.length}`,
    '',
    '| Asset | Size | Dimensions | Failure | Suggested Fix |',
    '|---|---:|---:|---|---|',
    rows || '| none | 0KB | n/a | none | n/a |',
    '',
  ].join('\n');
  const reportPath = path.join(OUTPUT_DIR, 'report.md');
  fs.writeFileSync(reportPath, report, 'utf8');
  return reportPath;
}

function main(): void {
  const availableDirs = TARGET_DIRS.filter(relDir => fs.existsSync(path.join(ASSET_ROOT, relDir)));
  if (availableDirs.length === 0) {
    record({
      id: 'band-f-asset-root-present',
      surface: 'asset-budget',
      route: ASSET_ROOT,
      status: 'SKIP',
      severity: 'P2',
      check_label: 'Asset budget target directories present',
      evidence: `No target directories found under ${ASSET_ROOT}; set DOGFOOD_BAND_F_ASSET_ROOT to the app checkout.`,
    });
    writeReport([]);
    process.exit(0);
  }

  const findings = scanAssets();
  const reportPath = writeReport(findings);
  if (findings.length === 0) {
    record({
      id: 'band-f-asset-budget',
      surface: 'asset-budget',
      route: ASSET_ROOT,
      status: 'PASS',
      severity: 'P1',
      check_label: 'Images stay within 500KB and 2K budget',
      evidence: `Scanned ${availableDirs.join(', ')}; no oversized assets. Report: ${reportPath}`,
    });
    process.exit(0);
  }

  findings.forEach(finding => record({
    id: `band-f-${finding.relPath.replace(/[^a-z0-9]+/gi, '-')}`,
    surface: 'asset-budget',
    route: finding.relPath,
    status: 'FAIL',
    severity: 'P1',
    check_label: 'Image stays within 500KB and 2K budget',
    evidence: `${finding.failures.join('; ')}. Suggested fix: ${finding.suggestion}`,
  }));
  console.error(`Dogfood Band F failed: ${findings.length} oversized asset(s). Report: ${reportPath}`);
  process.exit(1);
}

main();
