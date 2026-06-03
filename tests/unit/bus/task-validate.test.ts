import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { BusPaths } from '../../../src/types';
import { makeTempDir, removeTempDir, makeBusPaths } from '../../setup';
import { validateTask } from '../../../src/bus/task-validate';
import type { PrVerifier } from '../../../src/bus/proof-gate';

function writeTask(paths: BusPaths, taskId: string, task: object) {
  mkdirSync(paths.taskDir, { recursive: true });
  writeFileSync(join(paths.taskDir, `${taskId}.json`), JSON.stringify(task));
}

/** Write a real file under ctxRoot so a relative path claim resolves to it. */
function writeArtifact(paths: BusPaths, rel: string, body = 'artifact body') {
  const abs = join(paths.ctxRoot, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, body);
  return rel;
}

const NOW = () => '2026-06-02T00:00:00Z';

describe('validateTask (artifact proof gate)', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = makeTempDir('cortextos-task-validate-test-');
    paths = makeBusPaths(testDir, 'dev');
  });
  afterEach(() => { removeTempDir(testDir); });

  it('auto-passes when the task has no success_criteria', async () => {
    writeTask(paths, '001', { title: 'No criteria task', status: 'in_progress' });
    const result = await validateTask(paths, '001', undefined, { mode: 'block', now: NOW });
    expect(result.verdict).toBe('pass');
    expect(result.score).toBe(7);
    expect(result.reasoning).toMatch(/auto-pass/i);
  });

  it('fails when the completion result is empty', async () => {
    writeTask(paths, '002', { title: 'Fix bug', status: 'in_progress', success_criteria: 'Bug fixed' });
    const result = await validateTask(paths, '002', undefined, { mode: 'block', now: NOW });
    expect(result.verdict).toBe('fail');
    expect(result.score).toBe(4);
    expect(result.reasoning).toMatch(/empty/i);
  });

  it('block mode: accepts a real, existing file artifact and stamps the proof', async () => {
    writeTask(paths, '003', { title: 'Write recon report', status: 'in_progress', success_criteria: 'Report exists' });
    const rel = writeArtifact(paths, 'orgs/acme/deliverables/recon.md', '# recon');
    const result = await validateTask(paths, '003', `Completed; report at ${rel}`, { mode: 'block', now: NOW });
    expect(result.verdict).toBe('pass');
    expect(result.score).toBeGreaterThanOrEqual(8);
    expect(result.proof?.satisfied).toBe(true);
    expect(result.proof?.artifacts.some(a => a.kind === 'file' && a.verified)).toBe(true);
  });

  it('block mode: rejects the keyword-only false-done that the old gate let through', async () => {
    // Old keyword gate passed this (matches "verified"/"live"/"deployed"/"prod").
    writeTask(paths, '004', { title: 'Fix registry race', status: 'in_progress', success_criteria: 'Race fixed in prod' });
    const result = await validateTask(
      paths, '004',
      'Fixed the registry race and live-verified, deployed to prod.',
      { mode: 'block', now: NOW },
    );
    expect(result.verdict).toBe('needs-revision');
    expect(result.score).toBeLessThan(7);
    expect(result.reasoning).toMatch(/proof gate blocked/i);
    expect(result.proof?.satisfied).toBe(false);
  });

  it('warn mode: surfaces the same gap but does NOT block (rollout default)', async () => {
    writeTask(paths, '005', { title: 'Fix registry race', status: 'in_progress', success_criteria: 'Race fixed in prod' });
    const result = await validateTask(
      paths, '005',
      'Fixed the registry race and live-verified, deployed to prod.',
      { mode: 'warn', now: NOW },
    );
    expect(result.verdict).toBe('pass');
    expect(result.score).toBeGreaterThanOrEqual(7);
    expect(result.reasoning).toMatch(/warn/i);
    expect(result.proof?.satisfied).toBe(false);
  });

  it('off mode: restores legacy keyword scoring (clean rollback)', async () => {
    writeTask(paths, '006', { title: 'Deploy app', status: 'in_progress', success_criteria: 'App live' });
    const result = await validateTask(paths, '006', 'Deployed to prod at 14:00 UTC', { mode: 'off', now: NOW });
    expect(result.verdict).toBe('pass');
    expect(result.score).toBeGreaterThanOrEqual(7);
    expect(result.proof).toBeUndefined();
  });

  it('block mode: accepts a merged PR confirmed by the injected gh verifier', async () => {
    writeTask(paths, '007', { title: 'Ship fix', status: 'in_progress', success_criteria: 'PR merged to main' });
    const merged: PrVerifier = () => ({ merged: true, sha: '1a2b3c4d5e6f' });
    const result = await validateTask(
      paths, '007',
      'Shipped in https://github.com/RevOps-Global-GIT/rgos/pull/42',
      { mode: 'block', verifyPr: merged, now: NOW },
    );
    expect(result.verdict).toBe('pass');
    expect(result.proof?.artifacts.some(a => a.kind === 'pr' && a.verified)).toBe(true);
  });

  it('block mode: a UI/scroll task needs visual evidence', async () => {
    writeTask(paths, '008', { title: 'Fix safe-area scroll clipping', status: 'in_progress', success_criteria: 'Not clipped' });
    const rel = writeArtifact(paths, 'src/Panel.tsx', 'export const Panel = () => null;');

    const textOnly = await validateTask(paths, '008', `Edited ${rel}; scroll works now`, { mode: 'block', now: NOW });
    expect(textOnly.verdict).toBe('needs-revision');
    expect(textOnly.reasoning).toMatch(/visual|recording|screenshot/i);

    const recRel = writeArtifact(paths, 'evidence/scroll.mp4', 'MP4');
    const withRec = await validateTask(paths, '008', `Edited ${rel}; recording at ${recRel}`, { mode: 'block', now: NOW });
    expect(withRec.verdict).toBe('pass');
    expect(withRec.score).toBe(9);
  });

  it('block mode: a substantial pasted command-output block satisfies the floor', async () => {
    writeTask(paths, '009', { title: 'Run the suite', status: 'in_progress', success_criteria: 'Suite green' });
    const out = [
      '$ npx vitest run tests/unit/bus',
      ' RUN  v1.6.0',
      ' tests/unit/bus/task-validate.test.ts:1:1',
      ' Test Files  1 passed (1)',
      '      Tests  9 passed (9)',
    ].join('\n');
    const result = await validateTask(paths, '009', out, { mode: 'block', now: NOW });
    expect(result.verdict).toBe('pass');
  });
});
