/**
 * compute-uvd.ts — Compute UVD/w (Unsupervised Value Deliverables per week)
 *
 * UVD/w counts completed tasks that:
 *   1. Were created by an agent (not a human like greg/user)
 *   2. Have a non-empty result field (tangible output)
 *   3. Were completed within the rolling window
 *   4. Are not internal housekeeping (heartbeat, sync, poll, archive, memory, etc.)
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { Task } from '../types/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Identifiers that indicate a human created the task (not an agent).
 * Case-insensitive substring match against created_by.
 */
const HUMAN_CREATOR_PATTERNS = ['greg', 'user', 'human'];

/**
 * Title substrings that indicate internal housekeeping rather than
 * deliverable work. Case-insensitive.
 */
const HOUSEKEEPING_PATTERNS = [
  'heartbeat',
  'memory',
  'sync',
  'poll',
  'archive',
  'watchdog',
  'cron',
  'inbox drain',
  'vm sync',
  'task poll',
  'codebase scan',
  'no tasks',
  'nothing to do',
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UvdResult {
  date: string;          // YYYY-MM-DD
  window_days: number;
  uvd_count: number;
  uvd_per_day: number;
  tasks_evaluated: number;
  excluded_human_created: number;
  excluded_no_result: number;
  excluded_housekeeping: number;
  excluded_outside_window: number;
  uvd_tasks: UvdTaskSummary[];
}

export interface UvdTaskSummary {
  id: string;
  title: string;
  assigned_to: string;
  created_by: string;
  completed_at: string;
  result_preview: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isHumanCreated(createdBy: string): boolean {
  const lower = createdBy.toLowerCase();
  return HUMAN_CREATOR_PATTERNS.some(p => lower.includes(p));
}

function isHousekeeping(title: string): boolean {
  const lower = title.toLowerCase();
  return HOUSEKEEPING_PATTERNS.some(p => lower.includes(p));
}

function readTasksFromDir(dir: string): Task[] {
  if (!existsSync(dir)) return [];
  const tasks: Task[] = [];
  let files: string[];
  try {
    files = readdirSync(dir).filter(f => f.startsWith('task_') && f.endsWith('.json'));
  } catch {
    return [];
  }
  for (const file of files) {
    try {
      const raw = readFileSync(join(dir, file), 'utf-8');
      tasks.push(JSON.parse(raw) as Task);
    } catch {
      // skip corrupt files
    }
  }
  return tasks;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function computeUvd(
  taskDir: string,
  options: { days?: number } = {},
): UvdResult {
  const days = options.days ?? 7;
  const now = Date.now();
  const windowMs = days * 24 * 60 * 60 * 1000;
  const cutoff = now - windowMs;
  const today = new Date().toISOString().slice(0, 10);

  // Read from active task dir + archive subdir
  const allTasks = [
    ...readTasksFromDir(taskDir),
    ...readTasksFromDir(join(taskDir, 'archive')),
  ];

  let excludedHuman = 0;
  let excludedNoResult = 0;
  let excludedHousekeeping = 0;
  let excludedOutsideWindow = 0;
  const uvdTasks: UvdTaskSummary[] = [];

  for (const task of allTasks) {
    if (task.status !== 'completed') continue;

    // Must have been completed within window
    const completedAt = task.completed_at ? new Date(task.completed_at).getTime() : 0;
    if (!completedAt || completedAt < cutoff) {
      excludedOutsideWindow++;
      continue;
    }

    // Must be agent-created
    if (!task.created_by || isHumanCreated(task.created_by)) {
      excludedHuman++;
      continue;
    }

    // Must have non-empty result
    if (!task.result || task.result.trim().length === 0) {
      excludedNoResult++;
      continue;
    }

    // Must not be housekeeping
    if (isHousekeeping(task.title)) {
      excludedHousekeeping++;
      continue;
    }

    uvdTasks.push({
      id: task.id,
      title: task.title,
      assigned_to: task.assigned_to,
      created_by: task.created_by,
      completed_at: task.completed_at!,
      result_preview: task.result.slice(0, 120),
    });
  }

  const totalEvaluated = allTasks.filter(t => t.status === 'completed').length;

  return {
    date: today,
    window_days: days,
    uvd_count: uvdTasks.length,
    uvd_per_day: Math.round((uvdTasks.length / days) * 100) / 100,
    tasks_evaluated: totalEvaluated,
    excluded_human_created: excludedHuman,
    excluded_no_result: excludedNoResult,
    excluded_housekeeping: excludedHousekeeping,
    excluded_outside_window: excludedOutsideWindow,
    uvd_tasks: uvdTasks,
  };
}

export function writeUvdResult(metricsDir: string, result: UvdResult): string {
  mkdirSync(metricsDir, { recursive: true });
  const outPath = join(metricsDir, `uvd-${result.date}.json`);
  writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n', 'utf-8');
  return outPath;
}
