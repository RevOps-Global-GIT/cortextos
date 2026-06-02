-- Migration: add kind + cwd to orch_agent_heartbeats
--
-- Enables external CLI sessions (Greg's Codex/Claude on Mac) to announce
-- themselves as presence cards on the fleet board, distinct from daemon-managed
-- agents. kind='external-cli' identifies session rows; cwd holds the working
-- directory the session is running in.
--
-- Both columns default to '' so existing agent heartbeats are unaffected.
-- The anon INSERT policy allows Mac wrappers to write session heartbeats
-- using only the public anon key (no service-role secret on the Mac).

ALTER TABLE orch_agent_heartbeats
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS cwd  text NOT NULL DEFAULT '';

-- Allow anon to insert external-cli session heartbeats (scoped write-only)
-- Service-role already has full access via the existing policy.
CREATE POLICY IF NOT EXISTS "anon insert external-cli sessions"
  ON orch_agent_heartbeats
  FOR INSERT
  TO anon
  WITH CHECK (kind = 'external-cli');

-- Index for the new Sessions lane query
CREATE INDEX IF NOT EXISTS idx_orch_agent_heartbeats_kind
  ON orch_agent_heartbeats (kind)
  WHERE kind <> '';
