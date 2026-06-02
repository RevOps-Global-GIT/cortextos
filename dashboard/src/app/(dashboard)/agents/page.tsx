import { discoverAgents } from '@/lib/data/agents';
import { AgentsGrid } from '@/components/agents/agents-grid';
import type { AgentCardData } from '@/components/agents/agent-card';

export const dynamic = 'force-dynamic';

export default async function AgentsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const orgFilter = typeof params.org === 'string' ? params.org : undefined;

  const raw = await discoverAgents(orgFilter);

  // Hide agents that are definitively dead: health='down' AND
  // (no heartbeat ever OR last heartbeat more than 60 minutes ago).
  // Keep agents with health='down' but a recent heartbeat — those are
  // genuine crashes worth showing for monitoring purposes.
  const STALE_CUTOFF_MS = 60 * 60 * 1000; // 60 minutes
  const now = Date.now();

  const visible = raw.filter((a) => {
    if (a.health !== 'down') return true; // healthy / stale → always show
    const lastHb = a.lastHeartbeat;
    if (!lastHb) return false; // never heartbeated → hide
    const ageMs = now - new Date(lastHb).getTime();
    return ageMs <= STALE_CUTOFF_MS; // recent crash → show; old ghost → hide
  });

  const agents: AgentCardData[] = visible.map((a) => ({
    name: a.name,
    systemName: (a as unknown as Record<string, string>).systemName ?? a.name,
    org: a.org,
    emoji: (a as unknown as Record<string, string>).emoji ?? '',
    role: (a as unknown as Record<string, string>).role ?? '',
    health: a.health,
    currentTask: a.currentTask,
    tasksToday: (a as unknown as Record<string, number>).tasksToday ?? 0,
    runtime: a.runtime,
  }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Agents</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {orgFilter ? `Org: ${orgFilter}` : 'All organizations'} — {agents.length} agent
          {agents.length !== 1 ? 's' : ''}
          {raw.length > visible.length && (
            <span className="ml-1 opacity-60">({raw.length - visible.length} inactive hidden)</span>
          )}
        </p>
      </div>

      <AgentsGrid initialAgents={agents} />
    </div>
  );
}
