import * as React from 'react';
import { Loader2 } from 'lucide-react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const spinnerVariants = cva('animate-spin text-muted-foreground', {
    variants: {
        size: {
            xs: 'h-3 w-3',
            sm: 'h-4 w-4',
            md: 'h-6 w-6',
            lg: 'h-8 w-8',
            xl: 'h-12 w-12',
        },
    },
    defaultVariants: {
        size: 'md',
    },
});

export interface SpinnerProps
    extends React.HTMLAttributes<HTMLDivElement>,
        VariantProps<typeof spinnerVariants> {
    /** Accessible label announced to screen readers. Defaults to "Loading". */
    label?: string;
}

/**
 * Spinner — the canonical loading indicator. Use for in-flight actions
 * (buttons, inline fetches). For content placeholders prefer Skeleton/Shimmer.
 */
export function Spinner({ size, label = 'Loading', className, ...props }: SpinnerProps) {
    return (
        <div role="status" aria-live="polite" className={cn('inline-flex', className)} {...props}>
            <Loader2 className={cn(spinnerVariants({ size }))} aria-hidden="true" />
            <span className="sr-only">{label}</span>
        </div>
    );
}

/**
 * Full-area centered spinner for page/section loading states.
 */
export function SpinnerOverlay({
    label = 'Loading',
    className,
    size = 'lg',
}: {
    label?: string;
    className?: string;
    size?: SpinnerProps['size'];
}) {
    return (
        <div
            className={cn(
                'flex min-h-[200px] w-full flex-col items-center justify-center gap-3',
                className,
            )}
        >
            <Spinner size={size} label={label} />
            {label && <p className="text-sm text-muted-foreground">{label}</p>}
        </div>
    );
}

export { spinnerVariants };
