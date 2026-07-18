'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Progress } from '@/components/ui/progress';
import { useDashboardCoverage } from '@/lib/queries/dashboard';
import type { SyncStatus } from '@/lib/dashboard-types';
import { CheckCircleIcon, AlertCircleIcon, XCircleIcon, HelpCircleIcon } from 'lucide-react';
import Link from 'next/link';
import { cn } from '@/lib/utils';

function statusIcon(status: SyncStatus) {
    switch (status) {
        case 'connected':
            return <CheckCircleIcon className="h-4 w-4 text-emerald-600" />;
        case 'stale':
            return <AlertCircleIcon className="h-4 w-4 text-amber-600" />;
        case 'disconnected':
            return <XCircleIcon className="h-4 w-4 text-red-600" />;
        case 'never':
        default:
            return <HelpCircleIcon className="h-4 w-4 text-slate-400" />;
    }
}

function statusClass(status: SyncStatus) {
    switch (status) {
        case 'connected':
            return 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-400 dark:border-emerald-900';
        case 'stale':
            return 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-400 dark:border-amber-900';
        case 'disconnected':
            return 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/30 dark:text-red-400 dark:border-red-900';
        case 'never':
        default:
            return 'bg-slate-50 text-slate-600 border-slate-200 dark:bg-slate-900 dark:text-slate-400 dark:border-slate-800';
    }
}

export function CoverageSection() {
    const { data, isLoading, error } = useDashboardCoverage();

    if (error) {
        return (
            <Card>
                <CardContent className="p-4 text-sm text-red-600">Failed to load coverage: {error.message}</CardContent>
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

    const total = data?.totalAccounts ?? 0;
    const connected = data?.connectedAccounts ?? 0;
    const healthyPercent = total > 0 ? Math.round((connected / total) * 100) : 0;

    return (
        <Card className="flex flex-col">
            <CardHeader className="pb-2">
                <CardTitle className="text-base font-semibold">Account Coverage</CardTitle>
            </CardHeader>
            <CardContent className="flex-1 space-y-4">
                <div className="space-y-2">
                    <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">Healthy accounts</span>
                        <span className="font-medium">{connected}/{total}</span>
                    </div>
                    <Progress value={healthyPercent} className="h-2" />
                </div>

                <div className="grid grid-cols-4 gap-2 text-center">
                    {(['connected', 'stale', 'disconnected', 'never'] as SyncStatus[]).map((status) => {
                        const count =
                            status === 'connected'
                                ? data?.connectedAccounts
                                : status === 'stale'
                                  ? data?.staleAccounts
                                  : status === 'disconnected'
                                    ? data?.disconnectedAccounts
                                    : data?.neverSyncedAccounts;
                        return (
                            <div key={status} className="rounded-md border py-2">
                                <p className="text-lg font-semibold">{count}</p>
                                <p className="text-muted-foreground text-[10px] uppercase">{status}</p>
                            </div>
                        );
                    })}
                </div>

                <div className="max-h-[180px] space-y-1 overflow-y-auto">
                    {data?.accounts.slice(0, 6).map((account) => (
                        <Link
                            key={account.id}
                            href={account.href}
                            className={cn(
                                'flex items-center justify-between rounded-md border px-3 py-2 text-sm transition-colors hover:opacity-90',
                                statusClass(account.status)
                            )}
                        >
                            <div className="flex items-center gap-2">
                                {statusIcon(account.status)}
                                <span className="truncate font-medium">{account.name}</span>
                            </div>
                            <span className="text-xs opacity-80">{account.status}</span>
                        </Link>
                    ))}
                </div>
            </CardContent>
        </Card>
    );
}
