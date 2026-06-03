import { readFileSync } from 'fs';
import { findTaskFile } from './task.js';
import {
  evaluateProof,
  buildProofStamp,
  type ProofEvaluation,
  type ProofGateMode,
  type ProofStamp,
  type PrVerifier,
} from './proof-gate.js';
import type { Task, BusPaths } from '../types/index.js';

export interface ValidationResult {
  score: number;           // 1–10
  verdict: 'pass' | 'fail' | 'needs-revision';
  reasoning: string;
  task_id: string;
  /** Stampable proof summary when the artifact gate ran (omitted for off-mode / no-criteria / empty). */
  proof?: ProofStamp;
}

export interface ValidateOptions {
  /** Gate enforcement level (resolved by the caller). Defaults to 'warn'. */
  mode?: ProofGateMode;
  /** Extra roots to resolve relative file paths against (e.g. [ctxRoot]). */
  roots?: string[];
  /** Working directory for resolving relative paths. */
  cwd?: string;
  /** Injected PR verifier (tests). Defaults to a `gh`-backed check inside the gate. */
  verifyPr?: PrVerifier;
  /** Clock for the proof stamp's checked_at. Defaults to wall clock. */
  now?: () => string;
}

/**
 * Legacy keyword scoring — retained only for `mode: 'off'`, so disabling the
 * artifact gate restores the previous behavior exactly (clean rollback).
 * Do NOT extend this; it is the heuristic the proof gate replaces.
 */
function legacyScore(completionResult: string, taskId: string): ValidationResult {
  const lower = completionResult.toLowerCase();
  const hasBlocker =
    /\b(blocked|blocker|approval|owner|human|cannot proceed|next action|exact blocker)\b/.test(lower);
  const hasProof =
    /\b(pr\s*#?\d+|commit|sha|diff|patch|test|tests|passed|green|proof|report|artifact|screenshot|build|typecheck|verified|validated|deployed|deployment|live|prod|production|http|\/[\w.-]+|no deploy|no merge)\b/.test(lower);

  if (hasProof || hasBlocker) {
    return {
      score: hasProof && hasBlocker ? 8 : 7,
      verdict: 'pass',
      reasoning: hasBlocker
        ? 'Completion includes a concrete blocker or owner next action; accepted by local validation.'
        : 'Completion includes concrete proof or deliverable references; accepted by local validation.',
      task_id: taskId,
    };
  }
  if (completionResult.length < 80) {
    return {
      score: 5,
      verdict: 'needs-revision',
      reasoning: 'Completion result is too terse and lacks proof, artifact, or blocker details.',
      task_id: taskId,
    };
  }
  return {
    score: 6,
    verdict: 'needs-revision',
    reasoning: 'Completion result is descriptive but lacks explicit proof, artifact, or blocker evidence.',
    task_id: taskId,
  };
}

/** Short human summary of the accepted artifacts, for the validation reasoning line. */
function describeAccepted(evaln: ProofEvaluation): string {
  const parts = evaln.accepted.slice(0, 4).map(a => {
    switch (a.kind) {
      case 'file': return `file ${a.claim}`;
      case 'recording': return `recording/screenshot ${a.claim}`;
      case 'pr': return `merged ${a.claim}`;
      case 'image-link': return 'embedded image evidence';
      case 'command-output': return 'pasted command output';
      default: return a.kind;
    }
  });
  return parts.length ? parts.join('; ') : 'no artifacts';
}

function evaluateCompletion(
  task: Task,
  taskId: string,
  resultOverride: string | undefined,
  opts: ValidateOptions,
): ValidationResult {
  const completion = String(resultOverride ?? task.result ?? '').trim();
  const mode: ProofGateMode = opts.mode ?? 'warn';

  if (!task.success_criteria) {
    return {
      score: 7,
      verdict: 'pass',
      reasoning: 'No success_criteria defined; local validation auto-passed.',
      task_id: taskId,
    };
  }

  if (!completion) {
    return {
      score: 4,
      verdict: 'fail',
      reasoning: 'Completion result is empty, so success criteria cannot be evaluated locally.',
      task_id: taskId,
    };
  }

  if (mode === 'off') {
    return legacyScore(completion, taskId);
  }

  const evaln = evaluateProof(task, completion, {
    roots: opts.roots,
    cwd: opts.cwd,
    verifyPr: opts.verifyPr,
  });
  const checkedAt = (opts.now ?? (() => new Date().toISOString()))();

  if (evaln.satisfied) {
    return {
      score: evaln.hasRecording ? 9 : 8,
      verdict: 'pass',
      reasoning: `Proof gate passed (${mode}): ${describeAccepted(evaln)}.`,
      task_id: taskId,
      proof: buildProofStamp(mode, evaln, checkedAt),
    };
  }

  if (mode === 'warn') {
    return {
      score: 7,
      verdict: 'pass',
      reasoning: `Proof gate WARNING (warn-mode rollout, not blocking): ${evaln.missing}`,
      task_id: taskId,
      proof: buildProofStamp(mode, evaln, checkedAt, 'warn-mode: accepted without a verifiable artifact'),
    };
  }

  // mode === 'block'
  return {
    score: 5,
    verdict: 'needs-revision',
    reasoning: `Proof gate blocked: ${evaln.missing}`,
    task_id: taskId,
    proof: buildProofStamp(mode, evaln, checkedAt, 'blocked: no verifiable artifact'),
  };
}

export async function validateTask(
  paths: BusPaths,
  taskId: string,
  result?: string,
  opts: ValidateOptions = {},
): Promise<ValidationResult> {
  const filePath = findTaskFile(paths, taskId);
  if (!filePath) throw new Error(`Task ${taskId} not found`);

  const task: Task = JSON.parse(readFileSync(filePath, 'utf-8'));
  // Resolve task-relative file claims against the ctx root by default.
  const roots = opts.roots ?? [paths.ctxRoot];
  return evaluateCompletion(task, taskId, result, { ...opts, roots });
}
