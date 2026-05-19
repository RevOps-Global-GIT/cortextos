'use client';

import { useState } from 'react';
import {
  IconCircleCheck,
  IconDotsVertical,
  IconEye,
  IconLoader2,
  IconLockOpen,
  IconPlayerPlay,
} from '@tabler/icons-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { PriorityBadge, OrgBadge, TimeAgo } from '@/components/shared';
import { IconCalendar } from '@tabler/icons-react';
import { cn } from '@/lib/utils';
import { AgentCursorStack, presenceRingStyle } from './agent-cursor';
import type { AgentPresencePayload } from '@/lib/agent-presence';
import type { Task, TaskStatus } from '@/lib/types';

const QUICK_ACTIONS: Partial<Record<TaskStatus, { label: string; next: TaskStatus; icon: typeof IconPlayerPlay }>> = {
  pending:     { label: 'Start',    next: 'in_progress', icon: IconPlayerPlay },
  in_progress: { label: 'Complete', next: 'completed',   icon: IconCircleCheck },
  blocked:     { label: 'Unblock',  next: 'in_progress', icon: IconLockOpen },
};

interface TaskCardProps {
  task: Task;
  presence?: AgentPresencePayload[];
  onClick?: (task: Task) => void;
  onStatusChange?: (taskId: string, status: TaskStatus) => Promise<void>;
}

export function TaskCard({ task, presence, onClick, onStatusChange }: TaskCardProps) {
  const [busy, setBusy] = useState(false);
  const action = QUICK_ACTIONS[task.status];
  const ActionIcon = action?.icon;

  function handleDetails(e: React.MouseEvent) {
    e.stopPropagation();
    onClick?.(task);
  }

  async function handleAction() {
    if (!action || !onStatusChange) return;
    setBusy(true);
    try {
      await onStatusChange(task.id, action.next);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      className="group relative min-h-[116px] cursor-pointer overflow-visible p-3 transition-[background-color,box-shadow] duration-200 ease-out hover:bg-muted/50"
      style={presenceRingStyle(presence)}
      data-task-id={task.id}
      onClick={() => onClick?.(task)}
    >
      <AgentCursorStack presence={presence} />
      <div className="space-y-2">
        <p className={cn('text-sm font-medium leading-snug line-clamp-2', presence?.length && 'pr-40')}>
          {task.title}
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          <PriorityBadge priority={task.priority} />
          <OrgBadge org={task.org} />
        </div>
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          {task.assignee ? (
            <span className="truncate max-w-[120px]">{task.assignee}</span>
          ) : (
            <span className="italic">Unassigned</span>
          )}
          <div className="flex shrink-0 items-center gap-1">
            {task.scheduled_for && new Date(task.scheduled_for) > new Date() ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-700 dark:bg-sky-900/30 dark:text-sky-300">
                <IconCalendar size={11} />
                {new Date(task.scheduled_for).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              </span>
            ) : (
              <TimeAgo date={task.created_at} className="text-xs" />
            )}
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={handleDetails}
              aria-label={`View details for ${task.title}`}
              title="Details"
              className="h-6 w-6 opacity-100 md:opacity-0 md:transition-opacity md:group-hover:opacity-100 md:group-focus-within:opacity-100"
            >
              <IconEye size={13} />
            </Button>
            {action && onStatusChange && ActionIcon && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      disabled={busy}
                      className="h-6 w-6 opacity-100 md:opacity-0 md:transition-opacity md:group-hover:opacity-100 md:group-focus-within:opacity-100"
                    />
                  }
                  onClick={(e) => e.stopPropagation()}
                  aria-label={`Task actions for ${task.title}`}
                  title="Task actions"
                >
                  {busy ? (
                    <IconLoader2 size={13} className="animate-spin" />
                  ) : (
                    <IconDotsVertical size={13} />
                  )}
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" sideOffset={4} onClick={(e) => e.stopPropagation()}>
                  <DropdownMenuItem onClick={handleAction}>
                    <ActionIcon className="h-4 w-4" />
                    {action.label}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {!action && (
              <Button
                size="icon-xs"
                variant="ghost"
                disabled
                aria-label="No quick actions"
                className="h-6 w-6 opacity-0"
              >
                <IconDotsVertical size={13} />
              </Button>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}
