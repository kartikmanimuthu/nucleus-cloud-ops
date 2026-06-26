import { cn } from '@/lib/utils';

interface PageHeaderProps {
    title: string;
    description?: string;
    /** Action buttons rendered on the right (e.g. Refresh / Create). */
    actions?: React.ReactNode;
    className?: string;
}

/**
 * Sticky page header shared across feature pages: title + description on the
 * left, actions on the right. Replaces the repeated inline header block.
 */
export function PageHeader({ title, description, actions, className }: PageHeaderProps) {
    return (
        <div
            className={cn(
                'sticky top-0 z-10 flex items-center justify-between gap-4 border-b bg-background p-4',
                className,
            )}
        >
            <div className="min-w-0">
                <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
                {description && (
                    <p className="text-muted-foreground">{description}</p>
                )}
            </div>
            {actions && (
                <div className="flex shrink-0 items-center space-x-2">{actions}</div>
            )}
        </div>
    );
}
