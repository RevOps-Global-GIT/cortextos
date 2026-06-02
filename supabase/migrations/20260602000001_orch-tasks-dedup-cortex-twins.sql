-- Migration: 20260602000001 — one-time dedup of cortex_create_task twin rows
--
-- Root cause: every `cortextos bus create-task` previously wrote TWO rows to
-- orch_tasks simultaneously:
--   (1) source=cortextos_bus_mirror, created_by=<agent>  ← the canonical row
--   (2) source=null, created_by=cortex                   ← the orphan twin
-- The twin stayed stuck in its initial status while the bus-mirror row advanced
-- through the task lifecycle, inflating Pending/In-Progress counts.
--
-- This migration deletes the orphan cortex twins for completed/cancelled pairs.
-- Live (in_progress) tasks are left untouched — the code fix in rgos-mirror.ts
-- (commit on fix/orch-tasks-dual-write-dedup) prevents new twins.
--
-- Safety: only matches pairs where EXACTLY one row is source=null/created_by=cortex
-- AND the other is source=cortextos_bus_mirror, created at the same instant (Δ30s).
-- Never touches two rows of the same source (those are real recurring tasks).

BEGIN;

-- Step 1: Update bus-mirror rows to carry the earliest created_at of the pair.
-- Preserves accurate creation time on the canonical row before the twin is removed.
UPDATE orch_tasks mirror
SET created_at = LEAST(mirror.created_at, cortex_twin.created_at),
    -- Preserve any non-null pr_url from the twin (rare; cortex-source rows
    -- typically have null metadata, but guard anyway)
    metadata = CASE
      WHEN cortex_twin.metadata->>'pr_url' IS NOT NULL AND mirror.metadata->>'pr_url' IS NULL
      THEN jsonb_set(COALESCE(mirror.metadata, '{}'), '{pr_url}', cortex_twin.metadata->'pr_url')
      ELSE mirror.metadata
    END
FROM orch_tasks cortex_twin
WHERE cortex_twin.title = mirror.title
  AND cortex_twin.assigned_to = mirror.assigned_to
  AND cortex_twin.source IS NULL
  AND cortex_twin.created_by = 'cortex'
  AND mirror.source = 'cortextos_bus_mirror'
  AND ABS(EXTRACT(EPOCH FROM (cortex_twin.created_at - mirror.created_at))) < 30
  AND mirror.status IN ('completed', 'cancelled')
  AND cortex_twin.status IN ('completed', 'cancelled', 'proposed', 'approved');

-- Step 2: Delete the orphan cortex twins whose bus-mirror sibling is terminal.
DELETE FROM orch_tasks a
USING orch_tasks b
WHERE a.title = b.title
  AND a.assigned_to = b.assigned_to
  AND a.source IS NULL
  AND a.created_by = 'cortex'
  AND b.source = 'cortextos_bus_mirror'
  AND ABS(EXTRACT(EPOCH FROM (a.created_at - b.created_at))) < 30
  AND b.status IN ('completed', 'cancelled');

COMMIT;
