-- Migration: orch_agent_heartbeats
--
-- Stores agent heartbeats from all cortextOS instances (hub + remote VMs).
-- Primary key is (instance_id, agent_name) so the same agent name can run
-- on multiple VMs without collision.
--
-- Written by: updateHeartbeat() in src/bus/heartbeat.ts (fire-and-forget upsert)
-- Read by:    listAgents() and readAllHeartbeats() in src/bus/agents.ts / heartbeat.ts
--             to surface remote agents in `cortextos bus list-agents`.

create table if not exists orch_agent_heartbeats (
  instance_id    text        not null,
  agent_name     text        not null,
  org            text        not null default '',
  host           text        not null default '',
  status         text        not null default '',
  current_task   text        not null default '',
  mode           text        not null default '',
  loop_interval  text        not null default '',
  last_heartbeat timestamptz not null,
  updated_at     timestamptz not null default now(),

  primary key (instance_id, agent_name)
);

-- Index for the common query: "give me all rows not from my instance_id"
create index if not exists idx_orch_agent_heartbeats_instance
  on orch_agent_heartbeats (instance_id);

-- RLS: service role key can read/write; anon key can read (dashboard)
alter table orch_agent_heartbeats enable row level security;

create policy "service role full access"
  on orch_agent_heartbeats
  for all
  to service_role
  using (true)
  with check (true);

create policy "anon read"
  on orch_agent_heartbeats
  for select
  to anon
  using (true);
