import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { makeTempDir, removeTempDir } from '../../setup';
import {
  isUiScrollTask,
  extractPaths,
  extractImageLinks,
  extractPrRefs,
  looksLikeCommandOutput,
  evaluateProof,
  resolveProofGateMode,
  buildProofStamp,
  type PrVerifier,
} from '../../../src/bus/proof-gate';

const baseTask = { title: 'Task', description: '', success_criteria: 'It works' };

describe('isUiScrollTask', () => {
  it('flags scroll / safe-area / css work', () => {
    expect(isUiScrollTask({ title: 'Fix safe-area scroll clipping on iOS', description: '', success_criteria: '' })).toBe(true);
    expect(isUiScrollTask({ title: 'Adjust CSS layout on the banner', description: '', success_criteria: '' })).toBe(true);
    expect(isUiScrollTask({ title: 'x', description: '', success_criteria: 'viewport no longer cut off' })).toBe(true);
  });
  it('does not flag non-visual work', () => {
    expect(isUiScrollTask({ title: 'Reconcile GL to subledger', description: 'tie out balances', success_criteria: 'balances match' })).toBe(false);
  });
});

describe('extractPaths', () => {
  it('pulls path-like tokens and bare filenames', () => {
    const paths = extractPaths('Edited src/bus/proof-gate.ts and wrote report.md plus ~/work/out.json');
    expect(paths).toContain('src/bus/proof-gate.ts');
    expect(paths).toContain('report.md');
    expect(paths).toContain('~/work/out.json');
  });
  it('ignores prose, version numbers, and urls', () => {
    const paths = extractPaths('Bumped to 1.2.3 and see https://example.com for the writeup, all good now');
    expect(paths.some(p => p.startsWith('http'))).toBe(false);
    expect(paths).not.toContain('1.2.3');
  });
});

describe('extractImageLinks', () => {
  it('matches markdown images and remote image / host urls', () => {
    expect(extractImageLinks('see ![shot](x.png)').length).toBeGreaterThan(0);
    expect(extractImageLinks('proof at https://i.imgur.com/abc.png').length).toBeGreaterThan(0);
    expect(extractImageLinks('https://res.cloudinary.com/demo/image/upload/v1/x').length).toBeGreaterThan(0);
  });
  it('does not match plain text', () => {
    expect(extractImageLinks('no images here, just words')).toEqual([]);
  });
});

describe('extractPrRefs', () => {
  it('parses full github PR urls into repo + number', () => {
    const refs = extractPrRefs('Merged https://github.com/RevOps-Global-GIT/rgos/pull/42 today');
    expect(refs[0]).toMatchObject({ repo: 'RevOps-Global-GIT/rgos', number: 42 });
  });
  it('parses bare PR numbers', () => {
    const refs = extractPrRefs('Shipped in PR #1307');
    expect(refs.some(r => r.number === 1307)).toBe(true);
  });
});

describe('looksLikeCommandOutput', () => {
  it('accepts a substantial multi-line output block', () => {
    const out = [
      '$ npx vitest run',
      ' RUN  v1.6.0',
      ' tests/unit/bus/task-validate.test.ts:12:5',
      ' Test Files  1 passed (1)',
      '      Tests  6 passed (6)',
    ].join('\n');
    expect(looksLikeCommandOutput(out)).toBe(true);
  });
  it('rejects a bare keyword claim', () => {
    expect(looksLikeCommandOutput('tests passed and everything is green')).toBe(false);
  });
});

