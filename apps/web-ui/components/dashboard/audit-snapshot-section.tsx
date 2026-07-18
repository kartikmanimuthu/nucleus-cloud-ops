'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { useDashboardAudit } from '@/lib/queries/dashboard';
import type { TimeRange } from '@/lib/dashboard-types';
import Link from 'next/link';

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'];
const SEVERITY_CLASSES: Record<string, string> = {
    critical: 'bg-red-100 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-400',
    high: 'bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-950/40 dark:text-orange-400',
    medium: 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-400',
    low: 'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-400',
};

export function AuditSnapshotSection({ range }: { range: TimeRange }) {
    const { data, isLoading, error } = useDashboardAudit(range);

    if (error) {
        return (
            <Card>
                <CardContent className="p-4 text-sm text-red-600">Failed to load audit snapshot: {error.message}</CardContent>
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
                    <Skeleton className="h-24 w-full" />
                    {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
                </CardContent>
            </Card>
        );
    }

    const summary = data?.summary;
    const findings = data?.openFindings ?? [];
    const types = data?.byType ?? [];
    const timeline = data?.timeline ?? [];
    const maxError = Math.max(...timeline.map((t) => t.error), 1);

    return (
        <Card className="flex flex-col">
            <CardHeader className="flex-row items-center justify-between pb-2">
                <CardTitle className="text-base font-semibold">Security & Audit</CardTitle>
                {(summary?.criticalCount ?? 0) > 0 && (
                    <Badge variant="destructive" className="rounded-full">
                        {summary?.criticalCount} critical
                    </Badge>
                )}
            </CardHeader>
            <CardContent className="flex-1 space-y-4">
                <div className="grid grid-cols-3 gap-3">
                    <div className="rounded-md border p-3">
                        <p className="text-muted-foreground text-xs uppercase">Total Events</p>
                        <p className="text-lg font-semibold">{(summary?.totalEvents ?? 0).toLocaleString()}</p>
                    </div>
                    <div className="rounded-md border p-3">
                        <p className="text-muted-foreground text-xs uppercase">Success Rate</p>
                        <p className="text-lg font-semibold">{summary?.successRate ?? 0}%</p>
                    </div>
                    <div className="rounded-md border p-3">
                        <p className="text-muted-foreground text-xs uppercase">High Severity</p>
                        <p className="text-lg font-semibold text-red-600">{(summary?.criticalCount ?? 0) + (summary?.highCount ?? 0)}</p>
                    </div>
                </div>

                {findings.length > 0 && (
                    <div className="space-y-1">
                        <p className="text-muted-foreground text-xs uppercase">Open Findings by Severity</p>
                        <div className="flex flex-wrap gap-2">
                            {SEVERITY_ORDER.map((severity) => {
                                const finding = findings.find((f) => f.severity === severity);
                                if (!finding || finding.count === 0) return null;
                                return (
                                    <Link key={severity} href={finding.href}>
                                        <Badge
                                            variant="outline"
                                            className={`cursor-pointer rounded-full px-2.5 py-0.5 capitalize ${SEVERITY_CLASSES[severity]}`}
                                        >
                                            {severity}: {finding.count}
                                        </Badge>
                                    </Link>
                                );
                            })}
                        </div>
                    </div>
                )}

                {timeline.length > 0 && (
                    <div className="space-y-1">
                        <p className="text-muted-foreground text-xs uppercase">Error Trend</p>
                        <div className="flex h-12 items-end gap-1">
                            {timeline.map((point, i) => {
                                const height = `${Math.max((point.error / maxError) * 100, 4)}%`;
                                return (
                                    <div
                                        key={i}
                                        className="flex-1 rounded-sm bg-red-500/30 hover:bg-red-500/50"
                                        style={{ height }}
                                        title={`${point.time}: ${point.error} errors`}
                                    />
                                );
                            })}
                        </div>
                    </div>
                )}

                {types.length > 0 && (
                    <div className="space-y-1">
                        <p className="text-muted-foreground text-xs uppercase">Top Event Types</p>
                        <div className="max-h-[120px] space-y-1 overflow-y-auto">
                            {types.slice(0, 5).map((t) => (
                                <div
                                    key={t.eventType}
                                    className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
                                >
                                    <span className="truncate">{t.eventType}</span>
                                    <span className="font-medium">{t.count}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
