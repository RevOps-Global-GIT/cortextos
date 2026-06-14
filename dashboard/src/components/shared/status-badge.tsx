import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import type { TaskStatus } from '@/lib/types';

export interface StatusBadgeProps {
  status: TaskStatus;
  className?: string;
}

const statusConfig: Record<
  TaskStatus,
  { variant: 'outline' | 'default' | 'destructive' | 'secondary'; className?: string; label: string }
> = {
  proposed: { variant: 'outline', label: 'Proposed' },
  pending: { variant: 'outline', label: 'Pending' },
  approved: {
    variant: 'secondary',
    className: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
    label: 'Approved',
  },
  in_progress: { variant: 'default', label: 'In Progress' },
  blocked: { variant: 'destructive', label: 'Blocked' },
  completed: {
    variant: 'secondary',
    className: 'bg-success/10 text-success',
    label: 'Completed',
  },
  cancelled: {
    variant: 'secondary',
    className: 'bg-muted text-muted-foreground',
    label: 'Cancelled',
  },
};

export function StatusBadge({ status, className }: StatusBadgeProps) {
  const config = statusConfig[status] || { variant: 'outline' as const, label: String(status || 'Unknown') };

  return (
    <Badge
      variant={config.variant}
      className={cn(config.className, className)}
    >
      {config.label}
    </Badge>
  );
}
