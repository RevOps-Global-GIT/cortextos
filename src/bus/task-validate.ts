import { readFileSync } from 'fs';
import { findTaskFile } from './task.js';
import type { Task, BusPaths } from '../types/index.js';

export interface ValidationResult {
  score: number;           // 1–10
  verdict: 'pass' | 'fail' | 'needs-revision';
  reasoning: string;
  task_id: string;
}

function validateLocally(task: Task, taskId: string, resultOverride?: string): ValidationResult {
  const completionResult = String(resultOverride ?? task.result ?? '').trim();
  if (!task.success_criteria) {
    return {
      score: 7,
      verdict: 'pass',
      reasoning: 'No success_criteria defined; local validation auto-passed.',
      task_id: taskId,
    };
  }

  if (!completionResult) {
    return {
      score: 4,
      verdict: 'fail',
      reasoning: 'Completion result is empty, so success criteria cannot be evaluated locally.',
      task_id: taskId,
    };
  }

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

export async function validateTask(
  paths: BusPaths,
  taskId: string,
  result?: string,
): Promise<ValidationResult> {
  const filePath = findTaskFile(paths, taskId);
  if (!filePath) throw new Error(`Task ${taskId} not found`);

  const task: Task = JSON.parse(readFileSync(filePath, 'utf-8'));
  return validateLocally(task, taskId, result);
}
