import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

interface PageHeaderProps {
    title: string;
    description?: string;
    /** Optional icon shown in a tinted rounded square before the title. */
    icon?: LucideIcon;
    /** Action buttons rendered on the right (e.g. Refresh / Create). */
    actions?: React.ReactNode;
    className?: string;
}

/**
 * Page header shared across feature pages: an optional tinted icon + title +
 * description on the left, actions on the right. Sits below the global top bar
 * (which owns the sticky border), so this is a plain content header.
 */
export function PageHeader({ title, description, icon: Icon, actions, className }: PageHeaderProps) {
    return (
        <div
            className={cn(
                'mb-6 flex items-start justify-between gap-4',
                className,
            )}
        >
            <div className="flex min-w-0 items-center gap-3">
                {Icon && (
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                        <Icon className="size-5" />
                    </span>
                )}
                <div className="min-w-0">
                    <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
                    {description && (
                        <p className="text-sm text-muted-foreground">{description}</p>
                    )}
                </div>
            </div>
            {actions && (
                <div className="flex shrink-0 items-center gap-2">{actions}</div>
            )}
        </div>
    );
}
