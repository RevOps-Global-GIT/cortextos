'use client';

import { useState, useMemo, type ReactNode } from 'react';
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { PriorityBadge, StatusBadge, OrgBadge, TimeAgo } from '@/components/shared';
import { IconArrowsSort, IconSortAscending, IconSortDescending } from '@tabler/icons-react';
import { AgentCursorStack, presenceRingStyle } from './agent-cursor';
import type { AgentPresencePayload } from '@/lib/agent-presence';
import type { Task, TaskStatus } from '@/lib/types';

const QUICK_ACTIONS: Partial<Record<TaskStatus, { label: string; next: TaskStatus }>> = {
  proposed:    { label: 'Approve',  next: 'approved' },
  pending:     { label: 'Start',    next: 'in_progress' },
  approved:    { label: 'Start',    next: 'in_progress' },
  in_progress: { label: 'Complete', next: 'completed' },
  blocked:     { label: 'Unblock',  next: 'in_progress' },
};

const BATCH_DOT_COLOR: Record<TaskStatus, string> = {
  proposed: 'bg-slate-400',
  pending: 'bg-muted-foreground/40',
  approved: 'bg-blue-400',
  in_progress: 'bg-blue-500',
  completed: 'bg-green-500',
  blocked: 'bg-red-500',
  cancelled: 'bg-muted-foreground/30',
};

type SortField = 'title' | 'status' | 'priority' | 'assignee' | 'org' | 'created_at';
type SortDir = 'asc' | 'desc';

const PRIORITY_ORDER: Record<string, number> = { critical: 0, urgent: 0, high: 1, normal: 2, low: 3 };
const STATUS_ORDER: Record<TaskStatus, number> = {
  blocked: 0,
  in_progress: 1,
  approved: 2,
  proposed: 3,
  pending: 4,
  completed: 5,
  cancelled: 6,
};

interface TaskListTableProps {
  tasks: Task[];
  presenceByTask?: Record<string, AgentPresencePayload[]>;
  onTaskClick: (task: Task) => void;
  onStatusChange?: (taskId: string, status: TaskStatus) => Promise<void>;
}

