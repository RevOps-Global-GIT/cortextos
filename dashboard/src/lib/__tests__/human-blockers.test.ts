import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'human-blockers-test-'));
process.env.CTX_ROOT = tmpDir;

let getHumanBlockerCount: typeof import('../data/human-blockers')['getHumanBlockerCount'];
let getHumanBlockerTasks: typeof import('../data/human-blockers')['getHumanBlockerTasks'];

beforeAll(async () => {
  const mod = await import('../data/human-blockers');
  getHumanBlockerCount = mod.getHumanBlockerCount;
  getHumanBlockerTasks = mod.getHumanBlockerTasks;
});

function writeJSON(relPath: string, data: unknown): void {
  const fullPath = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, JSON.stringify(data, null, 2));
}

describe('human blocker task scan', () => {
  it('matches the bus human-blockers task semantics instead of raw blocked status rows', () => {
    writeJSON('orgs/revops-global/tasks/task_actionable.json', {
      id: 'task_actionable',
      title: '[HUMAN] Connect OB1 image generation to funded Google Cloud credits',
      status: 'in_progress',
      priority: 'high',
      assigned_to: 'orca-orch',
      created_at: '2026-05-25T15:39:22Z',
      archived: false,
    });

    writeJSON('orgs/revops-global/tasks/task_raw_blocked.json', {
      id: 'task_raw_blocked',
      title: 'Old blocked mirror row',
      status: 'blocked',
      priority: 'normal',
      assigned_to: 'codex',
      created_at: '2026-05-15T00:00:00Z',
      archived: false,
    });

    writeJSON('orgs/revops-global/tasks/task_completed_human.json', {
      id: 'task_completed_human',
      title: '[HUMAN] Completed blocker',
      status: 'completed',
      priority: 'normal',
      assigned_to: 'human',
      created_at: '2026-05-20T00:00:00Z',
      archived: false,
    });

    writeJSON('orgs/revops-global/tasks/task_archived_human.json', {
      id: 'task_archived_human',
      title: '[HUMAN] Archived blocker',
      status: 'pending',
      priority: 'normal',
      assigned_to: 'human',
      created_at: '2026-05-20T00:00:00Z',
      archived: true,
    });

    writeJSON('orgs/revops-global/tasks/f8163d95-5d64-4497-91ad-4e69af90f80d.json', {
      id: 'f8163d95-5d64-4497-91ad-4e69af90f80d',
      title: '[HUMAN] UUID-style file ignored by digest',
      status: 'pending',
      priority: 'low',
      assigned_to: 'human',
      created_at: '2026-05-27T21:00:06Z',
      archived: false,
    });

    expect(getHumanBlockerCount(tmpDir)).toBe(1);
    expect(getHumanBlockerTasks(tmpDir).map((task) => task.id)).toEqual(['task_actionable']);
  });
});
