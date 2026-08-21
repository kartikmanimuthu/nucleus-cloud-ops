"use client";

import { Suspense, useState, use } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import { PageHeader } from "@/components/shared/page-header";
import { AccountRegion } from "@/components/shared/account-region";
import { ScalingEventsTable } from "@/components/scaling-audit/scaling-events-table";
import { ScalingEventDetailsDialog } from "@/components/scaling-audit/scaling-event-details-dialog";
import { SCOPE_LABELS, formatIstDate, formatIstDateTime } from "@/components/scaling-audit/shared";
import { MetricBarTile } from "@/components/shared/metric-bar-tile";
import type { ScalingEvent, ScalingScope } from "@/lib/db/repositories/scaling-audit/interface";
import { useScalingEvents, useScalingResources } from "@/lib/queries/scaling-audit";
import { useCapacityResourceDetail } from "@/lib/queries/capacity-planning";
import type { CapacityResourceType } from "@/lib/db/repositories/capacity-planning/interface";
import { useAccounts } from "@/lib/queries/accounts";

const PAGE_SIZE = 25;

/**
 * Per-resource scaling history: /scale-sentinel/asg/<asg-name>
 *                               /scale-sentinel/ecs/<service-name>
 *
 * The URL carries the friendly NAME, not the underlying resourceId, because an
 * Application Auto Scaling id is "service/<cluster>/<service>" and would need
 * escaping in a path segment. Names are not guaranteed unique — the same service
 * name can exist in two clusters or two accounts — so this resolves by name and
 * shows a chooser when more than one resource matches, rather than silently
 * picking one and quietly showing the wrong history.
 */
