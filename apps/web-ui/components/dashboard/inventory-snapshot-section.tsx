'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useDashboardInventory } from '@/lib/queries/dashboard';
import { ServerIcon, DatabaseIcon, ContainerIcon, BoxIcon, LayersIcon } from 'lucide-react';
import Link from 'next/link';
import { cn } from '@/lib/utils';

const TYPE_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
    EC2: ServerIcon,
    RDS: DatabaseIcon,
    ECS: ContainerIcon,
    ASG: LayersIcon,
    DocumentDB: DatabaseIcon,
};

const STATUS_COLORS: Record<string, string> = {
    Running: 'bg-emerald-500',
    Stopped: 'bg-amber-500',
    Terminated: 'bg-slate-400',
    Pending: 'bg-blue-500',
    Other: 'bg-slate-300',
};

export function InventorySnapshotSection() {
    const { data, isLoading, error } = useDashboardInventory();

    if (error) {
        return (
            <Card>
                <CardContent className="p-4 text-sm text-red-600">Failed to load inventory: {error.message}</CardContent>
            </Card>
        );
    }

    if (isLoading) {
        return (
            <Card>
                <CardHeader>
                    <Skeleton className="h-5 w-36" />
                </CardHeader>
                <CardContent className="space-y-3">
                    <Skeleton className="h-24 w-full" />
                    {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
                </CardContent>
            </Card>
        );
    }

    const summary = data?.summary;
    const types = data?.byType ?? [];
    const accounts = data?.byAccount ?? [];
    const statuses = data?.statusBreakdown ?? [];
    const total = summary?.totalResources ?? 0;

    return (
        <Card className="flex flex-col">
            <CardHeader className="pb-2">
                <CardTitle className="text-base font-semibold">Inventory Snapshot</CardTitle>
            </CardHeader>
            <CardContent className="flex-1 space-y-4">
                <div className="grid grid-cols-3 gap-3">
                    <div className="rounded-md border p-3">
                        <p className="text-muted-foreground text-xs uppercase">Total Resources</p>
                        <p className="text-lg font-semibold">{total.toLocaleString()}</p>
                    </div>
                    <div className="rounded-md border p-3">
                        <p className="text-muted-foreground text-xs uppercase">Accounts Synced</p>
                        <p className="text-lg font-semibold">{summary?.accountsSynced ?? 0}</p>
                    </div>
                    <div className="rounded-md border p-3">
                        <p className="text-muted-foreground text-xs uppercase">Last Scan</p>
                        <p className="text-sm font-semibold">
                            {summary?.lastScanAt
                                ? new Date(summary.lastScanAt).toLocaleDateString()
                                : 'Never'}
                        </p>
                    </div>
                </div>

                {statuses.length > 0 && (
                    <div className="flex items-center gap-2">
                        {statuses.map((s) => {
                            const color = STATUS_COLORS[s.status] || 'bg-slate-300';
                            const width = total > 0 ? `${Math.max((s.count / total) * 100, 2)}%` : '0%';
                            return (
                                <div
                                    key={s.status}
                                    className={cn('h-2 rounded-full first:rounded-l-md last:rounded-r-md', color)}
                                    style={{ width }}
                                    title={`${s.status}: ${s.count}`}
                                />
                            );
                        })}
                    </div>
                )}

                {types.length > 0 && (
                    <div className="space-y-1">
                        <p className="text-muted-foreground text-xs uppercase">By Resource Type</p>
                        <div className="grid grid-cols-2 gap-2">
                            {types.slice(0, 6).map((t) => {
                                const Icon = TYPE_ICONS[t.resourceType] || BoxIcon;
                                return (
                                    <div key={t.resourceType} className="flex items-center gap-2 rounded-md border p-2">
                                        <Icon className="h-4 w-4 text-muted-foreground" />
                                        <div className="min-w-0">
                                            <p className="truncate text-xs font-medium">{t.resourceType}</p>
                                            <p className="text-lg font-semibold">{t.count}</p>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}

                {accounts.length > 0 && (
                    <div className="space-y-1">
                        <p className="text-muted-foreground text-xs uppercase">Top Accounts</p>
                        <div className="max-h-[120px] space-y-1 overflow-y-auto">
                            {accounts.slice(0, 5).map((account) => (
                                <Link
                                    key={account.accountId}
                                    href={account.href}
                                    className="flex items-center justify-between rounded-md border px-3 py-2 text-sm transition-colors hover:bg-muted"
                                >
                                    <span className="truncate">{account.accountName}</span>
                                    <span className="font-medium">{account.total.toLocaleString()}</span>
                                </Link>
                            ))}
                        </div>
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
