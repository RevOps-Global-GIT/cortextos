-- Migration: grant authenticated role SELECT on orch_agent_heartbeats
--
-- The base migration (20260510) created an anon read policy but omitted
-- authenticated. The RGOS app (agentops.revopsglobal.com) uses Supabase
-- auth sessions (role=authenticated), so authenticated users got 0 rows
-- from the Sessions panel — causing the "No active CLI sessions" empty
-- state even when live heartbeats exist.

CREATE POLICY IF NOT EXISTS "authenticated read"
  ON orch_agent_heartbeats
  FOR SELECT
  TO authenticated
  USING (true);
