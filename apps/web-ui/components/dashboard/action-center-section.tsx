'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { useDashboardActionCenter } from '@/lib/queries/dashboard';
import type { TimeRange } from '@/lib/dashboard-types';
import { AlertTriangleIcon, BotIcon, CloudOffIcon, ShieldAlertIcon } from 'lucide-react';
import Link from 'next/link';

export function ActionCenterSection({ range }: { range: TimeRange }) {
    const { data, isLoading, error } = useDashboardActionCenter(range);

    if (error) {
        return (
            <Card>
                <CardContent className="p-4 text-sm text-red-600">Failed to load action center: {error.message}</CardContent>
            </Card>
        );
    }

    if (isLoading) {
        return (
            <Card>
                <CardHeader>
                    <Skeleton className="h-5 w-32" />
                </CardHeader>
                <CardContent className="space-y-3">
                    {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
                </CardContent>
            </Card>
        );
    }

    const counts = data?.counts ?? { failingExecutions: 0, pendingApprovals: 0, accountsWithErrors: 0, criticalEvents: 0 };
    const total = counts.failingExecutions + counts.pendingApprovals + counts.accountsWithErrors + counts.criticalEvents;

    return (
        <Card className="flex flex-col">
            <CardHeader className="flex-row items-center justify-between pb-2">
                <CardTitle className="text-base font-semibold">Action Center</CardTitle>
                {total > 0 && (
                    <Badge variant="destructive" className="rounded-full px-2 py-0.5">
                        {total}
                    </Badge>
                )}
            </CardHeader>
            <CardContent className="flex-1 space-y-3">
                {total === 0 ? (
                    <p className="text-muted-foreground py-6 text-center text-sm">No items need attention.</p>
                ) : (
                    <>
                        {data?.failingExecutions.slice(0, 3).map((item) => (
                            <Link
                                key={`exec-${item.scheduleId}`}
                                href={item.href}
                                className="group flex items-start gap-3 rounded-md border border-transparent p-2 transition-colors hover:border-amber-200 hover:bg-amber-50 dark:hover:border-amber-900 dark:hover:bg-amber-950/20"
                            >
                                <AlertTriangleIcon className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                                <div className="min-w-0">
                                    <p className="truncate text-sm font-medium">
                                        {item.scheduleName} {item.action} failed
                                    </p>
                                    <p className="text-muted-foreground text-xs">
                                        {item.accountName} • {new Date(item.failedAt).toLocaleString()}
                                    </p>
                                </div>
                            </Link>
                        ))}
                        {data?.pendingAgentApprovals.slice(0, 2).map((item) => (
                            <Link
                                key={`approval-${item.runId}`}
                                href={item.href}
                                className="group flex items-start gap-3 rounded-md border border-transparent p-2 transition-colors hover:border-blue-200 hover:bg-blue-50 dark:hover:border-blue-900 dark:hover:bg-blue-950/20"
                            >
                                <BotIcon className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" />
                                <div className="min-w-0">
                                    <p className="truncate text-sm font-medium">
                                        Approval requested: {item.taskName}
                                    </p>
                                    <p className="text-muted-foreground text-xs">{new Date(item.requestedAt).toLocaleString()}</p>
                                </div>
                            </Link>
                        ))}
                        {data?.accountsWithErrors.slice(0, 2).map((item) => (
                            <Link
                                key={`acct-${item.accountId}`}
                                href={item.href}
                                className="group flex items-start gap-3 rounded-md border border-transparent p-2 transition-colors hover:border-red-200 hover:bg-red-50 dark:hover:border-red-900 dark:hover:bg-red-950/20"
                            >
                                <CloudOffIcon className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
                                <div className="min-w-0">
                                    <p className="truncate text-sm font-medium">{item.name}</p>
                                    <p className="text-muted-foreground text-xs">{item.error}</p>
                                </div>
                            </Link>
                        ))}
                        {data?.criticalEvents.slice(0, 2).map((item) => (
                            <Link
                                key={`evt-${item.eventType}-${item.timestamp}`}
                                href={item.href}
                                className="group flex items-start gap-3 rounded-md border border-transparent p-2 transition-colors hover:border-red-200 hover:bg-red-50 dark:hover:border-red-900 dark:hover:bg-red-950/20"
                            >
                                <ShieldAlertIcon className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
                                <div className="min-w-0">
                                    <p className="truncate text-sm font-medium">{item.eventType}</p>
                                    <p className="text-muted-foreground text-xs">{item.message}</p>
                                </div>
                            </Link>
                        ))}
                    </>
                )}
            </CardContent>
        </Card>
    );
}
