'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  IconArrowLeft,
  IconAlertTriangle,
  IconCircleCheck,
  IconCircleX,
  IconClock,
  IconFilter,
  IconRefresh,
  IconSearch,
  IconShieldCheck,
} from '@tabler/icons-react';
import { useOrg } from '@/hooks/use-org';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type {
  AutomationRegistryItem,
  AutomationRegistryResponse,
  AutomationRegistryRisk,
  AutomationRegistryStatus,
} from '@/lib/automation-registry';

type SourceFilter = 'all' | AutomationRegistryItem['sourceType'];
type StatusFilter = 'all' | AutomationRegistryStatus;
type DuplicateFilter = 'all' | 'duplicated' | 'unique' | string;

function statusBadge(status: AutomationRegistryStatus) {
  if (status === 'ok') return 'default';
  if (status === 'fail' || status === 'blocked') return 'destructive';
  if (status === 'warn') return 'secondary';
  return 'outline';
}

function riskBadge(risk: AutomationRegistryRisk) {
  if (risk === 'high') return 'destructive';
  if (risk === 'medium') return 'secondary';
  return 'outline';
}

function StatusIcon({ status }: { status: AutomationRegistryStatus }) {
  if (status === 'ok') return <IconCircleCheck size={13} className="text-green-600 dark:text-green-400" />;
  if (status === 'fail' || status === 'blocked') return <IconCircleX size={13} className="text-red-600 dark:text-red-400" />;
  return <IconAlertTriangle size={13} className="text-yellow-600 dark:text-yellow-400" />;
}

