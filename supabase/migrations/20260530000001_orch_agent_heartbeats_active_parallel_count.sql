-- Add active_parallel_count column to orch_agent_heartbeats.
--
-- PR #539 (feat dispatch-batch, ~2026-05-28T17:48 UTC) added this field to the
-- pushHeartbeatToSupabase payload in src/bus/heartbeat.ts but never created the
-- DB column. Every heartbeat upsert since then returned HTTP 400 (PGRST204:
-- column not found), silently swallowed by .catch(() => {}), freezing the fleet
-- dashboard for all cortextos1 agents for ~1.5 days.
--
-- *** HAND-APPLIED TO PROD during incident 2026-05-30T04:56Z ***
-- This migration is idempotent (IF NOT EXISTS); a second apply is a no-op.

ALTER TABLE orch_agent_heartbeats
  ADD COLUMN IF NOT EXISTS active_parallel_count INTEGER NOT NULL DEFAULT 0;
