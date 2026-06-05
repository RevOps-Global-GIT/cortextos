/**
 * Regression test: bus mirror must NEVER write to prod orch_tasks during any test run.
 *
 * Root cause of incident: Playwright sets neither VITEST nor NODE_ENV, so
 * mirrorTaskToRgos() call sites in task.ts passed their guards and fired
 * live Supabase upserts, leaking fixture tasks (testbot/boris/my-test-agent)
 * into the prod Intake column.
 *
 * Fix: isEnabled() in rgos-mirror.ts now returns false when
 * VITEST || NODE_ENV === 'test' || CTX_TEST === '1'.
 * playwright.config.ts sets NODE_ENV=test so this spec always runs clean.
 */
import { test, expect } from '@playwright/test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

require('tsx/cjs');

const { isEnabled } = require('../../src/bus/rgos-mirror');
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

test.describe('Bus mirror isolation under test environment', () => {
  test('isEnabled() returns false when NODE_ENV=test', () => {
    // playwright.config.ts sets NODE_ENV=test — verify the guard fires
    expect(process.env.NODE_ENV).toBe('test');
    expect(isEnabled()).toBe(false);
  });

  test('isEnabled() returns false when VITEST is set', () => {
    const prev = process.env.VITEST;
    process.env.VITEST = '1';
    try {
      expect(isEnabled()).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.VITEST;
      else process.env.VITEST = prev;
    }
  });

  test('isEnabled() returns false when CTX_TEST=1', () => {
    const prev = process.env.CTX_TEST;
    process.env.CTX_TEST = '1';
    try {
      expect(isEnabled()).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.CTX_TEST;
      else process.env.CTX_TEST = prev;
    }
  });

  test('createTask/updateTask/completeTask do not call Supabase under NODE_ENV=test', async () => {
    // Intercept any fetch calls — none should reach Supabase
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
      await new Promise(r => setTimeout(r, 100));
      expect(supabaseCalls).toHaveLength(0);
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
