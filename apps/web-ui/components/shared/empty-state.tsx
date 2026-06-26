import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

interface EmptyStateProps {
    /** Optional Lucide icon shown above the title. */
    icon?: LucideIcon;
    title: string;
    description?: string;
    /** Optional CTA (e.g. a Button) rendered below the description. */
    action?: React.ReactNode;
    className?: string;
}

/**
 * Consistent zero-state for lists, tables, and grids: centered icon + title +
 * description + optional action. Replaces ad-hoc per-page empty markup.
 */
export function EmptyState({
    icon: Icon,
    title,
    description,
    action,
    className,
}: EmptyStateProps) {
    return (
        <div
            className={cn(
                'flex flex-col items-center justify-center py-12 text-center',
                className,
            )}
        >
            {Icon && (
                <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                    <Icon className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
                </div>
            )}
            <h3 className="text-sm font-semibold">{title}</h3>
            {description && (
                <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
            )}
            {action && <div className="mt-4">{action}</div>}
        </div>
    );
}
