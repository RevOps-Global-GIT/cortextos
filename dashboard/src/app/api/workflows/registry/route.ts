import path from 'path';
import { NextRequest } from 'next/server';
import { CTX_ROOT, getAllAgents } from '@/lib/config';
import { buildAutomationRegistry } from '@/lib/automation-registry';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const orgFilter = searchParams.get('org') ?? undefined;

  try {
    const agents = getAllAgents().filter((agent) => {
      if (!orgFilter || orgFilter === 'all') return true;
      return agent.org === orgFilter;
    });

    const registry = buildAutomationRegistry({
      ctxRoot: CTX_ROOT,
      dashboardRoot: path.resolve(process.cwd()),
      agents,
    });

    return Response.json(registry);
  } catch (err) {
    console.error('[api/workflows/registry] GET error:', err);
    return Response.json({ error: 'Failed to build automation registry' }, { status: 500 });
  }
}
