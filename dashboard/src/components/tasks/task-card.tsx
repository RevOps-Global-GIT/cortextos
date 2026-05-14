'use client';

import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { PriorityBadge, OrgBadge, TimeAgo } from '@/components/shared';
import type { Task, TaskStatus } from '@/lib/types';

const QUICK_ACTIONS: Partial<Record<TaskStatus, { label: string; next: TaskStatus }>> = {
  pending:     { label: 'Start',    next: 'in_progress' },
  in_progress: { label: 'Complete', next: 'completed' },
  blocked:     { label: 'Unblock',  next: 'in_progress' },
};

interface TaskCardProps {
  task: Task;
  onClick?: (task: Task) => void;
  onStatusChange?: (taskId: string, status: TaskStatus) => Promise<void>;
}

export function TaskCard({ task, onClick, onStatusChange }: TaskCardProps) {
  const [busy, setBusy] = useState(false);
  const action = QUICK_ACTIONS[task.status];

  async function handleAction(e: React.MouseEvent) {
    e.stopPropagation();
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
      className="cursor-pointer p-3 transition-colors hover:bg-muted/50"
      onClick={() => onClick?.(task)}
    >
      <div className="space-y-2">
        <p className="text-sm font-medium leading-snug line-clamp-2">
          {task.title}
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          <PriorityBadge priority={task.priority} />
          <OrgBadge org={task.org} />
        </div>
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          {task.assignee ? (
            <span className="truncate max-w-[120px]">{task.assignee}</span>
          ) : (
            <span className="italic">Unassigned</span>
          )}
          <div className="flex items-center gap-2">
            <TimeAgo date={task.created_at} className="text-xs" />
            {action && onStatusChange && (
              <Button
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={handleAction}
                className="h-5 px-1.5 text-[10px]"
              >
                {action.label}
              </Button>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}
