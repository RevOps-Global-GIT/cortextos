-- Migration: grant authenticated role SELECT on orch_agent_heartbeats
--
-- The base migration (20260510) created an anon read policy but omitted
-- authenticated. The RGOS app (agentops.revopsglobal.com) uses Supabase
-- auth sessions (role=authenticated), so authenticated users got 0 rows
-- from the Sessions panel — causing "No active CLI sessions" false empty-state.
--
-- NOTE: This migration file is committed to cortextos/supabase/migrations for
-- documentation, but cortextos has NO automated Supabase apply pipeline
-- (no db push in any CI workflow). This migration must be applied manually
-- to the rgos project (yyizocyaehmqrottmnaz) via the Supabase Management API
-- or SQL editor. The orchestrator applied it directly on 2026-06-02.
--
-- Syntax note: PostgreSQL does not support CREATE POLICY IF NOT EXISTS.
-- Use a DO block for idempotent application.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'orch_agent_heartbeats'
      AND policyname = 'authenticated read'
  ) THEN
    EXECUTE 'CREATE POLICY "authenticated read"
      ON orch_agent_heartbeats
      FOR SELECT
      TO authenticated
      USING (true)';
  END IF;
END
$$;
