"use client";

import { Suspense, useState } from "react";
import { useRouter } from "next/navigation";
import { useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { GatedButton } from "@/components/rbac/gated";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PaginationBar } from "@/components/ui/pagination-bar";
import { RefreshCw, Play, Search, ShieldCheck, Loader2, X, Download } from "lucide-react";
import { toast } from "sonner";
import { SummaryCards } from "@/components/scaling-audit/summary-cards";
import { ScalingResourcesTable } from "@/components/scaling-audit/scaling-resources-table";
import { CoverageBanner } from "@/components/scaling-audit/coverage-banner";
import { FilterSelect } from "@/components/scaling-audit/filter-select";
import { ComingSoonPanel } from "@/components/scaling-audit/coming-soon-panel";
import { NetworkAvailabilityReport } from "@/components/scaling-audit/network-availability-report";
import { PageHeader } from "@/components/shared/page-header";
import { SCALING_TYPE_LABELS } from "@/components/scaling-audit/shared";
import { queryKeys } from "@/lib/queries/query-keys";
import {
    useScalingResources,
    useScalingAuditSummary,
    useScalingAuditCoverage,
    useRunScalingAuditScan,
    useExportScalingAudit,
} from "@/lib/queries/scaling-audit";
import { useRunCapacityPlanningScan } from "@/lib/queries/capacity-planning";
import { useNetworkAvailabilityReport } from "@/lib/queries/network-links";
import { useAccounts } from "@/lib/queries/accounts";

const PAGE_SIZE = 25;
const ALL = "all";
const DEFAULT_NETWORK_WINDOW_DAYS = 30;

// Resource types shown as tabs. Each 'live' scope has a dedicated poller under
// apps/workers/src/jobs/scaling-audit/ (Application Auto Scaling + ASG
// DescribeScalingActivities for ecs/asg; RDS Events + CloudTrail for rds;
// CloudTrail for msk/elasticache/docdb) and is wired end-to-end: ScalingScope
// (apps/workers/.../types.ts), /api/scaling-audit/* (scope: string), and the
// generic ScalingResourcesTable + detail page here. 'network' is different in
// KIND, not just another scope: it's not a resource-browsing list, it's a
// fixed Direct Connect + VPN availability/bandwidth compliance summary (see
// NetworkAvailabilityReport) fed by its own /api/network-links/report
// endpoint — rendered as a special case below rather than through
// ScalingResourcesTable. OpenSearch and Redshift have no backend capture yet
// — kept as ComingSoonPanel until a poller exists.
const RESOURCE_TABS = [
    { value: "ecs", label: "ECS Events", live: true },
    { value: "asg", label: "ASG Events", live: true },
    { value: "rds", label: "RDS Scale", live: true },
    { value: "elasticache", label: "ElastiCache", live: true },
    { value: "msk", label: "MSK", live: true },
    { value: "docdb", label: "DocDB", live: true },
    { value: "network", label: "Direct Connect & VPN", live: true },
    { value: "opensearch", label: "OpenSearch", live: false },
    { value: "redshift", label: "Redshift", live: false },
] as const;
type ResourceTab = (typeof RESOURCE_TABS)[number]["value"];

/** ISO (YYYY-MM-DD) start/end for a trailing N-day window, used as the
 *  network report's default range when the user hasn't picked explicit
 *  dates — that report has no sensible "all time" default the way an event
 *  list does, since an availability percentage needs a defined window. */