function ResourceDetailInner({ scope, name }: { scope: ScalingScope; name: string }) {
    const router = useRouter();
    const [tab, setTab] = useState<"overview" | "scaling">("overview");
    const [page, setPage] = useState(1);
    const [selectedEvent, setSelectedEvent] = useState<ScalingEvent | null>(null);
    // ECS/ASG are the only scopes where 'scheduled' and 'target_tracking' are
    // meaningful scaling types (see ScalingType in workers/.../types.ts) — the
    // other scopes are CloudTrail-only capture (direct_api/manual/etc.), so
    // splitting their single event list into these three buckets would just
    // dump everything into "Other".
    const isEcsOrAsg = scope === "ecs" || scope === "asg";
    const [scalingTypeTab, setScalingTypeTab] = useState<"scheduled" | "target_tracking" | "other">("scheduled");

    // Resolve the name to concrete resources. 'all' so a resource whose only
    // events are suppressed evaluations is still reachable from a pasted link.
    const resourceQuery = useScalingResources({ page: 1, limit: 100, search: name, effect: "all" });
    const matches = (resourceQuery.data?.data ?? []).filter(
        (r) => r.scope === scope && r.displayName === name
    );

    const accountsQuery = useAccounts({ limit: 1000 });
    const accountNameById = new Map(
        (accountsQuery.data?.accounts ?? []).map((a) => [a.accountId, a.name])
    );

    const only = matches.length === 1 ? matches[0] : null;

    // Scope the event list to the exact resource once unambiguous. Gated to the
    // "Scaling & Capacity" tab — no reason to fetch the full history while
    // looking at Overview.
    const eventsQuery = useScalingEvents(
        {
            page,
            limit: PAGE_SIZE,
            scope,
            search: only?.resourceId ?? name,
            effect: "all",
            ...(isEcsOrAsg
                ? scalingTypeTab === "other"
                    ? { excludeScalingTypes: ["scheduled", "target_tracking"] }
                    : { scalingType: scalingTypeTab }
                : {}),
        },
        { enabled: tab === "scaling" && !!only }
    );

    // Capacity Planning only tracks ecs/asg — the other scopes have no
    // installed-vs-utilised data to show, so the fetch is skipped entirely.
    const capacityResourceType: CapacityResourceType | undefined = scope === "ecs" || scope === "asg" ? scope : undefined;
    const capacityQuery = useCapacityResourceDetail(
        only?.resourceId ?? "",
        { resourceType: capacityResourceType, accountId: only?.accountId, region: only?.region },
        { enabled: tab === "scaling" && !!only && !!capacityResourceType }
    );

    const back = (
        <Button variant="ghost" size="sm" onClick={() => router.push("/app/cloud-operations/scale-sentinel")}>
            <ArrowLeft className="h-4 w-4" />
            <span className="ml-1">Back to Scale Sentinel</span>
        </Button>
    );

    if (resourceQuery.isLoading) return <Skeleton className="m-6 h-72" />;

    if (matches.length === 0) {
        return (
            <div className="space-y-4 p-6">
                {back}
                <div className="rounded-md border p-10 text-center text-sm text-muted-foreground">
                    No scaling records found for {SCOPE_LABELS[scope] ?? scope} <span className="font-medium">{name}</span>.
                </div>
            </div>
        );
    }

    // More than one resource shares this name — make the user choose rather than guess.
    if (!only) {
        return (
            <div className="space-y-4 p-6">
                {back}
                <div className="rounded-md border p-6">
                    <p className="mb-4 text-sm">
                        <span className="font-medium">{name}</span> matches {matches.length} resources. Select one:
                    </p>
                    <div className="space-y-2">
                        {matches.map((m) => (
                            <button
                                key={m.resourceId + m.accountId + m.region}
                                onClick={() => router.push(`/app/cloud-operations/scale-sentinel/${scope}/${encodeURIComponent(name)}?resource=${encodeURIComponent(m.resourceId)}`)}
                                className="flex w-full items-center justify-between rounded-md border p-3 text-left hover:bg-muted/50"
                            >
                                <AccountRegion
                                    accountId={m.accountId}
                                    accountName={accountNameById.get(m.accountId)}
                                    region={m.region}
                                />
                                <span className="text-xs text-muted-foreground">
                                    {m.clusterName ?? m.resourceId} · {m.eventCount} events
                                </span>
                            </button>
                        ))}
                    </div>
                </div>
            </div>
        );
    }

    const events = eventsQuery.data?.data ?? [];
    const capacity = capacityQuery.data;

    return (
        <div className="space-y-6 p-6">
            {back}
            <PageHeader
                icon={ShieldCheck}
                title={only.displayName}
                description={`${SCOPE_LABELS[only.scope] ?? only.scope}${only.clusterName ? ` · ${only.clusterName}` : ""} — ${only.eventCount} scaling event(s) on record`}
            />

            <Tabs value={tab} onValueChange={(v) => setTab(v as "overview" | "scaling")}>
                <TabsList>
                    <TabsTrigger value="overview">Overview</TabsTrigger>
                    <TabsTrigger value="scaling">Scaling &amp; Capacity</TabsTrigger>
                </TabsList>

                <TabsContent value="overview" className="mt-4 space-y-4">
                    <div className="rounded-md border p-4">
                        <AccountRegion
                            layout="inline"
                            accountId={only.accountId}
                            accountName={accountNameById.get(only.accountId)}
                            region={only.region}
                        />
                    </div>
                    <div className="grid grid-cols-2 gap-4 rounded-md border p-4 text-sm md:grid-cols-3">
                        <div>
                            <div className="text-xs text-muted-foreground">Resource ID</div>
                            <div className="break-all font-mono text-xs">{only.resourceId}</div>
                        </div>
                        <div>
                            <div className="text-xs text-muted-foreground">Type</div>
                            <div>
                                <Badge variant="secondary">{SCOPE_LABELS[only.scope] ?? only.scope}</Badge>
                            </div>
                        </div>
                        {only.clusterName && (
                            <div>
                                <div className="text-xs text-muted-foreground">Cluster</div>
                                <div>{only.clusterName}</div>
                            </div>
                        )}
                        <div>
                            <div className="text-xs text-muted-foreground">First seen (IST)</div>
                            <div>{formatIstDate(only.firstEventAt)}</div>
                        </div>
                        <div>
                            <div className="text-xs text-muted-foreground">Last event (IST)</div>
                            <div>{formatIstDateTime(only.lastEventAt)}</div>
                        </div>
                        <div>
                            <div className="text-xs text-muted-foreground">Scaling events on record</div>
                            <div>{only.eventCount}</div>
                        </div>
                    </div>
                </TabsContent>

                <TabsContent value="scaling" className="mt-4 space-y-6">
                    <div className="space-y-3">
                        <h3 className="text-sm font-medium">Capacity</h3>
                        {capacityQuery.isFetching ? (
                            <Skeleton className="h-24 w-full" />
                        ) : capacity ? (
                            <div className="space-y-3">
                                <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
                                    {capacity.installedVcpu != null && <span>{capacity.installedVcpu} vCPU installed</span>}
                                    {capacity.installedMemGiB != null && <span>{capacity.installedMemGiB.toFixed(2)} GB RAM installed</span>}
                                    <span>{capacity.breachCount} breach(es) &gt;70%</span>
                                </div>
                                <div className="grid gap-3 sm:grid-cols-2">
                                    {capacity.metrics.cpu && <MetricBarTile label="CPU %" isPercent signal={capacity.metrics.cpu} />}
                                    {capacity.metrics.memory && <MetricBarTile label="Memory %" isPercent signal={capacity.metrics.memory} />}
                                </div>
                            </div>
                        ) : (
                            <p className="text-sm text-muted-foreground">No capacity utilization data recorded for this resource yet.</p>
                        )}
                    </div>

                    <div className="space-y-3">
                        <h3 className="text-sm font-medium">Scaling events</h3>
                        {isEcsOrAsg && (
                            <Tabs
                                value={scalingTypeTab}
                                onValueChange={(v) => { setPage(1); setScalingTypeTab(v as typeof scalingTypeTab); }}
                            >
                                <TabsList>
                                    <TabsTrigger value="scheduled">Scheduled</TabsTrigger>
                                    <TabsTrigger value="target_tracking">Target Tracking</TabsTrigger>
                                    <TabsTrigger value="other">Other</TabsTrigger>
                                </TabsList>
                            </Tabs>
                        )}
                        <ScalingEventsTable
                            events={events}
                            loading={eventsQuery.isFetching}
                            onSelect={setSelectedEvent}
                            accountNameById={accountNameById}
                        />
                        {eventsQuery.data && eventsQuery.data.total > PAGE_SIZE && (
                            <div className="flex items-center justify-between text-sm">
                                <span className="text-muted-foreground">
                                    Page {page} of {Math.ceil(eventsQuery.data.total / PAGE_SIZE)}
                                </span>
                                <div className="flex gap-2">
                                    <Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
                                        Previous
                                    </Button>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        disabled={page >= Math.ceil(eventsQuery.data.total / PAGE_SIZE)}
                                        onClick={() => setPage((p) => p + 1)}
                                    >
                                        Next
                                    </Button>
                                </div>
                            </div>
                        )}
                    </div>
                </TabsContent>
            </Tabs>

            <ScalingEventDetailsDialog
                event={selectedEvent}
                open={!!selectedEvent}
                onOpenChange={(open) => { if (!open) setSelectedEvent(null); }}
            />
        </div>
    );
}

export default function ScaleSentinelResourcePage({
    params,
}: {
    params: Promise<{ scope: string; name: string }>;
}) {
    const { scope, name } = use(params);
    const decoded = decodeURIComponent(name);
    const SCOPES: ScalingScope[] = ["asg", "ecs", "rds", "msk", "elasticache", "docdb"];
    const validScope: ScalingScope = SCOPES.includes(scope as ScalingScope) ? (scope as ScalingScope) : "ecs";

    return (
        <Suspense fallback={<Skeleton className="m-6 h-72" />}>
            <ResourceDetailInner scope={validScope} name={decoded} />
        </Suspense>
    );
}
