import fs from 'fs';
import path from 'path';
import { CTX_ROOT } from '@/lib/config';
import type { TaskPriority, TaskStatus } from '@/lib/types';

const HUMAN_TASK_STATUSES = new Set<TaskStatus | 'approved'>([
  'pending',
  'in_progress',
  'approved',
]);

export interface HumanBlockerTask {
  id: string;
  title: string;
  status: string;
  priority: TaskPriority;
  assigned_to?: string;
  created_at: string;
  source_file: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isActionableHumanTask(task: Record<string, unknown>): boolean {
  const title = typeof task.title === 'string' ? task.title : '';
  const status = typeof task.status === 'string' ? task.status : '';
  return (
    title.startsWith('[HUMAN]') &&
    task.archived !== true &&
    HUMAN_TASK_STATUSES.has(status as TaskStatus | 'approved')
  );
}

function scanTaskDir(taskDir: string): HumanBlockerTask[] {
  if (!fs.existsSync(taskDir)) return [];

  let files: string[];
  try {
    files = fs.readdirSync(taskDir).filter((file) => file.startsWith('task_') && file.endsWith('.json'));
  } catch {
    return [];
  }

  const tasks: HumanBlockerTask[] = [];
  for (const file of files) {
    const sourceFile = path.join(taskDir, file);
    try {
      const raw = JSON.parse(fs.readFileSync(sourceFile, 'utf-8'));
      if (!isRecord(raw) || !isActionableHumanTask(raw)) continue;
      const title = typeof raw.title === 'string' ? raw.title : '[HUMAN] Untitled';

      tasks.push({
        id: typeof raw.id === 'string' ? raw.id : path.basename(file, '.json'),
        title,
        status: typeof raw.status === 'string' ? raw.status : 'pending',
        priority: (typeof raw.priority === 'string' ? raw.priority : 'normal') as TaskPriority,
        assigned_to: typeof raw.assigned_to === 'string' ? raw.assigned_to : undefined,
        created_at: typeof raw.created_at === 'string' ? raw.created_at : new Date(0).toISOString(),
        source_file: sourceFile,
      });
    } catch {
      // Ignore corrupt task files; the dashboard should not fail closed on one bad task.
    }
  }

  return tasks;
}

export function getHumanBlockerTasks(ctxRoot = CTX_ROOT): HumanBlockerTask[] {
  const tasks: HumanBlockerTask[] = [];

  tasks.push(...scanTaskDir(path.join(ctxRoot, 'tasks')));

  const orgsDir = path.join(ctxRoot, 'orgs');
  if (fs.existsSync(orgsDir)) {
    try {
      for (const org of fs.readdirSync(orgsDir)) {
        tasks.push(...scanTaskDir(path.join(orgsDir, org, 'tasks')));
      }
    } catch {
      // Ignore unreadable org roots.
    }
  }

  return tasks.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
}

export function getHumanBlockerCount(ctxRoot = CTX_ROOT): number {
  return getHumanBlockerTasks(ctxRoot).length;
}
