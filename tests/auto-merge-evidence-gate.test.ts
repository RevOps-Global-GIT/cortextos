/**
 * Regression tests for the screenshot-evidence-gate hard enforcement.
 *
 * Gate contract:
 *   - Visual PR (touches .tsx/.css/.scss) with MISSING gate → SKIP
 *   - Visual PR with FAILED gate → SKIP
 *   - Visual PR with PASSED gate → ALLOW
 *   - Non-visual PR with MISSING gate → ALLOW (gate not required)
 *   - Non-visual PR with FAILED gate → SKIP (gate ran and explicitly rejected)
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  getEvidenceGateResult,
  EVIDENCE_GATE_NAME,
  VISUAL_EXTS_RE,
} = require('../scripts/auto-merge-pr.js');
import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRun(name: string, status: string, conclusion: string | null, startedAt = '2026-01-01T00:00:00Z') {
  return { name, status, conclusion, started_at: startedAt };
}

// ---------------------------------------------------------------------------
// getEvidenceGateResult
// ---------------------------------------------------------------------------

describe('getEvidenceGateResult', () => {
  it('returns "missing" when runs array is empty', () => {
    expect(getEvidenceGateResult([])).toBe('missing');
  });

  it('returns "missing" when runs is null/undefined', () => {
    expect(getEvidenceGateResult(null)).toBe('missing');
    expect(getEvidenceGateResult(undefined)).toBe('missing');
  });

  it('returns "missing" when the gate check-run is not present', () => {
    const runs = [
      makeRun('build', 'completed', 'success'),
      makeRun('lint', 'completed', 'success'),
    ];
    expect(getEvidenceGateResult(runs)).toBe('missing');
  });

  it('returns "missing" when the gate check-run is still in flight', () => {
    const runs = [makeRun(EVIDENCE_GATE_NAME, 'in_progress', null)];
    expect(getEvidenceGateResult(runs)).toBe('missing');
  });

  it('returns "passed" when the gate check-run concluded success', () => {
    const runs = [makeRun(EVIDENCE_GATE_NAME, 'completed', 'success')];
    expect(getEvidenceGateResult(runs)).toBe('passed');
  });

  it('returns "failed" when the gate check-run concluded failure', () => {
    const runs = [makeRun(EVIDENCE_GATE_NAME, 'completed', 'failure')];
    expect(getEvidenceGateResult(runs)).toBe('failed');
  });

  it('returns "failed" for non-success conclusions (timed_out, cancelled, action_required)', () => {
    for (const conclusion of ['timed_out', 'cancelled', 'action_required']) {
      expect(getEvidenceGateResult([makeRun(EVIDENCE_GATE_NAME, 'completed', conclusion)])).toBe('failed');
    }
  });

  it('picks the latest run by started_at when multiple gate runs exist', () => {
    const runs = [
      makeRun(EVIDENCE_GATE_NAME, 'completed', 'failure', '2026-01-01T00:00:00Z'),
      makeRun(EVIDENCE_GATE_NAME, 'completed', 'success', '2026-01-01T01:00:00Z'), // newer
    ];
    expect(getEvidenceGateResult(runs)).toBe('passed');
  });

  it('is not confused by other check names that share a prefix', () => {
    const runs = [
      makeRun('screenshot-evidence-gate-extra', 'completed', 'success'),
      makeRun('screenshot', 'completed', 'success'),
    ];
    expect(getEvidenceGateResult(runs)).toBe('missing');
  });
});

// ---------------------------------------------------------------------------
// VISUAL_EXTS_RE — .tsx / .css / .scss detection
// ---------------------------------------------------------------------------

describe('VISUAL_EXTS_RE', () => {
  it('matches .tsx files', () => {
    expect(VISUAL_EXTS_RE.test('src/pages/Fleet.tsx')).toBe(true);
    expect(VISUAL_EXTS_RE.test('components/Button.tsx')).toBe(true);
  });

  it('matches .css files', () => {
    expect(VISUAL_EXTS_RE.test('styles/main.css')).toBe(true);
  });

  it('matches .scss files', () => {
    expect(VISUAL_EXTS_RE.test('styles/theme.scss')).toBe(true);
  });

  it('does not match non-visual extensions', () => {
    for (const f of ['src/api/route.ts', 'scripts/foo.js', 'README.md', 'src/hooks/useFoo.ts']) {
      expect(VISUAL_EXTS_RE.test(f)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Integration-style: gate decision table (no real GitHub calls needed)
// The main loop logic is: if (evidenceGate !== 'passed') {
//   const hasVisual = evidenceGate === 'failed' || prHasVisualFiles(...);
//   if (hasVisual) SKIP;
// }
// These tests verify the pure-logic gate scenarios using getEvidenceGateResult.
// ---------------------------------------------------------------------------

describe('evidence gate decision table', () => {
  // Build a run-set that yields a given gate result
  function runsFor(result: 'passed' | 'failed' | 'missing') {
    if (result === 'passed') return [makeRun(EVIDENCE_GATE_NAME, 'completed', 'success')];
    if (result === 'failed') return [makeRun(EVIDENCE_GATE_NAME, 'completed', 'failure')];
    return [makeRun('build', 'completed', 'success')]; // no gate run → missing
  }

  it('visual PR + missing gate → evidenceGate=missing (should block)', () => {
    expect(getEvidenceGateResult(runsFor('missing'))).toBe('missing');
    // hasVisual=true (via prHasVisualFiles), gate !== passed → SKIP ✓
  });

  it('visual PR + failed gate → evidenceGate=failed (should block)', () => {
    expect(getEvidenceGateResult(runsFor('failed'))).toBe('failed');
    // evidenceGate==='failed' → hasVisual=true unconditionally → SKIP ✓
  });

  it('visual PR + passing gate → evidenceGate=passed (should allow)', () => {
    expect(getEvidenceGateResult(runsFor('passed'))).toBe('passed');
    // evidenceGate==='passed' → gate check is skipped entirely → ALLOW ✓
  });

  it('non-visual PR + missing gate → evidenceGate=missing but hasVisual=false (should allow)', () => {
    expect(getEvidenceGateResult(runsFor('missing'))).toBe('missing');
    // evidenceGate==='missing' AND prHasVisualFiles()===false → hasVisual=false → ALLOW ✓
  });
});
