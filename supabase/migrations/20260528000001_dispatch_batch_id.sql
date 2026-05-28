-- Migration: dispatch_batch_id
--
-- Adds batch-tracking columns so the cortextOS bus can dispatch N parallel tasks
-- as a single coherent batch and have heartbeats + dashboards group them.
--
-- Written by: createTask() in src/bus/task.ts (via buildTaskRow in rgos-mirror)
--             updateHeartbeat() in src/bus/heartbeat.ts
-- Read by:    dashboard/src/components/tasks/* and the parallel-tasks feature.
--
-- All columns are nullable — legacy rows are unaffected.

alter table orch_tasks
  add column if not exists dispatch_batch_id uuid,
  add column if not exists parallel_count    int;

create index if not exists idx_orch_tasks_dispatch_batch_id
  on orch_tasks (dispatch_batch_id)
  where dispatch_batch_id is not null;

alter table orch_agent_heartbeats
  add column if not exists active_parallel_count int;