export function TaskListTable({
  tasks,
  presenceByTask = {},
  onTaskClick,
  onStatusChange,
}: TaskListTableProps) {
  const [sortField, setSortField] = useState<SortField>('created_at');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const sorted = useMemo(() => {
    const copy = [...tasks];
    copy.sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case 'title':
          cmp = a.title.localeCompare(b.title);
          break;
        case 'status':
          cmp = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
          break;
        case 'priority':
          cmp = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
          break;
        case 'assignee':
          cmp = (a.assignee ?? '').localeCompare(b.assignee ?? '');
          break;
        case 'org':
          cmp = a.org.localeCompare(b.org);
          break;
        case 'created_at':
          cmp = a.created_at.localeCompare(b.created_at);
          break;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return copy;
  }, [tasks, sortField, sortDir]);

  function toggleSort(field: SortField) {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  }

  function SortIcon({ field }: { field: SortField }) {
    if (sortField !== field)
      return <IconArrowsSort className="size-3.5 text-muted-foreground/50" />;
    return sortDir === 'asc' ? (
      <IconSortAscending className="size-3.5" />
    ) : (
      <IconSortDescending className="size-3.5" />
    );
  }

  const columns: { field: SortField; label: string }[] = [
    { field: 'title', label: 'Title' },
    { field: 'status', label: 'Status' },
    { field: 'priority', label: 'Priority' },
    { field: 'assignee', label: 'Assignee' },
    { field: 'org', label: 'Org' },
    { field: 'created_at', label: 'Created' },
  ];

  const colSpan = onStatusChange ? 7 : 6;

  // Pre-compute batch groups so we can render a header row above siblings
  // sharing the same dispatch_batch_id. Members keep the sorted order they
  // already have; the header inherits the agent + parallel_count from any
  // member (they all share these fields by construction).
  const batchGroups = useMemo(() => {
    const groups = new Map<string, Task[]>();
    for (const t of sorted) {
      const bid = t.dispatch_batch_id;
      if (!bid) continue;
      const arr = groups.get(bid);
      if (arr) arr.push(t);
      else groups.set(bid, [t]);
    }
    return groups;
  }, [sorted]);

  return (
    <Table>
      <TableHeader>
        <TableRow>
          {columns.map((col) => (
            <TableHead
              key={col.field}
              className="cursor-pointer select-none"
              onClick={() => toggleSort(col.field)}
            >
              <span className="inline-flex items-center gap-1">
                {col.label}
                <SortIcon field={col.field} />
              </span>
            </TableHead>
          ))}
          {onStatusChange && <TableHead />}
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.length === 0 ? (
          <TableRow>
            <TableCell colSpan={colSpan} className="text-center text-muted-foreground py-8">
              No tasks found
            </TableCell>
          </TableRow>
        ) : (
          (() => {
            const emittedBatches = new Set<string>();
            const rows: ReactNode[] = [];
            for (const task of sorted) {
              const bid = task.dispatch_batch_id;
              if (bid && !emittedBatches.has(bid)) {
                emittedBatches.add(bid);
                const members = batchGroups.get(bid) ?? [];
                const headerAgent = members[0]?.assignee ?? task.assignee ?? '-';
                const headerCount = members[0]?.parallel_count ?? members.length;
                rows.push(
                  <TableRow
                    key={`batch-${bid}`}
                    className="bg-muted/40 border-y border-border/60 text-xs"
                    data-batch-id={bid}
                  >
                    <TableCell colSpan={colSpan} className="py-1.5">
                      <div className="flex items-center gap-3 font-mono">
                        <span className="text-muted-foreground">batch</span>
                        <span className="rounded bg-background px-1.5 py-0.5 font-semibold">
                          {bid.slice(0, 8)}
                        </span>
                        <span className="text-muted-foreground">→</span>
                        <span className="font-medium">{headerAgent}</span>
                        <span className="text-muted-foreground">×{headerCount}</span>
                        <span className="ml-2 inline-flex items-center gap-1">
                          {members.map((m) => (
                            <span
                              key={m.id}
                              title={`${m.title} — ${m.status}`}
                              className={`inline-block size-2 rounded-full ${BATCH_DOT_COLOR[m.status] ?? 'bg-muted-foreground/40'}`}
                            />
                          ))}
                        </span>
                      </div>
                    </TableCell>
                  </TableRow>,
                );
              }
              const action = QUICK_ACTIONS[task.status];
              rows.push(
                <TableRow
                  key={task.id}
                  className={`relative cursor-pointer transition-shadow duration-200 ease-out${bid ? ' [&>td:first-child]:pl-6' : ''}`}
                  style={presenceRingStyle(presenceByTask[task.id])}
                  data-task-id={task.id}
                  data-batch-id={bid ?? undefined}
                  onClick={() => onTaskClick(task)}
                >
                  <TableCell className="relative max-w-[300px] truncate pr-36 font-medium">
                    {task.title}
                    <AgentCursorStack presence={presenceByTask[task.id]} compact />
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={task.status} />
                  </TableCell>
                  <TableCell>
                    <PriorityBadge priority={task.priority} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {task.assignee ?? '-'}
                  </TableCell>
                  <TableCell>
                    <OrgBadge org={task.org} />
                  </TableCell>
                  <TableCell>
                    <TimeAgo date={task.created_at} />
                  </TableCell>
                  {onStatusChange && (
                    <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                      {action && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 px-2 text-xs"
                          onClick={() => onStatusChange(task.id, action.next)}
                        >
                          {action.label}
                        </Button>
                      )}
                    </TableCell>
                  )}
                </TableRow>,
              );
            }
            return rows;
          })()
        )}
      </TableBody>
    </Table>
  );
}
