import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomBytes } from 'crypto';

export interface SpanOptions {
  /** Span name. Defaults to the wrapped function's name. */
  name?: string;
  /** OTel span kind. Default: 'INTERNAL'. */
  kind?: 'INTERNAL' | 'CLIENT' | 'SERVER';
  /** Agent identifier. Defaults to CTX_AGENT_NAME env var. */
  agent?: string;
  /** Optional task_id to correlate spans with bus tasks. */
  taskId?: string;
  /** Arbitrary key-value attributes attached to the span. */
  attributes?: Record<string, string | number | boolean | null>;
}

function generateId(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

function spansDir(): string {
  const instanceId = process.env.CTX_INSTANCE_ID || 'default';
  const dir = join(homedir(), '.cortextos', instanceId, 'traces');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

async function postSpan(row: Record<string, unknown>): Promise<void> {
  const url = process.env.SUPABASE_RGOS_URL || process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_RGOS_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) return;
  await fetch(`${url}/rest/v1/orch_spans`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(row),
    signal: AbortSignal.timeout(5000),
  });
}

/**
 * Execute `fn`, recording an orch_spans row covering the call duration.
 * Span emission is non-fatal — errors are swallowed so callers are not affected.
 */
export async function withSpan<T>(
  name: string,
  fn: () => Promise<T>,
  opts: SpanOptions = {},
): Promise<T> {
  const traceId = generateId(16);
  const spanId = generateId(8);
  const startedAt = new Date();
  let status = 'OK';

  try {
    const result = await fn();
    return result;
  } catch (err) {
    status = 'ERROR';
    throw err;
  } finally {
    const endedAt = new Date();
    const row = {
      trace_id: traceId,
      span_id: spanId,
      parent_span_id: null,
      agent: opts.agent ?? process.env.CTX_AGENT_NAME ?? 'unknown',
      task_id: opts.taskId ?? null,
      name: opts.name ?? name,
      kind: opts.kind ?? 'INTERNAL',
      started_at: startedAt.toISOString(),
      ended_at: endedAt.toISOString(),
      duration_ms: endedAt.getTime() - startedAt.getTime(),
      attributes: opts.attributes ?? {},
      status,
    };

    try {
      appendFileSync(join(spansDir(), 'orch-spans.ndjson'), JSON.stringify(row) + '\n', 'utf-8');
    } catch { /* non-fatal */ }

    postSpan(row).catch(() => { /* non-fatal */ });
  }
}

/**
 * Wrap an async function so every call is automatically recorded as an orch_spans row.
 *
 * ```ts
 * const traced = observe(sendMessage, { name: 'bus.send_message' });
 * await traced(agent, priority, text);
 * ```
 */
export function observe<Args extends unknown[], R>(
  fn: (...args: Args) => Promise<R>,
  opts: SpanOptions = {},
): (...args: Args) => Promise<R> {
  const spanName = opts.name ?? fn.name ?? 'anonymous';
  return (...args: Args): Promise<R> =>
    withSpan(spanName, () => fn(...args), opts);
}

/**
 * Fire-and-forget span insert for synchronous operations where wrapping is
 * impractical. The span records the moment the operation completed; duration_ms
 * is 0. Non-fatal — never throws.
 */
export function recordSpan(name: string, opts: SpanOptions = {}): void {
  const now = new Date();
  const row = {
    trace_id: generateId(16),
    span_id: generateId(8),
    parent_span_id: null,
    agent: opts.agent ?? process.env.CTX_AGENT_NAME ?? 'unknown',
    task_id: opts.taskId ?? null,
    name: opts.name ?? name,
    kind: opts.kind ?? 'INTERNAL',
    started_at: now.toISOString(),
    ended_at: now.toISOString(),
    duration_ms: 0,
    attributes: opts.attributes ?? {},
    status: 'OK',
  };

  try {
    appendFileSync(join(spansDir(), 'orch-spans.ndjson'), JSON.stringify(row) + '\n', 'utf-8');
  } catch { /* non-fatal */ }

  postSpan(row).catch(() => { /* non-fatal */ });
}
