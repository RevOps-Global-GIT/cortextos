'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  IconChevronDown,
  IconChevronRight,
  IconHeartbeat,
} from '@tabler/icons-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { HealthDot } from '@/components/shared/health-dot';
import { TimeAgo } from '@/components/shared/time-ago';
import type { HealthSummary as HealthSummaryType } from '@/lib/types';

interface SystemHealthProps {
  summary: HealthSummaryType;
}

export function SystemHealth({ summary }: SystemHealthProps) {
  const [expanded, setExpanded] = useState(false);

  const total = summary.healthy + summary.stale + summary.down;
  const needsAttention = summary.agents.filter((agent) => agent.needsAttention).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          System Health
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {total === 0 ? (
          <p className="text-sm text-muted-foreground">No agents detected</p>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              className="flex w-full items-center justify-between rounded-md px-2 py-1.5 hover:bg-muted/50 transition-colors"
            >
              <div className="flex items-center gap-2">
                <IconHeartbeat size={18} className="text-primary" />
                <span className="text-sm font-medium">
                  {needsAttention === 0 ? (
                    <span className="text-success">
                      No agents need attention
                    </span>
                  ) : (
                    <span className="text-destructive">
                      {needsAttention} agent{needsAttention !== 1 ? 's' : ''} need attention
                    </span>
                  )}
                </span>
              </div>
              {expanded ? (
                <IconChevronDown size={16} className="text-muted-foreground" />
              ) : (
                <IconChevronRight size={16} className="text-muted-foreground" />
              )}
            </button>

            {expanded && (
              <div className="space-y-1 pl-2">
                {summary.agents.map((agent) => (
                  <Link
                    key={agent.agent}
                    href={`/agents?agent=${encodeURIComponent(agent.agent)}`}
                    className="flex items-center justify-between rounded-md px-2 py-1.5 hover:bg-muted/50 transition-colors text-sm"
                  >
                    <div className="flex items-center gap-2">
                      <HealthDot status={agent.health} />
                      <span>{agent.agent}</span>
                      {!agent.needsAttention && agent.attentionLabel !== 'Healthy' && (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          {agent.attentionLabel}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      {agent.currentTask && (
                        <span className="truncate max-w-[120px]">
                          {agent.currentTask}
                        </span>
                      )}
                      {agent.lastHeartbeat && (
                        <TimeAgo date={agent.lastHeartbeat} />
                      )}
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