describe('evaluateProof', () => {
  let dir: string;
  beforeEach(() => { dir = makeTempDir('cortextos-proof-gate-'); });
  afterEach(() => { removeTempDir(dir); });

  it('accepts an existing, task-specific file as strong proof', () => {
    mkdirSync(join(dir, 'deliverables'), { recursive: true });
    writeFileSync(join(dir, 'deliverables', 'recon-2026.md'), '# recon\nbody');
    const e = evaluateProof(baseTask, 'Wrote the report at deliverables/recon-2026.md', { roots: [dir] });
    expect(e.hasRealArtifact).toBe(true);
    expect(e.satisfied).toBe(true);
    expect(e.accepted[0]).toMatchObject({ kind: 'file', verified: true, strength: 'strong' });
  });

  it('does NOT accept a claimed file that is absent (the false-done hole)', () => {
    const e = evaluateProof(baseTask, 'Fixed and live-verified, updated src/missing/nope.ts', { roots: [dir] });
    expect(e.hasRealArtifact).toBe(false);
    expect(e.satisfied).toBe(false);
    expect(e.missing).toMatch(/does not exist|no verifiable artifact/i);
  });

  it('treats an on-disk screenshot as a recording', () => {
    writeFileSync(join(dir, 'after.png'), 'PNGDATA');
    const e = evaluateProof(baseTask, 'Result captured in after.png', { roots: [dir] });
    expect(e.hasRecording).toBe(true);
    expect(e.accepted.some(a => a.kind === 'recording')).toBe(true);
  });

  it('requires a recording for UI/scroll tasks', () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'Panel.tsx'), 'export const Panel = () => null;');
    const uiTask = { title: 'Fix safe-area scroll clipping', description: '', success_criteria: 'no longer clipped' };
    const textOnly = evaluateProof(uiTask, 'Edited src/Panel.tsx, scroll works now', { roots: [dir] });
    expect(textOnly.requiresRecording).toBe(true);
    expect(textOnly.satisfied).toBe(false);
    expect(textOnly.missing).toMatch(/visual|recording|screenshot/i);

    writeFileSync(join(dir, 'scroll.mp4'), 'MP4');
    const withRec = evaluateProof(uiTask, 'Edited src/Panel.tsx; recording at scroll.mp4', { roots: [dir] });
    expect(withRec.satisfied).toBe(true);
  });

  it('accepts a merged PR via the injected verifier, rejects an unmerged one', () => {
    const merged: PrVerifier = () => ({ merged: true, sha: '1a2b3c4d5e6f' });
    const notMerged: PrVerifier = () => ({ merged: false });
    const text = 'Shipped in https://github.com/RevOps-Global-GIT/rgos/pull/42';
    expect(evaluateProof(baseTask, text, { roots: [dir], verifyPr: merged }).satisfied).toBe(true);
    expect(evaluateProof(baseTask, text, { roots: [dir], verifyPr: notMerged }).satisfied).toBe(false);
  });

  it('does not let a generic config file count as proof on its own', () => {
    writeFileSync(join(dir, 'package.json'), '{}');
    const e = evaluateProof(baseTask, 'Touched package.json', { roots: [dir] });
    expect(e.satisfied).toBe(false);
    expect(e.artifacts[0]).toMatchObject({ kind: 'file', strength: 'weak' });
  });
});

describe('resolveProofGateMode', () => {
  it('prefers env, then org, then defaults to warn', () => {
    expect(resolveProofGateMode({ env: 'block', orgMode: 'off' })).toBe('block');
    expect(resolveProofGateMode({ env: '', orgMode: 'off' })).toBe('off');
    expect(resolveProofGateMode({})).toBe('warn');
    expect(resolveProofGateMode({ env: 'nonsense' })).toBe('warn');
  });
});

describe('buildProofStamp', () => {
  it('captures mode, satisfied, and a bounded artifact list', () => {
    const e = evaluateProof(baseTask, 'tests passed', {});
    const stamp = buildProofStamp('warn', e, '2026-06-02T00:00:00Z', 'warn-mode');
    expect(stamp).toMatchObject({ mode: 'warn', satisfied: false, checked_at: '2026-06-02T00:00:00Z', note: 'warn-mode' });
    expect(Array.isArray(stamp.artifacts)).toBe(true);
  });
});
