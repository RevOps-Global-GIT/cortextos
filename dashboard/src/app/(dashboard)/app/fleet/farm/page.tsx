'use client';

import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  IconRefresh,
  IconServer,
  IconPlayerPlay,
  IconChartBar,
  IconBolt,
  IconCircleCheck,
  IconClock,
} from '@tabler/icons-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LastRun {
  run_id: string;
  wall_s: number;
  success: number;
  workers: number;
  speedup: number;
  finished_at: string;
}

interface FarmStatus {
  updated_at: string;
  outstanding_tasks: number;
  active_run_capacity: number;
  runs_today: number;
  avg_run_duration_s: number;
  avg_task_duration_s: number;
  avg_speedup: number;
  success_rate: number;
  last_run: LastRun | null;
}

interface ApiResponse {
  ok: boolean;
  status?: FarmStatus;
  error?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt(n: number, decimals = 1): string {
  return n.toFixed(decimals);
}

function relativeTime(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

// ---------------------------------------------------------------------------
// Stat card
// ---------------------------------------------------------------------------

function StatCard({
  title,
  value,
  sub,
  icon: Icon,
  highlight,
}: {
  title: string;
  value: string;
  sub?: string;
  icon: React.ElementType;
  highlight?: boolean;
}) {
  return (
    <Card className={highlight ? 'border-green-500/40 bg-green-500/5' : ''}>
      <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function FarmKpiPage() {
  const [data, setData] = useState<FarmStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastFetched, setLastFetched] = useState<Date | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/farm/status');
      const json: ApiResponse = await res.json();
      if (json.ok && json.status) {
        setData(json.status);
        setError(null);
      } else {
        setError(json.error ?? 'Unknown error');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setLastFetched(new Date());
    }
  }, []);

  useEffect(() => {
    void fetchStatus();
    const interval = setInterval(() => { void fetchStatus(); }, 15_000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  const isActive = data && data.active_run_capacity > 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <IconServer className="h-6 w-6" />
            Farm KPI
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Codex-ComputerUse VM · claude-farm supervisor process · auto-refreshes every 15s
          </p>
        </div>
        <div className="flex items-center gap-3">
          {lastFetched && (
            <span className="text-xs text-muted-foreground">
              Updated {relativeTime(lastFetched.toISOString())}
            </span>
          )}
          <Badge variant={isActive ? 'default' : 'secondary'} className={isActive ? 'bg-green-600' : ''}>
            {isActive ? 'Active' : 'Idle'}
          </Badge>
          <Button variant="outline" size="sm" onClick={() => { void fetchStatus(); }} disabled={loading}>
            <IconRefresh className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      {/* Error state */}
      {error && (
        <Card className="border-destructive/50 bg-destructive/10">
          <CardContent className="pt-4">
            <p className="text-sm text-destructive font-medium">Farm unreachable: {error}</p>
          </CardContent>
        </Card>
      )}

      {/* KPI Cards */}
      {data && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            <StatCard
              title="Runs Today"
              value={String(data.runs_today)}
              sub="since midnight UTC"
              icon={IconPlayerPlay}
            />
            <StatCard
              title="Avg Speedup"
              value={`${fmt(data.avg_speedup)}×`}
              sub="parallel vs serial"
              icon={IconBolt}
              highlight={data.avg_speedup >= 2}
            />
            <StatCard
              title="Success Rate"
              value={`${fmt(data.success_rate * 100, 0)}%`}
              sub="all runs today"
              icon={IconCircleCheck}
              highlight={data.success_rate === 1}
            />
            <StatCard
              title="Active Capacity"
              value={String(data.active_run_capacity)}
              sub="workers in a run"
              icon={IconServer}
            />
            <StatCard
              title="Pending Tasks"
              value={String(data.outstanding_tasks)}
              sub="queued in inbox"
              icon={IconChartBar}
            />
            <StatCard
              title="Avg Run Duration"
              value={`${fmt(data.avg_run_duration_s)}s`}
              sub="wall time"
              icon={IconClock}
            />
            <StatCard
              title="Avg Task Duration"
              value={`${fmt(data.avg_task_duration_s)}s`}
              sub="per sub-task"
              icon={IconClock}
            />
          </div>

          {/* Last Run */}
          {data.last_run && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Last Run</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                  <div>
                    <p className="text-muted-foreground text-xs">Run ID</p>
                    <p className="font-mono text-xs truncate">{data.last_run.run_id}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground text-xs">Tasks Succeeded</p>
                    <p className="font-semibold">{data.last_run.success}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground text-xs">Wall Time</p>
                    <p className="font-semibold">{fmt(data.last_run.wall_s)}s</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground text-xs">Finished</p>
                    <p className="font-semibold">{relativeTime(data.last_run.finished_at)}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          <p className="text-xs text-muted-foreground">
            Status as of {relativeTime(data.updated_at)} · VM: 3ec3d7f3 (Codex-ComputerUse)
          </p>
        </>
      )}

      {loading && !data && (
        <div className="text-sm text-muted-foreground">Loading farm status...</div>
      )}
    </div>
  );
}
