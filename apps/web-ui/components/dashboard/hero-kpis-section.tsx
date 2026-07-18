'use client';

import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useDashboardHero } from '@/lib/queries/dashboard';
import type { TimeRange, HeroKpiCard } from '@/lib/dashboard-types';
import { cn } from '@/lib/utils';
import { ArrowDownIcon, ArrowUpIcon, MinusIcon, PiggyBankIcon, CheckCircleIcon, ServerIcon, BotIcon, ShieldAlertIcon, ClockIcon } from 'lucide-react';
import Link from 'next/link';

const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
    savings: PiggyBankIcon,
    'success-rate': CheckCircleIcon,
    accounts: ServerIcon,
    'agent-runs': BotIcon,
    approvals: ClockIcon,
    'audit-events': ShieldAlertIcon,
    'schedule-success': CheckCircleIcon,
    'accounts-synced': ServerIcon,
    'agent-approvals': ClockIcon,
    'critical-events': ShieldAlertIcon,
};

function KpiCard({ card }: { card: HeroKpiCard }) {
    const Icon = ICON_MAP[card.icon] || ServerIcon;
    const isPositive =
        (card.higherIsBetter && card.deltaDirection === 'up') ||
        (!card.higherIsBetter && card.deltaDirection === 'down');
    const isNegative =
        (card.higherIsBetter && card.deltaDirection === 'down') ||
        (!card.higherIsBetter && card.deltaDirection === 'up');

    const DeltaIcon =
        card.deltaDirection === 'up'
            ? ArrowUpIcon
            : card.deltaDirection === 'down'
              ? ArrowDownIcon
              : MinusIcon;

    return (
        <Link href={card.href} className="block transition-transform hover:scale-[1.01]">
            <Card className="h-full">
                <CardContent className="flex flex-col justify-between p-5">
                    <div className="flex items-start justify-between">
                        <div className="space-y-1">
                            <p className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
                                {card.label}
                            </p>
                            <p className="text-2xl font-semibold tracking-tight">{card.formattedValue}</p>
                        </div>
                        <div className="rounded-md bg-muted p-2">
                            <Icon className="h-4 w-4 text-muted-foreground" />
                        </div>
                    </div>

                    <div className="mt-4 flex items-center gap-2">
                        <span
                            className={cn(
                                'inline-flex items-center gap-0.5 text-xs font-medium',
                                isPositive && 'text-emerald-600',
                                isNegative && 'text-red-600',
                                !isPositive && !isNegative && 'text-slate-500'
                            )}
                        >
                            <DeltaIcon className="h-3 w-3" />
                            {card.delta}%
                        </span>
                        <span className="text-muted-foreground text-xs">vs previous period</span>
                    </div>

                    {card.sparkline.length > 0 && (
                        <div className="mt-3 flex h-8 items-end gap-0.5">
                            {card.sparkline.map((value, i) => {
                                const max = Math.max(...card.sparkline, 1);
                                const height = `${Math.max((value / max) * 100, 8)}%`;
                                return (
                                    <div
                                        key={i}
                                        className={cn(
                                            'flex-1 rounded-sm',
                                            isPositive ? 'bg-emerald-500/20' : 'bg-blue-500/20'
                                        )}
                                        style={{ height }}
                                    />
                                );
                            })}
                        </div>
                    )}
                </CardContent>
            </Card>
        </Link>
    );
}

function KpiSkeleton() {
    return (
        <Card className="h-full">
            <CardContent className="p-5">
                <div className="flex items-start justify-between">
                    <div className="space-y-2">
                        <Skeleton className="h-3 w-20" />
                        <Skeleton className="h-7 w-24" />
                    </div>
                    <Skeleton className="h-9 w-9 rounded-md" />
                </div>
                <Skeleton className="mt-4 h-3 w-28" />
                <Skeleton className="mt-3 h-8 w-full" />
            </CardContent>
        </Card>
    );
}

export function HeroKpisSection({ range }: { range: TimeRange }) {
    const { data, isLoading, error } = useDashboardHero(range);

    if (error) {
        return (
            <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30">
                Failed to load KPIs: {error.message}
            </div>
        );
    }

    return (
        <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            {isLoading
                ? Array.from({ length: 6 }).map((_, i) => <KpiSkeleton key={i} />)
                : data?.cards.map((card) => <KpiCard key={card.id} card={card} />)}
        </section>
    );
}
