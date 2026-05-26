import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watcher-test-'));
process.env.CTX_ROOT = tmpDir;

let db: typeof import('../db')['db'];
let syncEvents: typeof import('../sync')['syncEvents'];
let buildSSEEventForFileChange: typeof import('../watcher')['buildSSEEventForFileChange'];

beforeAll(async () => {
  db = (await import('../db')).db;
  syncEvents = (await import('../sync')).syncEvents;
  buildSSEEventForFileChange = (await import('../watcher')).buildSSEEventForFileChange;
});

function writeText(relPath: string, content: string): string {
  const fullPath = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
  return fullPath;
}

function writeJSON(relPath: string, data: unknown): string {
  return writeText(relPath, JSON.stringify(data, null, 2));
}

describe('buildSSEEventForFileChange', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM events').run();
    db.prepare('DELETE FROM sync_meta').run();
  });

  it('emits the latest synced event payload instead of a generic file-change envelope', () => {
    const eventPath = writeText(
      'orgs/revops-global/analytics/events/codex/2026-05-26.jsonl',
      [
        JSON.stringify({
          id: 'old',
          timestamp: '2026-05-26T16:00:00Z',
          category: 'action',
          event: 'older_event',
          severity: 'info',
          metadata: { agent: 'ignored' },
        }),
        JSON.stringify({
          id: 'new',
          agent: 'codex',
          org: 'revops-global',
          timestamp: '2026-05-26T17:00:00Z',
          category: 'task',
          event: 'task_completed',
          severity: 'info',
          metadata: { task_id: 'abc39b97-96f6-410a-87a6-fa4ead610d0e' },
        }),
      ].join('\n'),
    );
    syncEvents('revops-global', 'codex');

    const sse = buildSSEEventForFileChange(eventPath, 'change');

    expect(sse.type).toBe('task');
    expect(sse.timestamp).toBe('2026-05-26T17:00:00Z');
    expect(sse.data.agent).toBe('codex');
    expect(sse.data.org).toBe('revops-global');
    expect(sse.data.message).toBe('task_completed');
    expect(sse.data.task_id).toBe('abc39b97-96f6-410a-87a6-fa4ead610d0e');
    expect(sse.data.changeType).toBe('change');
  });

  it('emits meaningful task updates for task file changes', () => {
    const taskPath = writeJSON('orgs/revops-global/tasks/task-1.json', {
      id: 'task-1',
      title: 'Validate Live Activity',
      status: 'in_progress',
      assigned_to: 'codex',
      org: 'revops-global',
      updated_at: '2026-05-26T17:01:00Z',
    });

    const sse = buildSSEEventForFileChange(taskPath, 'change');

    expect(sse.type).toBe('task');
    expect(sse.timestamp).toBe('2026-05-26T17:01:00Z');
    expect(sse.data.agent).toBe('codex');
    expect(sse.data.org).toBe('revops-global');
    expect(sse.data.message).toBe('Task in_progress: Validate Live Activity');
  });
});