function defaultNetworkWindow(days: number): { start: string; end: string } {
    const end = new Date();
    const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
    return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

function ScalingAuditPageInner() {
    const queryClient = useQueryClient();
    const searchParams = useSearchParams();

    const [page, setPage] = useState(1);
    const [tab, setTab] = useState<ResourceTab>(() => {
        const fromUrl = searchParams.get("tab");
        return (RESOURCE_TABS.find((t) => t.value === fromUrl)?.value ?? "ecs") as ResourceTab;
    });
    const [search, setSearch] = useState(() => searchParams.get("search") ?? "");
    const [account, setAccount] = useState(() => searchParams.get("account") ?? ALL);
    const [source, setSource] = useState(() => searchParams.get("source") ?? ALL);
    const [scalingType, setScalingType] = useState(() => searchParams.get("scalingType") ?? ALL);
    const [dateFrom, setDateFrom] = useState(() => searchParams.get("dateFrom") ?? "");
    const [dateTo, setDateTo] = useState(() => searchParams.get("dateTo") ?? "");
    // Defaults to real capacity changes. AWS emits a policy-evaluation row every
    // time it decides NOT to scale, which outnumbers actual scaling roughly 10:1 —
    // showing those by default buries the events anyone is actually looking for.
    const [effect, setEffect] = useState<"capacity_changes" | "all">(
        () => (searchParams.get("effect") === "all" ? "all" : "capacity_changes")
    );

    const isLive = RESOURCE_TABS.find((t) => t.value === tab)?.live ?? false;
    const isNetworkTab = tab === "network";
    // Search/source/scalingType are ECS/ASG/RDS-etc-flavored filters that don't
    // apply to the fixed-row network report — only account + date range do.
    const showGenericFilters = isLive && !isNetworkTab;

    const networkWindow = defaultNetworkWindow(DEFAULT_NETWORK_WINDOW_DAYS);
    // One expression, two consumers (on-screen report + export) — they must
    // never describe different windows.
    const networkRange = { dateFrom: dateFrom || networkWindow.start, dateTo: dateTo || networkWindow.end };
    const networkReportQuery = useNetworkAvailabilityReport(
        { accountId: account !== ALL ? account : undefined, ...networkRange },
        { enabled: isNetworkTab }
    );

    const filters = {
        page,
        limit: PAGE_SIZE,
        search: search.trim() || undefined,
        accountId: account !== ALL ? account : undefined,
        scope: isLive && !isNetworkTab ? tab : undefined,
        source: source !== ALL ? source : undefined,
        scalingType: scalingType !== ALL ? scalingType : undefined,
        effect,
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
    };

    const router = useRouter();
    const resourcesQuery = useScalingResources(filters, { enabled: isLive && !isNetworkTab });
    const summaryQuery = useScalingAuditSummary();
    const coverageQuery = useScalingAuditCoverage();
    const scanMutation = useRunScalingAuditScan();
    const capacityScanMutation = useRunCapacityPlanningScan();
    const exportMutation = useExportScalingAudit();

    const accountsQuery = useAccounts({ limit: 1000 });
    const accountNameById = new Map((accountsQuery.data?.accounts ?? []).map((a) => [a.accountId, a.name]));
    const accountOptions: [string, string][] = (summaryQuery.data?.facets.accountIds ?? []).map((id) => {
        const name = accountNameById.get(id);
        return [id, name ? `${name} {${id}}` : id];
    });

    const hasActiveFilters =
        search.trim() !== "" || account !== ALL || source !== ALL || scalingType !== ALL ||
        effect !== "capacity_changes" || dateFrom !== "" || dateTo !== "";

    const resetFilters = () => {
        setPage(1);
        setSearch("");
        setAccount(ALL);
        setSource(ALL);
        setScalingType(ALL);
        // Back to the default view, not to the unfiltered firehose.
        setEffect("capacity_changes");
        setDateFrom("");
        setDateTo("");
    };

    const total = resourcesQuery.data?.total ?? 0;
    const summary = summaryQuery.data ?? null;
    const gaps = coverageQuery.data ?? [];
    const loading = resourcesQuery.isFetching || summaryQuery.isFetching;
    const scanning = scanMutation.isPending || capacityScanMutation.isPending;

    const refresh = () => {
        queryClient.invalidateQueries({ queryKey: queryKeys.scalingAudit.all });
        queryClient.invalidateQueries({ queryKey: queryKeys.capacityPlanning.all });
    };

    async function runScan() {
        try {
            const [auditResult, capacityResult] = await Promise.all([
                scanMutation.mutateAsync(),
                capacityScanMutation.mutateAsync(),
            ]);
            toast.success(
                auditResult.alreadyRunning && capacityResult.alreadyRunning
                    ? "A scan is already running"
                    : "Scan started — events will update shortly"
            );
        } catch (e) {
            toast.error(e instanceof Error ? e.message : "Failed to start scan");
        }
    }

    async function runExport(format: "xlsx" | "pdf") {
        // The network tab's report is a different shape (fixed availability/
        // bandwidth rows, not an event list) and needs a defined window —
        // `filters` carries event-list-only state (search/source/scalingType/
        // effect) and a scope of undefined, which would export every scope's
        // events instead of the network report.
        const exportFilters = isNetworkTab
            ? { scope: "network" as const, accountId: account !== ALL ? account : undefined, ...networkRange }
            : filters;
        try {
            await exportMutation.mutateAsync({ format, ...exportFilters });
            toast.success(`Export downloaded (${format.toUpperCase()})`);
        } catch (e) {
            toast.error(e instanceof Error ? e.message : "Failed to export");
        }
    }

    return (
        <div className="space-y-6 p-6">
            <PageHeader
                icon={ShieldCheck}
                title="Scale Sentinel"
                description="SEBI compliance record of ECS + ASG scaling activity — scheduled and dynamic, with cause and full history."
                actions={
                    <>
                        <Button variant="outline" onClick={refresh} disabled={loading}>
                            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
                            <span className="ml-1">Refresh</span>
                        </Button>
                        <Button variant="outline" onClick={() => runExport("xlsx")} disabled={exportMutation.isPending}>
                            <Download className="h-4 w-4" />
                            <span className="ml-1">Export Excel</span>
                        </Button>
                        <Button variant="outline" onClick={() => runExport("pdf")} disabled={exportMutation.isPending}>
                            <Download className="h-4 w-4" />
                            <span className="ml-1">Export PDF</span>
                        </Button>
                        {/*
                          * The only write on this page: POST /api/scaling-audit/runs
                          * enforces authorize('update', 'ScalingAudit'). Refresh and
                          * both exports are deliberately left ungated — every other
                          * scaling-audit route, /export included, is `read`, the same
                          * permission that already loaded this page, so gating them
                          * would disable controls that cannot 403.
                          */}
                        <GatedButton
                            action="update"
                            subject="ScalingAudit"
                            onClick={runScan}
                            disabled={scanning}
                        >
                            {scanning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                            <span className="ml-1">Run scan</span>
                        </GatedButton>
                    </>
                }
            />

            <CoverageBanner gaps={gaps} />

            <SummaryCards summary={summary} loading={loading} />

            <Tabs value={tab} onValueChange={(v) => { setPage(1); setTab(v as ResourceTab); }}>
                <TabsList className="flex-wrap">
                    {RESOURCE_TABS.map((t) => (
                        <TabsTrigger key={t.value} value={t.value}>{t.label}</TabsTrigger>
                    ))}
                </TabsList>

                {isLive && (
                    <div className="mt-4 flex flex-wrap items-center gap-2">
                        {showGenericFilters && (
                            <>
                                <div className="relative">
                                    <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                                    <Input
                                        placeholder="Search resource / cause…"
                                        value={search}
                                        onChange={(e) => {
                                            setPage(1);
                                            setSearch(e.target.value);
                                        }}
                                        className="w-56 pl-8"
                                    />
                                </div>
                                <Select value={effect} onValueChange={(v) => { setPage(1); setEffect(v as "capacity_changes" | "all"); }}>
                                    <SelectTrigger className="w-52" aria-label="Event set">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="capacity_changes">Capacity changes only</SelectItem>
                                        <SelectItem value="all">Complete record</SelectItem>
                                    </SelectContent>
                                </Select>
                            </>
                        )}
                        <FilterSelect value={account} onChange={(v) => { setPage(1); setAccount(v); }} placeholder="Account" options={accountOptions} />
                        {showGenericFilters && (
                            <>
                                <FilterSelect value={source} onChange={(v) => { setPage(1); setSource(v); }} placeholder="Source"
                                    options={[["aws_api", "AWS API"], ["platform", "Platform"], ["cloudtrail", "CloudTrail"]]} />
                                <FilterSelect value={scalingType} onChange={(v) => { setPage(1); setScalingType(v); }} placeholder="Type"
                                    options={Object.entries(SCALING_TYPE_LABELS) as [string, string][]} />
                            </>
                        )}
                        <Input
                            type="date"
                            value={dateFrom}
                            onChange={(e) => { setPage(1); setDateFrom(e.target.value); }}
                            className="w-40"
                            aria-label="From date"
                        />
                        <Input
                            type="date"
                            value={dateTo}
                            onChange={(e) => { setPage(1); setDateTo(e.target.value); }}
                            className="w-40"
                            aria-label="To date"
                        />
                        {hasActiveFilters && (
                            <Button variant="ghost" size="sm" onClick={resetFilters}>
                                <X className="h-4 w-4" />
                                <span className="ml-1">Reset</span>
                            </Button>
                        )}
                    </div>
                )}

                {RESOURCE_TABS.map((t) => (
                    <TabsContent key={t.value} value={t.value} className="mt-4">
                        {t.value === "network" ? (
                            <NetworkAvailabilityReport
                                rows={networkReportQuery.data ?? []}
                                loading={networkReportQuery.isFetching}
                                error={networkReportQuery.isError ? (networkReportQuery.error instanceof Error ? networkReportQuery.error.message : "Unknown error") : null}
                            />
                        ) : t.live ? (
                            <ScalingResourcesTable
                                resources={resourcesQuery.data?.data ?? []}
                                loading={resourcesQuery.isFetching}
                                accountNameById={accountNameById}
                                onSelect={(r) =>
                                    router.push(
                                        `/app/cloud-operations/scale-sentinel/${r.scope}/${encodeURIComponent(r.displayName)}`
                                    )
                                }
                            />
                        ) : (
                            <ComingSoonPanel resourceLabel={t.label} />
                        )}
                    </TabsContent>
                ))}
            </Tabs>

            {isLive && !isNetworkTab && total > PAGE_SIZE && (
                <PaginationBar
                    currentPage={page}
                    totalItems={total}
                    pageSize={PAGE_SIZE}
                    onPageChange={setPage}
                    onPageSizeChange={() => { /* fixed page size for MVP */ }}
                    itemLabel="resources"
                />
            )}
        </div>
    );
}

export default function ScalingAuditPage() {
    return (
        <Suspense fallback={null}>
            <ScalingAuditPageInner />
        </Suspense>
    );
}
