/**
 * Minimal OpenTelemetry span emitter for cortextos experiment commands.
 *
 * Design: no heavy SDK dependency — this module writes structured JSON
 * spans to a local trace log and optionally POSTs them to an OTLP HTTP
 * endpoint when OTEL_EXPORTER_OTLP_ENDPOINT is set.
 *
 * Each span record is a self-contained JSON line (NDJSON) written to:
 *   ~/.cortextos/<instance>/traces/experiment-spans.ndjson
 *
 * The Supabase orch_experiments row is updated with otel_trace_id and
 * last_span_at after each span is emitted.
 */

import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomBytes } from 'crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExperimentSpanAttrs {
  experiment_id: string;
  hypothesis: string;         // truncated to 200 chars
  baseline_metric: string;    // metric name
  delta_after_treatment?: number | null;
  agent_name: string;
  span_kind: 'create' | 'run' | 'evaluate';
  status?: string;            // experiment status at emit time
}

export interface SpanRecord {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  name: string;
  kind: string;
  start_time_unix_nano: number;
  end_time_unix_nano: number;
  attributes: Record<string, string | number | null>;
  status: { code: 'OK' | 'ERROR'; message?: string };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateId(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

function nowNano(): number {
  // Date.now() returns ms; multiply to nanoseconds
  return Date.now() * 1_000_000;
}

function tracesDir(): string {
  const instanceId = process.env.CTX_INSTANCE_ID || 'default';
  const dir = join(homedir(), '.cortextos', instanceId, 'traces');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// ---------------------------------------------------------------------------
// Core emit
// ---------------------------------------------------------------------------

/**
 * Emit a single experiment span.
 * - Always writes to the local NDJSON file.
 * - If OTEL_EXPORTER_OTLP_ENDPOINT is set, also POSTs OTLP JSON.
 * Returns the trace_id so callers can store it on the experiment row.
 */
export async function emitExperimentSpan(
  attrs: ExperimentSpanAttrs,
  existingTraceId?: string,
): Promise<{ trace_id: string; span_id: string }> {
  const trace_id = existingTraceId ?? generateId(16);
  const span_id = generateId(8);
  const now = nowNano();

  const span: SpanRecord = {
    trace_id,
    span_id,
    parent_span_id: null,
    name: `experiment.${attrs.span_kind}`,
    kind: 'INTERNAL',
    start_time_unix_nano: now,
    end_time_unix_nano: now + 1_000_000, // 1ms duration placeholder
    attributes: {
      'experiment.id': attrs.experiment_id,
      'experiment.hypothesis': attrs.hypothesis.slice(0, 200),
      'experiment.baseline_metric': attrs.baseline_metric,
      'experiment.delta_after_treatment': attrs.delta_after_treatment ?? null,
      'experiment.agent_name': attrs.agent_name,
      'experiment.span_kind': attrs.span_kind,
      'experiment.status': attrs.status ?? '',
      'service.name': 'cortextos-bus',
    },
    status: { code: 'OK' },
  };

  // --- Write to local NDJSON file ---
  const logPath = join(tracesDir(), 'experiment-spans.ndjson');
  try {
    appendFileSync(logPath, JSON.stringify(span) + '\n', 'utf-8');
  } catch {
    // Non-fatal — tracing must not break experiment commands
  }

  // --- Optional OTLP HTTP export ---
  const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (otlpEndpoint) {
    await sendOtlpSpan(otlpEndpoint, span).catch(() => {/* non-fatal */});
  }

  return { trace_id, span_id };
}

/**
 * Send span to an OTLP HTTP endpoint in OTLP JSON format.
 * Spec: https://opentelemetry.io/docs/specs/otlp/#otlphttp
 */
async function sendOtlpSpan(endpoint: string, span: SpanRecord): Promise<void> {
  const url = endpoint.replace(/\/$/, '') + '/v1/traces';
  const body = JSON.stringify({
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'cortextos-bus' } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: 'cortextos-experiment', version: '1.0.0' },
            spans: [
              {
                traceId: span.trace_id,
                spanId: span.span_id,
                name: span.name,
                kind: 1, // INTERNAL
                startTimeUnixNano: String(span.start_time_unix_nano),
                endTimeUnixNano: String(span.end_time_unix_nano),
                attributes: Object.entries(span.attributes).map(([key, value]) => ({
                  key,
                  value: value === null
                    ? { nullValue: null }
                    : typeof value === 'number'
                      ? { doubleValue: value }
                      : { stringValue: String(value) },
                })),
                status: { code: span.status.code === 'OK' ? 1 : 2 },
              },
            ],
          },
        ],
      },
    ],
  });

  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(5000),
  });
}

// ---------------------------------------------------------------------------
// Supabase patch helper — update otel_trace_id + last_span_at on the row
// ---------------------------------------------------------------------------

/**
 * Patch the orch_experiments row with the trace_id and current timestamp.
 * Silently fails if Supabase is not configured or row has no orch_id.
 */
export async function patchExperimentTraceId(
  orchId: string,
  traceId: string,
): Promise<void> {
  const url = process.env.SUPABASE_RGOS_URL || process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_RGOS_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key || !orchId) return;

  try {
    await fetch(
      `${url}/rest/v1/orch_experiments?id=eq.${encodeURIComponent(orchId)}`,
      {
        method: 'PATCH',
        headers: {
          'apikey': key,
          'Authorization': `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          otel_trace_id: traceId,
          last_span_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }),
        signal: AbortSignal.timeout(10000),
      },
    );
  } catch {
    // Non-fatal
  }
}
