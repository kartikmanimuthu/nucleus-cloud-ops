'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useDashboardCostAutomation } from '@/lib/queries/dashboard';
import type { TimeRange } from '@/lib/dashboard-types';
import { PlayIcon, PauseIcon } from 'lucide-react';
import Link from 'next/link';
import { cn } from '@/lib/utils';

export function CostAutomationSection({ range }: { range: TimeRange }) {
    const { data, isLoading, error } = useDashboardCostAutomation(range);

    if (error) {
        return (
            <Card>
                <CardContent className="p-4 text-sm text-red-600">Failed to load cost metrics: {error.message}</CardContent>
            </Card>
        );
    }

    if (isLoading) {
        return (
            <Card>
                <CardHeader>
                    <Skeleton className="h-5 w-40" />
                </CardHeader>
                <CardContent className="space-y-3">
                    <Skeleton className="h-24 w-full" />
                    {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
                </CardContent>
            </Card>
        );
    }

    const summary = data?.summary;
    const trend = data?.trend ?? [];
    const recent = data?.recentExecutions ?? [];
    const maxSavings = Math.max(...trend.map((t) => t.savings), 1);

    return (
        <Card className="flex flex-col">
            <CardHeader className="pb-2">
                <CardTitle className="text-base font-semibold">Cost & Automation</CardTitle>
            </CardHeader>
            <CardContent className="flex-1 space-y-4">
                <div className="grid grid-cols-3 gap-3">
                    <div className="rounded-md border p-3">
                        <p className="text-muted-foreground text-xs uppercase">Est. Savings</p>
                        <p className="text-lg font-semibold text-emerald-600">${(summary?.totalSavings ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}</p>
                    </div>
                    <div className="rounded-md border p-3">
                        <p className="text-muted-foreground text-xs uppercase">Resources Optimized</p>
                        <p className="text-lg font-semibold">{(summary?.resourcesOptimized ?? 0).toLocaleString()}</p>
                    </div>
                    <div className="rounded-md border p-3">
                        <p className="text-muted-foreground text-xs uppercase">Top Account</p>
                        <p className="truncate text-sm font-semibold">{summary?.topAccountName || 'N/A'}</p>
                    </div>
                </div>

                {trend.length > 0 && (
                    <div className="space-y-1">
                        <p className="text-muted-foreground text-xs uppercase">Savings Trend</p>
                        <div className="flex h-16 items-end gap-1">
                            {trend.map((point, i) => {
                                const height = `${Math.max((point.savings / maxSavings) * 100, 4)}%`;
                                return (
                                    <div
                                        key={i}
                                        className="flex-1 rounded-sm bg-emerald-500/30 hover:bg-emerald-500/50"
                                        title={`${point.time}: $${point.savings.toFixed(2)}`}
                                        style={{ height }}
                                    />
                                );
                            })}
                        </div>
                        <div className="flex justify-between text-[10px] text-muted-foreground">
                            <span>{ trend[0]?.time }</span>
                            <span>{ trend[trend.length - 1]?.time }</span>
                        </div>
                    </div>
                )}

                <div className="space-y-1">
                    <p className="text-muted-foreground text-xs uppercase">Recent Executions</p>
                    <div className="max-h-[120px] space-y-1 overflow-y-auto">
                        {recent.slice(0, 5).map((exec) => (
                            <Link
                                key={`${exec.scheduleId}-${exec.time}`}
                                href={exec.href}
                                className="flex items-center justify-between rounded-md border px-3 py-2 text-sm transition-colors hover:bg-muted"
                            >
                                <div className="flex items-center gap-2">
                                    {exec.action === 'stop' ? (
                                        <PauseIcon className="h-3.5 w-3.5 text-amber-600" />
                                    ) : (
                                        <PlayIcon className="h-3.5 w-3.5 text-emerald-600" />
                                    )}
                                    <span className="truncate">{exec.scheduleName}</span>
                                </div>
                                <span className={cn('text-xs', exec.status === 'success' ? 'text-emerald-600' : 'text-red-600')}>
                                    ${exec.savings.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                                </span>
                            </Link>
                        ))}
                        {recent.length === 0 && <p className="text-muted-foreground py-2 text-center text-xs">No recent executions.</p>}
                    </div>
                </div>
            </CardContent>
        </Card>
    );
}
