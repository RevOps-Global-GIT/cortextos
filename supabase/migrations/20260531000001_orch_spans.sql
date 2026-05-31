CREATE TABLE IF NOT EXISTS public.orch_spans (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id       uuid NOT NULL,
  span_id        uuid NOT NULL,
  parent_span_id uuid,
  agent          text NOT NULL,
  task_id        text,
  name           text NOT NULL,
  kind           text NOT NULL DEFAULT 'INTERNAL',
  started_at     timestamptz NOT NULL,
  ended_at       timestamptz NOT NULL,
  duration_ms    int NOT NULL,
  attributes     jsonb DEFAULT '{}',
  status         text NOT NULL DEFAULT 'OK',
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS orch_spans_trace_id_idx   ON public.orch_spans(trace_id);
CREATE INDEX IF NOT EXISTS orch_spans_agent_idx      ON public.orch_spans(agent);
CREATE INDEX IF NOT EXISTS orch_spans_started_at_idx ON public.orch_spans(started_at DESC);
ALTER TABLE public.orch_spans ENABLE ROW LEVEL SECURITY;
