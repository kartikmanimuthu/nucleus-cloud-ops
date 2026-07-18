'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { useDashboardAgentActivity } from '@/lib/queries/dashboard';
import type { TimeRange } from '@/lib/dashboard-types';
import { ClockIcon, WrenchIcon } from 'lucide-react';
import Link from 'next/link';

export function AgentActivitySection({ range }: { range: TimeRange }) {
    const { data, isLoading, error } = useDashboardAgentActivity(range);

    if (error) {
        return (
            <Card>
                <CardContent className="p-4 text-sm text-red-600">Failed to load agent activity: {error.message}</CardContent>
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
    const sources = data?.bySource ?? [];
    const tools = data?.topTools ?? [];
    const approvals = data?.approvalQueue ?? [];

    return (
        <Card className="flex flex-col">
            <CardHeader className="flex-row items-center justify-between pb-2">
                <CardTitle className="text-base font-semibold">Agent Activity</CardTitle>
                {(summary?.pendingApprovals ?? 0) > 0 && (
                    <Badge variant="secondary" className="rounded-full">
                        {summary?.pendingApprovals} pending
                    </Badge>
                )}
            </CardHeader>
            <CardContent className="flex-1 space-y-4">
                <div className="grid grid-cols-4 gap-2 text-center">
                    <div className="rounded-md border p-2">
                        <p className="text-lg font-semibold">{summary?.totalRuns ?? 0}</p>
                        <p className="text-muted-foreground text-[10px] uppercase">Runs</p>
                    </div>
                    <div className="rounded-md border p-2">
                        <p className="text-lg font-semibold">{summary?.successRate ?? 0}%</p>
                        <p className="text-muted-foreground text-[10px] uppercase">Success</p>
                    </div>
                    <div className="rounded-md border p-2">
                        <p className="text-lg font-semibold">{summary?.activeScheduledTasks ?? 0}</p>
                        <p className="text-muted-foreground text-[10px] uppercase">Scheduled</p>
                    </div>
                    <div className="rounded-md border p-2">
                        <p className="text-lg font-semibold">{summary?.avgDurationMs ?? 0}</p>
                        <p className="text-muted-foreground text-[10px] uppercase">Avg ms</p>
                    </div>
                </div>

                {sources.length > 0 && (
                    <div className="space-y-1">
                        <p className="text-muted-foreground text-xs uppercase">Runs by Source</p>
                        <div className="space-y-1">
                            {sources.map((s) => (
                                <div key={s.source} className="flex items-center gap-2 text-sm">
                                    <span className="w-16 truncate font-medium capitalize">{s.source}</span>
                                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                                        <div
                                            className="h-full rounded-full bg-blue-500"
                                            style={{
                                                width: `${Math.max((s.count / Math.max(...sources.map((x) => x.count))) * 100, 4)}%`,
                                            }}
                                        />
                                    </div>
                                    <span className="w-8 text-right text-xs">{s.count}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {tools.length > 0 && (
                    <div className="space-y-1">
                        <p className="text-muted-foreground text-xs uppercase">Top Tools</p>
                        <div className="flex flex-wrap gap-2">
                            {tools.slice(0, 6).map((tool) => (
                                <div
                                    key={tool.toolName}
                                    className="inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs"
                                >
                                    <WrenchIcon className="h-3 w-3" />
                                    <span className="truncate max-w-[120px]">{tool.toolName}</span>
                                    <span className="text-muted-foreground">{tool.count}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {approvals.length > 0 && (
                    <div className="space-y-1">
                        <p className="text-muted-foreground text-xs uppercase">Approval Queue</p>
                        <div className="max-h-[100px] space-y-1 overflow-y-auto">
                            {approvals.map((item) => (
                                <Link
                                    key={item.runId}
                                    href={item.href}
                                    className="flex items-center justify-between rounded-md border px-3 py-2 text-sm transition-colors hover:bg-muted"
                                >
                                    <div className="flex items-center gap-2">
                                        <ClockIcon className="h-3.5 w-3.5 text-amber-600" />
                                        <span className="truncate">{item.taskName}</span>
                                    </div>
                                    <span className="text-muted-foreground text-xs">{new Date(item.requestedAt).toLocaleTimeString()}</span>
                                </Link>
                            ))}
                        </div>
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
