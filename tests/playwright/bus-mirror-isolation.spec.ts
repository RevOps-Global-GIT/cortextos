/**
 * Regression test: bus mirror must NEVER write to prod orch_tasks during any test run.
 *
 * Root cause of incident: Playwright sets neither VITEST nor NODE_ENV, so the
 * per-call-site guards in task.ts (`if (!VITEST && NODE_ENV !== 'test')`) did
 * not fire. createTask/updateTask/completeTask called mirrorTaskToRgos directly,
 * leaking testbot/boris/my-test-agent fixture tasks into the prod Intake column.
 *
 * Fix: playwright.config.ts sets `process.env.NODE_ENV = 'test'` at module level
 * so worker processes inherit it and the existing per-call-site guards trigger.
 * isEnabled() is intentionally not changed — unit tests for rgos-mirror need to
 * call isEnabled() with real creds to test the actual guard logic.
 */
import { test, expect } from '@playwright/test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

require('tsx/cjs');

const { createTask, updateTask, completeTask } = require('../../src/bus/task');

import type { BusPaths } from '../../src/types';

function makeTmpPaths(): { paths: BusPaths; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'mirror-isolation-'));
  const ctxRoot = join(dir, '.cortextos', 'test');
  const paths: BusPaths = {
    ctxRoot,
    inbox: join(ctxRoot, 'inbox', 'testbot'),
    inflight: join(ctxRoot, 'inflight', 'testbot'),
    processed: join(ctxRoot, 'processed', 'testbot'),
    logDir: join(ctxRoot, 'logs', 'testbot'),
    stateDir: join(ctxRoot, 'state', 'testbot'),
    taskDir: join(ctxRoot, 'orgs', 'test-org', 'tasks'),
    approvalDir: join(ctxRoot, 'orgs', 'test-org', 'approvals'),
    analyticsDir: join(ctxRoot, 'orgs', 'test-org', 'analytics'),
    heartbeatDir: join(ctxRoot, 'state'),
  };
  return { paths, dir };
}

test.describe('Bus mirror isolation under Playwright (NODE_ENV=test)', () => {
  test('playwright.config.ts sets NODE_ENV=test so per-call-site guards fire', () => {
    // This is the root-cause guard: task.ts guards each mirrorTaskToRgos call with
    // `if (!process.env.VITEST && process.env.NODE_ENV !== 'test')`.
    // playwright.config.ts must set NODE_ENV=test at module level so workers inherit it.
    expect(process.env.NODE_ENV).toBe('test');
  });

  test('createTask/updateTask/completeTask make 0 Supabase calls under NODE_ENV=test', async () => {
    const originalFetch = globalThis.fetch;
    const supabaseCalls: string[] = [];
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('supabase.co') || url.includes('orch_tasks')) {
        supabaseCalls.push(url);
      }
      return originalFetch(input as Request, init);
    };

    const { paths, dir } = makeTmpPaths();
    try {
      const taskId = createTask(paths, 'testbot', 'test-org', 'Mirror isolation test', { skipBriefValidation: true });
      updateTask(paths, taskId, 'in_progress');
      completeTask(paths, taskId, 'Done');
      // Give any fire-and-forget promises a tick to settle
      await new Promise(r => setTimeout(r, 200));
      expect(supabaseCalls).toHaveLength(0);
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
