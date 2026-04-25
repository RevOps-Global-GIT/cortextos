/**
 * Unit tests for src/bus/rgos-mirror.ts
 *
 * Covers all 10 plan scenarios + concurrent drain lock:
 * 1. mirrorTaskToRgos fires and payload shape is correct
 * 2. Status transitions (update) mirror correctly
 * 3. Completion + result field mirrored
 * 4. mirrorMessageToRgos fires and payload shape is correct
 * 5. Kill switch BUS_RGOS_MIRROR_DISABLED=1 → no fetch
 * 6. Missing SUPABASE_RGOS_URL → no fetch
 * 7. Missing SUPABASE_RGOS_SERVICE_KEY → no fetch
 * 8. Network failure → retry enqueue → entry written to JSONL
 * 9. Retry drain on success → queued items flushed
 * 10. Retry queue FIFO eviction at 500 entries
 * 11. Concurrent drain lock → second call returns immediately
 *
 * Strategy: vi.stubGlobal('fetch') to intercept all HTTP without real network.
 * Temp dirs for retry queue file assertions.
 * Env vars set/unset in beforeEach/afterEach.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ── Imports from module under test ──────────────────────────────────────────

import {
  mirrorTaskToRgos,
  mirrorMessageToRgos,
  drainRetryQueue,
  enqueueRetry,
  readRetryQueue,
  buildTaskRow,
  buildMessageRow,
  isEnabled,
  _resetDrainLock,
} from '../../../src/bus/rgos-mirror.js';
import type { Task, InboxMessage } from '../../../src/types/index.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task_1234567890_001',
    title: 'Test task',
    description: 'A test task',
    type: 'agent',
    needs_approval: false,
    status: 'pending',
    assigned_to: 'dev',
    created_by: 'orchestrator',
    org: 'revops-global',
    priority: 'normal',
    project: 'test-project',
    kpi_key: null,
    created_at: '2026-04-25T10:00:00Z',
    updated_at: '2026-04-25T10:00:00Z',
    completed_at: null,
    due_date: null,
    archived: false,
    ...overrides,
  };
}

function makeMessage(overrides: Partial<InboxMessage> = {}): InboxMessage {
  return {
    id: 'msg_test_001',
    from: 'orchestrator',
    to: 'dev',
    priority: 'normal',
    timestamp: '2026-04-25T10:00:00.000Z',
    text: 'Hello from orchestrator',
    reply_to: null,
    ...overrides,
  };
}

// ── Env setup helpers ────────────────────────────────────────────────────────

function setMirrorEnv(tmpDir: string) {
  process.env.SUPABASE_RGOS_URL = 'https://test.supabase.co';
  process.env.SUPABASE_RGOS_SERVICE_KEY = 'test-service-key';
  process.env.CTX_ROOT = tmpDir;
  process.env.CTX_AGENT_NAME = 'dev';
  delete process.env.BUS_RGOS_MIRROR_DISABLED;
}

function clearMirrorEnv() {
  delete process.env.SUPABASE_RGOS_URL;
  delete process.env.SUPABASE_RGOS_SERVICE_KEY;
  delete process.env.CTX_ROOT;
  delete process.env.CTX_AGENT_NAME;
  delete process.env.BUS_RGOS_MIRROR_DISABLED;
}

// ── Mock fetch helper ────────────────────────────────────────────────────────

function mockFetchOk() {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    text: async () => '',
  }));
}

function mockFetchFail(msg = 'Network error') {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error(msg)));
}

function mockFetchHttpError(status = 500, body = 'Internal Server Error') {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: false,
    status,
    text: async () => body,
  }));
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('rgos-mirror — isEnabled()', () => {
  afterEach(() => { clearMirrorEnv(); });

  it('returns true when all required env vars are set', () => {
    process.env.SUPABASE_RGOS_URL = 'https://test.supabase.co';
    process.env.SUPABASE_RGOS_SERVICE_KEY = 'key';
    expect(isEnabled()).toBe(true);
  });

  it('returns false when BUS_RGOS_MIRROR_DISABLED=1', () => {
    process.env.SUPABASE_RGOS_URL = 'https://test.supabase.co';
    process.env.SUPABASE_RGOS_SERVICE_KEY = 'key';
    process.env.BUS_RGOS_MIRROR_DISABLED = '1';
    expect(isEnabled()).toBe(false);
  });

  it('returns false when SUPABASE_RGOS_URL missing', () => {
    process.env.SUPABASE_RGOS_SERVICE_KEY = 'key';
    expect(isEnabled()).toBe(false);
  });

  it('returns false when SUPABASE_RGOS_SERVICE_KEY missing', () => {
    process.env.SUPABASE_RGOS_URL = 'https://test.supabase.co';
    expect(isEnabled()).toBe(false);
  });
});

describe('rgos-mirror — buildTaskRow()', () => {
  it('maps required fields correctly', () => {
    const task = makeTask();
    const row = buildTaskRow(task);

    expect(row.id).toBe(task.id);
    expect(row.org_id).toBe('00000000-0000-0000-0000-000000000001');
    expect(row.title).toBe(task.title);
    expect(row.status).toBe('pending');
    expect(row.priority).toBe('normal');
    expect(row.assigned_to).toBe('dev');
    expect(row.created_by).toBe('orchestrator');
    expect(row.source).toBe('cortextos_bus_mirror');
  });

  it('maps result field when present', () => {
    const task = makeTask({ status: 'completed', result: 'Done successfully', completed_at: '2026-04-25T11:00:00Z' });
    const row = buildTaskRow(task);
    expect(row.result).toBe('Done successfully');
    expect(row.completed_at).toBe('2026-04-25T11:00:00Z');
  });

  it('includes metadata with org, project, blocked_by, blocks', () => {
    const task = makeTask({ blocked_by: ['task_abc'], blocks: ['task_xyz'] });
    const row = buildTaskRow(task);
    const meta = row.metadata as Record<string, unknown>;
    expect(meta.org).toBe('revops-global');
    expect(meta.project).toBe('test-project');
    expect(meta.blocked_by).toEqual(['task_abc']);
    expect(meta.blocks).toEqual(['task_xyz']);
  });

  it('sets null for optional fields when absent', () => {
    const task = makeTask();
    const row = buildTaskRow(task);
    expect(row.result).toBeNull();
    expect(row.completed_at).toBeNull();
    expect(row.due_date).toBeNull();
    expect(row.parent_task_id).toBeNull();
    expect(row.project_id).toBeNull();
    expect(row.source_thread_ref).toBeNull();
  });
});

describe('rgos-mirror — buildMessageRow()', () => {
  it('maps required fields correctly', () => {
    const msg = makeMessage();
    const row = buildMessageRow(msg);

    expect(row.id).toBe('msg_test_001');
    expect(row.org_id).toBe('00000000-0000-0000-0000-000000000001');
    expect(row.from_agent).toBe('orchestrator');
    expect(row.to_agent).toBe('dev');
    expect(row.message_type).toBe('agent_message');
    expect(row.body).toBe('Hello from orchestrator');
    expect(row.reply_to_id).toBeNull();
    expect(row.read_at).toBeNull();
  });

  it('maps trace_id to thread_id when present', () => {
    const msg = makeMessage({ trace_id: 'trace-abc-123' });
    const row = buildMessageRow(msg);
    expect(row.thread_id).toBe('trace-abc-123');
    expect((row.payload as Record<string, unknown>).trace_id).toBe('trace-abc-123');
  });

  it('maps reply_to to reply_to_id', () => {
    const msg = makeMessage({ reply_to: 'msg_original_001' });
    const row = buildMessageRow(msg);
    expect(row.reply_to_id).toBe('msg_original_001');
  });

  it('sets thread_id to null when no trace_id', () => {
    const msg = makeMessage();
    const row = buildMessageRow(msg);
    expect(row.thread_id).toBeNull();
  });
});

// ── Scenario 1-3: mirrorTaskToRgos ──────────────────────────────────────────

describe('rgos-mirror — mirrorTaskToRgos (scenario 1-3)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'rgos-mirror-test-'));
    setMirrorEnv(tmpDir);
    mockFetchOk();
    _resetDrainLock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearMirrorEnv();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('fires fetch with correct endpoint and headers on create', async () => {
    const task = makeTask();
    await mirrorTaskToRgos(task, 'create');

    const mockFetch = vi.mocked(fetch);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://test.supabase.co/rest/v1/orch_tasks');
    expect((opts?.headers as Record<string, string>)['apikey']).toBe('test-service-key');
    expect((opts?.headers as Record<string, string>)['Authorization']).toBe('Bearer test-service-key');
    expect((opts?.headers as Record<string, string>)['Prefer']).toBe('resolution=merge-duplicates');
  });

  it('sends correct payload for createTask (scenario 1)', async () => {
    const task = makeTask();
    await mirrorTaskToRgos(task, 'create');

    const mockFetch = vi.mocked(fetch);
    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts?.body as string);
    expect(body.id).toBe(task.id);
    expect(body.status).toBe('pending');
    expect(body.source).toBe('cortextos_bus_mirror');
  });

  it('mirrors status transition for updateTask (scenario 2)', async () => {
    const task = makeTask({ status: 'in_progress', updated_at: '2026-04-25T10:30:00Z' });
    await mirrorTaskToRgos(task, 'update');

    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1]?.body) as string);
    expect(body.status).toBe('in_progress');
    expect(body.updated_at).toBe('2026-04-25T10:30:00Z');
  });

  it('mirrors completion + result for completeTask (scenario 3)', async () => {
    const task = makeTask({
      status: 'completed',
      result: 'Shipped the feature',
      completed_at: '2026-04-25T11:00:00Z',
    });
    await mirrorTaskToRgos(task, 'complete');

    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1]?.body) as string);
    expect(body.status).toBe('completed');
    expect(body.result).toBe('Shipped the feature');
    expect(body.completed_at).toBe('2026-04-25T11:00:00Z');
  });
});

// ── Scenario 4: mirrorMessageToRgos ─────────────────────────────────────────

describe('rgos-mirror — mirrorMessageToRgos (scenario 4)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'rgos-mirror-test-'));
    setMirrorEnv(tmpDir);
    mockFetchOk();
    _resetDrainLock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearMirrorEnv();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('fires fetch with correct endpoint for sendMessage (scenario 4)', async () => {
    const msg = makeMessage();
    await mirrorMessageToRgos(msg);

    const mockFetch = vi.mocked(fetch);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('https://test.supabase.co/rest/v1/cortex_messages');
  });

  it('sends correct payload for mirrorMessageToRgos', async () => {
    const msg = makeMessage({ trace_id: 'trace-xyz', reply_to: 'msg_parent' });
    await mirrorMessageToRgos(msg);

    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1]?.body) as string);
    expect(body.id).toBe('msg_test_001');
    expect(body.from_agent).toBe('orchestrator');
    expect(body.to_agent).toBe('dev');
    expect(body.body).toBe('Hello from orchestrator');
    expect(body.thread_id).toBe('trace-xyz');
    expect(body.reply_to_id).toBe('msg_parent');
    expect(body.source).toBeUndefined(); // messages don't have source
  });
});

// ── Scenarios 5-7: Kill switch + missing env ─────────────────────────────────

describe('rgos-mirror — kill switch and missing env (scenarios 5-7)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'rgos-mirror-test-'));
    mockFetchOk();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearMirrorEnv();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('no-ops when BUS_RGOS_MIRROR_DISABLED=1 (scenario 5)', async () => {
    process.env.SUPABASE_RGOS_URL = 'https://test.supabase.co';
    process.env.SUPABASE_RGOS_SERVICE_KEY = 'key';
    process.env.BUS_RGOS_MIRROR_DISABLED = '1';

    await mirrorTaskToRgos(makeTask(), 'create');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('no-ops when SUPABASE_RGOS_URL missing (scenario 6)', async () => {
    process.env.SUPABASE_RGOS_SERVICE_KEY = 'key';

    await mirrorTaskToRgos(makeTask(), 'create');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('no-ops when SUPABASE_RGOS_SERVICE_KEY missing (scenario 7)', async () => {
    process.env.SUPABASE_RGOS_URL = 'https://test.supabase.co';

    await mirrorTaskToRgos(makeTask(), 'create');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('no-ops mirrorMessageToRgos when kill switch is on', async () => {
    process.env.SUPABASE_RGOS_URL = 'https://test.supabase.co';
    process.env.SUPABASE_RGOS_SERVICE_KEY = 'key';
    process.env.BUS_RGOS_MIRROR_DISABLED = '1';

    await mirrorMessageToRgos(makeMessage());
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});

// ── Scenario 8: Network failure → retry enqueue ──────────────────────────────

describe('rgos-mirror — network failure → retry enqueue (scenario 8)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'rgos-mirror-test-'));
    setMirrorEnv(tmpDir);
    mkdirSync(join(tmpDir, 'state', 'dev'), { recursive: true });
    _resetDrainLock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearMirrorEnv();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('enqueues to retry.jsonl when fetch throws (scenario 8)', async () => {
    mockFetchFail('ECONNRESET');

    const task = makeTask();
    await mirrorTaskToRgos(task, 'create');

    const qPath = join(tmpDir, 'state', 'dev', 'mirror-retry.jsonl');
    expect(existsSync(qPath)).toBe(true);
    const entries = readRetryQueue(qPath);
    expect(entries).toHaveLength(1);
    expect(entries[0].table).toBe('orch_tasks');
    expect(entries[0].row.id).toBe(task.id);
    expect(entries[0].ts).toBeDefined();
  });

  it('enqueues to retry.jsonl when HTTP 500 returned', async () => {
    mockFetchHttpError(500, 'DB overloaded');

    const task = makeTask();
    await mirrorTaskToRgos(task, 'create');

    const qPath = join(tmpDir, 'state', 'dev', 'mirror-retry.jsonl');
    const entries = readRetryQueue(qPath);
    expect(entries).toHaveLength(1);
    expect(entries[0].table).toBe('orch_tasks');
  });

  it('enqueues message to retry.jsonl when fetch fails', async () => {
    mockFetchFail('Network unreachable');

    await mirrorMessageToRgos(makeMessage());

    const qPath = join(tmpDir, 'state', 'dev', 'mirror-retry.jsonl');
    const entries = readRetryQueue(qPath);
    expect(entries).toHaveLength(1);
    expect(entries[0].table).toBe('cortex_messages');
  });
});

// ── Scenario 9: Retry drain on success ──────────────────────────────────────

describe('rgos-mirror — retry drain on success (scenario 9)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'rgos-mirror-test-'));
    setMirrorEnv(tmpDir);
    mkdirSync(join(tmpDir, 'state', 'dev'), { recursive: true });
    _resetDrainLock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearMirrorEnv();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('drains queued entries when fetch succeeds (scenario 9)', async () => {
    const qPath = join(tmpDir, 'state', 'dev', 'mirror-retry.jsonl');

    // Pre-populate retry queue with 3 entries
    enqueueRetry({ table: 'orch_tasks', row: { id: 'task_001' }, ts: '2026-04-25T09:00:00Z' });
    enqueueRetry({ table: 'orch_tasks', row: { id: 'task_002' }, ts: '2026-04-25T09:01:00Z' });
    enqueueRetry({ table: 'cortex_messages', row: { id: 'msg_001' }, ts: '2026-04-25T09:02:00Z' });
    expect(readRetryQueue(qPath)).toHaveLength(3);

    mockFetchOk();
    await drainRetryQueue();

    // All entries should be cleared
    expect(readRetryQueue(qPath)).toHaveLength(0);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
  });

  it('leaves only failed entries after partial drain', async () => {
    const qPath = join(tmpDir, 'state', 'dev', 'mirror-retry.jsonl');

    enqueueRetry({ table: 'orch_tasks', row: { id: 'task_will_succeed' }, ts: '2026-04-25T09:00:00Z' });
    enqueueRetry({ table: 'orch_tasks', row: { id: 'task_will_fail' }, ts: '2026-04-25T09:01:00Z' });

    // First call succeeds, second fails
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, text: async () => '' })
      .mockRejectedValueOnce(new Error('DB timeout')),
    );

    await drainRetryQueue();

    const remaining = readRetryQueue(qPath);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].row.id).toBe('task_will_fail');
  });

  it('no-ops drain when retry queue is empty', async () => {
    mockFetchOk();
    await drainRetryQueue();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});

// ── Scenario 10: FIFO eviction at 500 entries ────────────────────────────────

describe('rgos-mirror — FIFO eviction at 500 entries (scenario 10)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'rgos-mirror-test-'));
    setMirrorEnv(tmpDir);
    mkdirSync(join(tmpDir, 'state', 'dev'), { recursive: true });
    _resetDrainLock();
  });

  afterEach(() => {
    clearMirrorEnv();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('caps queue at 500 and drops oldest entries (scenario 10)', () => {
    const qPath = join(tmpDir, 'state', 'dev', 'mirror-retry.jsonl');

    // Pre-populate 500 entries (the max)
    for (let i = 0; i < 500; i++) {
      enqueueRetry({ table: 'orch_tasks', row: { id: `task_${i.toString().padStart(4, '0')}` }, ts: '2026-04-25T09:00:00Z' });
    }
    expect(readRetryQueue(qPath)).toHaveLength(500);

    // Adding one more should evict the oldest
    enqueueRetry({ table: 'orch_tasks', row: { id: 'task_overflow' }, ts: '2026-04-25T09:00:00Z' });

    const entries = readRetryQueue(qPath);
    expect(entries).toHaveLength(500);
    // The oldest entry (task_0000) should be evicted
    expect(entries[0].row.id).toBe('task_0001');
    // The new entry should be at the end
    expect(entries[entries.length - 1].row.id).toBe('task_overflow');
  });

  it('does not crash when adding to a nearly full queue', () => {
    // Fill to 498
    for (let i = 0; i < 498; i++) {
      enqueueRetry({ table: 'orch_tasks', row: { id: `task_${i}` }, ts: '2026-04-25T09:00:00Z' });
    }
    // Add 5 more — should cap at 500, no crash
    for (let i = 498; i < 503; i++) {
      enqueueRetry({ table: 'orch_tasks', row: { id: `task_${i}` }, ts: '2026-04-25T09:00:00Z' });
    }
    const qPath = join(tmpDir, 'state', 'dev', 'mirror-retry.jsonl');
    expect(readRetryQueue(qPath)).toHaveLength(500);
  });
});

// ── Scenario 11: Concurrent drain lock ──────────────────────────────────────

describe('rgos-mirror — concurrent drain lock (scenario 11)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'rgos-mirror-test-'));
    setMirrorEnv(tmpDir);
    mkdirSync(join(tmpDir, 'state', 'dev'), { recursive: true });
    _resetDrainLock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearMirrorEnv();
    rmSync(tmpDir, { recursive: true, force: true });
    _resetDrainLock();
  });

  it('second concurrent drain returns immediately without calling fetch again (scenario 11)', async () => {
    const qPath = join(tmpDir, 'state', 'dev', 'mirror-retry.jsonl');
    enqueueRetry({ table: 'orch_tasks', row: { id: 'task_001' }, ts: '2026-04-25T09:00:00Z' });

    // Slow fetch — drain1 will hold the lock during its await
    let resolveFirst!: () => void;
    vi.stubGlobal('fetch', vi.fn()
      .mockImplementationOnce(() => new Promise<{ ok: boolean; text: () => Promise<string> }>((resolve) => {
        resolveFirst = () => resolve({ ok: true, text: async () => '' });
      }))
      .mockResolvedValue({ ok: true, text: async () => '' }),
    );

    // Start drain1 (will hold the lock at the first fetch await)
    const drain1 = drainRetryQueue();

    // Start drain2 immediately — the lock is held, it should no-op
    const drain2 = drainRetryQueue();

    // Resolve drain2 — it should return immediately (lock held)
    await drain2;

    // Fetch should have been called only once so far (by drain1)
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);

    // Unblock drain1
    resolveFirst();
    await drain1;

    // After drain1 finishes, queue should be empty
    expect(readRetryQueue(qPath)).toHaveLength(0);
    // Total fetches = 1 (drain2 was a no-op)
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });
});
