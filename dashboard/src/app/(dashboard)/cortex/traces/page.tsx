export const dynamic = 'force-dynamic';

type Span = {
  id: string;
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  agent: string;
  task_id: string | null;
  name: string;
  kind: string;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  attributes: Record<string, unknown>;
  status: string;
  created_at: string;
};

async function fetchSpans(): Promise<Span[]> {
  const url = process.env.SUPABASE_RGOS_URL || process.env.RGOS_SUPABASE_URL || process.env.SUPABASE_URL || '';
  const key =
    process.env.SUPABASE_RGOS_SERVICE_KEY ||
    process.env.RGOS_SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    '';
  if (!url || !key) return [];
  const res = await fetch(
    `${url}/rest/v1/orch_spans?order=started_at.desc&limit=200`,
    {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      cache: 'no-store',
    },
  );
  if (!res.ok) return [];
  return res.json() as Promise<Span[]>;
}

function statusClass(status: string) {
  if (status === 'OK') return 'text-emerald-700 bg-emerald-50 border-emerald-200';
  if (status === 'ERROR') return 'text-red-700 bg-red-50 border-red-200';
  return 'text-slate-600 bg-slate-50 border-slate-200';
}

function fmtDuration(ms: number) {
  if (ms === 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function attrsPreview(attrs: Record<string, unknown>): string {
  const entries = Object.entries(attrs);
  if (entries.length === 0) return '';
  return entries
    .slice(0, 3)
    .map(([k, v]) => `${k}=${v}`)
    .join(' · ');
}

export default async function TracesPage() {
  const spans = await fetchSpans();

  const totalSpans = spans.length;
  const errorCount = spans.filter((s) => s.status === 'ERROR').length;
  const agents = [...new Set(spans.map((s) => s.agent))];
  const ops = [...new Set(spans.map((s) => s.name))];

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Span Traces</h1>
        <p className="text-sm text-muted-foreground">
          Live view of orch_spans — bus.send_message, bus.create_task, daemon.agent_spawn, and custom @observe sites.
        </p>
      </header>

      <section className="grid gap-3 md:grid-cols-4">
        <div className="rounded-lg border bg-card p-4">
          <p className="text-xs font-medium uppercase text-muted-foreground">Spans (last 200)</p>
          <p className="mt-2 text-2xl font-semibold">{totalSpans}</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <p className="text-xs font-medium uppercase text-muted-foreground">Errors</p>
          <p className="mt-2 text-2xl font-semibold text-red-600">{errorCount}</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <p className="text-xs font-medium uppercase text-muted-foreground">Agents</p>
          <p className="mt-2 text-2xl font-semibold">{agents.length}</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <p className="text-xs font-medium uppercase text-muted-foreground">Operation types</p>
          <p className="mt-2 text-2xl font-semibold">{ops.length}</p>
        </div>
      </section>

      {spans.length === 0 ? (
        <div className="rounded-lg border bg-card p-8 text-center text-muted-foreground">
          No spans recorded yet. Spans appear as agents call instrumented bus operations.
        </div>
      ) : (
        <section className="rounded-lg border bg-card">
          <div className="border-b px-4 py-3">
            <h2 className="text-sm font-semibold">Recent Spans</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/30 text-xs font-medium uppercase text-muted-foreground">
                  <th className="px-4 py-2 text-left">Operation</th>
                  <th className="px-4 py-2 text-left">Agent</th>
                  <th className="px-4 py-2 text-left">Started</th>
                  <th className="px-4 py-2 text-right">Duration</th>
                  <th className="px-4 py-2 text-left">Status</th>
                  <th className="px-4 py-2 text-left">Task</th>
                  <th className="px-4 py-2 text-left">Attributes</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {spans.map((span) => (
                  <tr key={span.id} className="hover:bg-muted/20">
                    <td className="px-4 py-2 font-mono text-xs">{span.name}</td>
                    <td className="px-4 py-2 text-xs">{span.agent}</td>
                    <td className="px-4 py-2 font-mono text-xs text-muted-foreground">
                      {fmtTime(span.started_at)}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-xs">
                      {fmtDuration(span.duration_ms)}
                    </td>
                    <td className="px-4 py-2">
                      <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${statusClass(span.status)}`}>
                        {span.status}
                      </span>
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-muted-foreground">
                      {span.task_id ? span.task_id.slice(0, 8) : '—'}
                    </td>
                    <td className="max-w-[240px] truncate px-4 py-2 font-mono text-xs text-muted-foreground">
                      {attrsPreview(span.attributes)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