function formatDate(value: string | null): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export default function AutomationRegistryPage() {
  const router = useRouter();
  const { currentOrg } = useOrg();
  const [data, setData] = useState<AutomationRegistryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [ownerFilter, setOwnerFilter] = useState('all');
  const [cadenceFilter, setCadenceFilter] = useState('all');
  const [riskFilter, setRiskFilter] = useState<'all' | AutomationRegistryRisk>('all');
  const [notificationFilter, setNotificationFilter] = useState('all');
  const [duplicateFilter, setDuplicateFilter] = useState<DuplicateFilter>('all');

  const fetchRegistry = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = currentOrg && currentOrg !== 'all'
        ? `?org=${encodeURIComponent(currentOrg)}`
        : '';
      const res = await fetch(`/api/workflows/registry${params}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      setData(await res.json() as AutomationRegistryResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load automation registry.');
    } finally {
      setLoading(false);
    }
  }, [currentOrg]);

  useEffect(() => {
    void fetchRegistry();
  }, [fetchRegistry]);

  const items = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (data?.items ?? []).filter((item) => {
      if (sourceFilter !== 'all' && item.sourceType !== sourceFilter) return false;
      if (statusFilter !== 'all' && item.status !== statusFilter) return false;
      if (ownerFilter !== 'all' && item.owner !== ownerFilter) return false;
      if (cadenceFilter !== 'all' && item.cadence !== cadenceFilter) return false;
      if (riskFilter !== 'all' && item.risk !== riskFilter) return false;
      if (notificationFilter !== 'all' && item.notificationBehavior !== notificationFilter) return false;
      if (duplicateFilter === 'duplicated' && item.duplicateCount <= 1) return false;
      if (duplicateFilter === 'unique' && item.duplicateCount > 1) return false;
      if (!['all', 'duplicated', 'unique'].includes(duplicateFilter) && item.duplicateGroup !== duplicateFilter) return false;
      if (!needle) return true;
      return [
        item.label,
        item.owner,
        item.source,
        item.cadence,
        item.detail,
        item.nextAction,
        item.notificationBehavior,
        item.duplicateGroup,
      ].some((value) => value.toLowerCase().includes(needle));
    });
  }, [
    data?.items,
    query,
    sourceFilter,
    statusFilter,
    ownerFilter,
    cadenceFilter,
    riskFilter,
    notificationFilter,
    duplicateFilter,
  ]);

  const summary = data?.summary;

  return (
    <div className="space-y-6">
      <button
        onClick={() => router.push('/workflows')}
        className="flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <IconArrowLeft size={15} />
        Workflows
      </button>

      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Automation Registry</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Fleet Schedules / Automation Registry for daemon crons, capability probes, owners, freshness, risk, and next actions
          </p>
          {data?.sourceLineage && (
            <p className="mt-1 text-xs text-muted-foreground">
              API lineage: {data.sourceLineage.join(' -> ')}
            </p>
          )}
        </div>
        <button
          onClick={fetchRegistry}
          className="shrink-0 rounded-md p-2 transition-colors hover:bg-muted"
          title="Refresh"
        >
          <IconRefresh size={15} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Card>
          <CardContent className="pb-3 pt-4">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Total</p>
            <p className="mt-1 text-3xl font-semibold">{loading ? '-' : summary?.total ?? 0}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pb-3 pt-4">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">OK</p>
            <p className="mt-1 text-3xl font-semibold text-green-600 dark:text-green-400">{loading ? '-' : summary?.ok ?? 0}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pb-3 pt-4">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Needs Action</p>
            <p className="mt-1 text-3xl font-semibold text-yellow-600 dark:text-yellow-400">{loading ? '-' : summary?.needsAction ?? 0}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pb-3 pt-4">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Blocked/Fail</p>
            <p className="mt-1 text-3xl font-semibold text-red-600 dark:text-red-400">
              {loading ? '-' : (summary?.blocked ?? 0) + (summary?.fail ?? 0)}
            </p>
          </CardContent>
        </Card>
        <Card className="col-span-2 md:col-span-1">
          <CardContent className="pb-3 pt-4">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">High Risk</p>
            <p className="mt-1 text-3xl font-semibold">{loading ? '-' : summary?.highRisk ?? 0}</p>
          </CardContent>
        </Card>
        <Card className="col-span-2 md:col-span-5">
          <CardContent className="grid gap-3 pb-3 pt-4 md:grid-cols-3">
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Duplicate Groups</p>
              <p className="mt-1 text-2xl font-semibold">{loading ? '-' : summary?.duplicateGroups ?? 0}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Duplicate Rows</p>
              <p className="mt-1 text-2xl font-semibold">{loading ? '-' : summary?.duplicateRows ?? 0}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Surface</p>
              <p className="mt-1 text-sm font-medium">{data?.surface ?? 'fleet-schedules/automation-registry'}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <IconShieldCheck size={16} />
              Fleet Schedules / Automation Registry
            </CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <IconSearch
                  size={14}
                  className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
                />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search registry..."
                  className="h-8 w-52 rounded-md border bg-background pl-8 pr-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                  aria-label="Search registry"
                />
              </div>
              <select
                value={ownerFilter}
                onChange={(event) => setOwnerFilter(event.target.value)}
                className="h-8 max-w-52 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                aria-label="Filter owner"
              >
                <option value="all">All owners</option>
                {(data?.filters.owners ?? []).map((owner) => (
                  <option key={owner} value={owner}>{owner}</option>
                ))}
              </select>
              <select
                value={cadenceFilter}
                onChange={(event) => setCadenceFilter(event.target.value)}
                className="h-8 max-w-52 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                aria-label="Filter cadence"
              >
                <option value="all">All cadence</option>
                {(data?.filters.cadences ?? []).map((cadence) => (
                  <option key={cadence} value={cadence}>{cadence}</option>
                ))}
              </select>
              <div className="relative">
                <IconFilter
                  size={14}
                  className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
                />
                <select
                  value={sourceFilter}
                  onChange={(event) => setSourceFilter(event.target.value as SourceFilter)}
                  className="h-8 rounded-md border bg-background pl-8 pr-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                  aria-label="Filter source"
                >
                  <option value="all">All sources</option>
                  <option value="cron">Crons</option>
                  <option value="capability">Capabilities</option>
                </select>
              </div>
              <select
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
                className="h-8 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                aria-label="Filter status"
              >
                <option value="all">All status</option>
                <option value="ok">OK</option>
                <option value="warn">Warn</option>
                <option value="fail">Fail</option>
                <option value="blocked">Blocked</option>
                <option value="unknown">Unknown</option>
              </select>
              <select
                value={riskFilter}
                onChange={(event) => setRiskFilter(event.target.value as 'all' | AutomationRegistryRisk)}
                className="h-8 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                aria-label="Filter risk"
              >
                <option value="all">All risk</option>
                {(data?.filters.risks ?? ['high', 'medium', 'low']).map((risk) => (
                  <option key={risk} value={risk}>{risk}</option>
                ))}
              </select>
              <select
                value={notificationFilter}
                onChange={(event) => setNotificationFilter(event.target.value)}
                className="h-8 max-w-64 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                aria-label="Filter notification behavior"
              >
                <option value="all">All notification behavior</option>
                {(data?.filters.notificationBehaviors ?? []).map((notification) => (
                  <option key={notification} value={notification}>{notification}</option>
                ))}
              </select>
              <select
                value={duplicateFilter}
                onChange={(event) => setDuplicateFilter(event.target.value)}
                className="h-8 max-w-64 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                aria-label="Filter duplicate group"
              >
                <option value="all">All duplicate groups</option>
                <option value="duplicated">Duplicated only</option>
                <option value="unique">Unique only</option>
                {(data?.filters.duplicateGroups ?? []).map((group) => (
                  <option key={group} value={group}>{group}</option>
                ))}
              </select>
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          {error && (
            <div className="mb-3 rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full min-w-[1120px] text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th className="pb-2 pr-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">Source</th>
                  <th className="pb-2 pr-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">Owner</th>
                  <th className="pb-2 pr-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">Cadence</th>
                  <th className="pb-2 pr-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">Status</th>
                  <th className="pb-2 pr-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">Freshness</th>
                  <th className="pb-2 pr-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">Risk / Noise</th>
                  <th className="pb-2 pr-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">Duplicate Group</th>
                  <th className="pb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Next action</th>
                </tr>
              </thead>
              <tbody>
                {loading && items.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-8 text-center text-muted-foreground">
                      Loading registry...
                    </td>
                  </tr>
                ) : items.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-8 text-center text-muted-foreground">
                      No registry entries match the current filters.
                    </td>
                  </tr>
                ) : (
                  items.map((item) => (
                    <tr key={item.id} className="border-b align-top last:border-0">
                      <td className="py-3 pr-4">
                        <div className="flex items-start gap-2">
                          <IconClock size={14} className="mt-0.5 shrink-0 text-muted-foreground" />
                          <div>
                            <p className="font-medium">{item.label}</p>
                            <p className="mt-0.5 text-xs text-muted-foreground">{item.source}</p>
                          </div>
                        </div>
                      </td>
                      <td className="py-3 pr-4">
                        <p className="font-medium">{item.owner}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">{item.org}</p>
                      </td>
                      <td className="py-3 pr-4">
                        <p className="max-w-[180px] text-xs">{item.cadence}</p>
                        <p className="mt-1 text-xs text-muted-foreground">next: {formatDate(item.nextExpectedAt)}</p>
                      </td>
                      <td className="py-3 pr-4">
                        <Badge variant={statusBadge(item.status)} className="gap-1 text-[10px]">
                          <StatusIcon status={item.status} />
                          {item.status}
                        </Badge>
                      </td>
                      <td className="py-3 pr-4">
                        <p className="max-w-[230px] text-xs text-muted-foreground">{item.freshness}</p>
                        <p className="mt-1 text-xs text-muted-foreground">last: {formatDate(item.lastObservedAt)}</p>
                      </td>
                      <td className="py-3 pr-4">
                        <Badge variant={riskBadge(item.risk)} className="mb-1 text-[10px]">
                          {item.risk} risk
                        </Badge>
                        <p className="max-w-[230px] text-xs text-muted-foreground">{item.noise}</p>
                      </td>
                      <td className="py-3 pr-4">
                        <Badge variant={item.duplicateCount > 1 ? 'secondary' : 'outline'} className="mb-1 text-[10px]">
                          {item.duplicateCount > 1 ? `${item.duplicateCount} rows` : 'unique'}
                        </Badge>
                        <p className="max-w-[230px] text-xs text-muted-foreground">{item.duplicateGroup}</p>
                      </td>
                      <td className="py-3">
                        <p className="max-w-[260px] text-xs">{item.nextAction}</p>
                        {item.proof && (
                          <p className="mt-1 max-w-[260px] text-xs text-muted-foreground">{item.proof}</p>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button variant="outline" size="sm" onClick={() => router.push('/workflows/health')}>
          Fleet Health
        </Button>
      </div>
    </div>
  );
}
