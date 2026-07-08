"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PaginationBar } from "@/components/ui/pagination-bar";
import { RefreshCw, Play, Search, TrendingDown, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { SummaryCards } from "@/components/right-sizing/summary-cards";
import { RecommendationsTable } from "@/components/right-sizing/recommendations-table";
import { PageHeader } from "@/components/shared/page-header";
import type { RightSizingRecommendation } from "@/lib/db/repositories/right-sizing/interface";
import { queryKeys } from "@/lib/queries/query-keys";
import {
    useRightSizingRecommendations,
    useRightSizingSummary,
    useRunRightSizingScan,
} from "@/lib/queries/right-sizing";
import { useAccounts } from "@/lib/queries/accounts";

const PAGE_SIZE = 25;
const ALL = "all";

function RightSizingPageInner() {
    const queryClient = useQueryClient();
    const searchParams = useSearchParams();

    const [page, setPage] = useState(1);
    const [search, setSearch] = useState(() => searchParams.get("search") ?? "");
    const [resourceType, setResourceType] = useState(() => searchParams.get("resourceType") ?? ALL);
    const [finding, setFinding] = useState(() => searchParams.get("finding") ?? ALL);
    const [status, setStatus] = useState(() => searchParams.get("status") ?? ALL);
    const [account, setAccount] = useState(() => searchParams.get("account") ?? ALL);
    const [sort, setSort] = useState(() => searchParams.get("sort") ?? "savings");

    // Effective filters — also the query key.
    const filters = {
        page,
        limit: PAGE_SIZE,
        sort,
        search: search.trim() || undefined,
        resourceType: resourceType !== ALL ? resourceType : undefined,
        finding: finding !== ALL ? finding : undefined,
        status: status !== ALL ? status : undefined,
        accountId: account !== ALL ? account : undefined,
    };

    function buildDetailHref(r: RightSizingRecommendation): string {
        const params = new URLSearchParams();
        params.set("sort", sort);
        if (search.trim()) params.set("search", search.trim());
        if (resourceType !== ALL) params.set("resourceType", resourceType);
        if (finding !== ALL) params.set("finding", finding);
        if (status !== ALL) params.set("status", status);
        if (account !== ALL) params.set("account", account);
        return `/app/right-sizing/${r.id}?${params.toString()}`;
    }

    const recsQuery = useRightSizingRecommendations(filters);
    const summaryQuery = useRightSizingSummary();
    const scanMutation = useRunRightSizingScan();

    // Account filter options are the DISTINCT accounts that actually appear in the
    // recommendations (from the summary's server-side groupBy — not the current page,
    // and not the full connected-accounts list). The accounts list (high limit so it
    // isn't truncated by the default page size) is used only to enrich each ID with
    // its friendly name when one exists.
    const accountsQuery = useAccounts({ limit: 1000 });
    const accountNameById = new Map(
        (accountsQuery.data?.accounts ?? []).map((a) => [a.accountId, a.name]),
    );
    const accountOptions: [string, string][] = (summaryQuery.data?.accountIds ?? []).map((id) => {
        const name = accountNameById.get(id);
        return [id, name ? `${name} {${id}}` : id];
    });

    const hasActiveFilters =
        search.trim() !== "" ||
        account !== ALL ||
        resourceType !== ALL ||
        finding !== ALL ||
        status !== ALL;

    const resetFilters = () => {
        setPage(1);
        setSearch("");
        setAccount(ALL);
        setResourceType(ALL);
        setFinding(ALL);
        setStatus(ALL);
    };

    const recommendations = recsQuery.data?.data ?? [];
    const total = recsQuery.data?.total ?? 0;
    const summary = summaryQuery.data ?? null;
    const loading = recsQuery.isFetching || summaryQuery.isFetching;
    const scanning = scanMutation.isPending;

    const refresh = () => {
        queryClient.invalidateQueries({ queryKey: queryKeys.rightSizing.all });
    };

    async function runScan() {
        try {
            const result = await scanMutation.mutateAsync();
            toast.success(
                result.alreadyRunning
                    ? "A scan is already running"
                    : "Scan started — recommendations will update shortly",
            );
        } catch (e) {
            toast.error(e instanceof Error ? e.message : "Failed to start scan");
        }
    }

    return (
        <div className="space-y-6 p-6">
            <PageHeader
                icon={TrendingDown}
                title="Right Sizing"
                description="Cost-saving recommendations from real CloudWatch utilization."
                actions={
                    <>
                        <Button variant="outline" onClick={refresh} disabled={loading}>
                            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
                            <span className="ml-1">Refresh</span>
                        </Button>
                        <Button onClick={runScan} disabled={scanning}>
                            {scanning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                            <span className="ml-1">Run scan</span>
                        </Button>
                    </>
                }
            />

            <SummaryCards summary={summary} loading={loading} />

            <div className="flex flex-wrap items-center gap-2">
                <div className="relative">
                    <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input
                        placeholder="Search resource…"
                        value={search}
                        onChange={(e) => {
                            setPage(1);
                            setSearch(e.target.value);
                        }}
                        className="w-56 pl-8"
                    />
                </div>
                <FilterSelect value={account} onChange={(v) => { setPage(1); setAccount(v); }} placeholder="Account"
                    options={accountOptions} />
                <FilterSelect value={resourceType} onChange={(v) => { setPage(1); setResourceType(v); }} placeholder="Resource type"
                    options={[["ec2_instances", "EC2"], ["rds_db_instances", "RDS"], ["ec2_volumes", "EBS"], ["autoscaling_auto_scaling_groups", "ASG"]]} />
                <FilterSelect value={finding} onChange={(v) => { setPage(1); setFinding(v); }} placeholder="Finding"
                    options={[["over_provisioned", "Over-provisioned"], ["under_provisioned", "Under-provisioned"], ["idle", "Idle"], ["optimized", "Optimized"]]} />
                <FilterSelect value={status} onChange={(v) => { setPage(1); setStatus(v); }} placeholder="Status"
                    options={[["open", "Open"], ["approved", "Approved"], ["dismissed", "Dismissed"], ["snoozed", "Snoozed"]]} />
                <Select value={sort} onValueChange={(v) => { setPage(1); setSort(v); }}>
                    <SelectTrigger className="w-44"><SelectValue placeholder="Sort" /></SelectTrigger>
                    <SelectContent>
                        <SelectItem value="savings">Sort: Savings</SelectItem>
                        <SelectItem value="confidence">Sort: Confidence</SelectItem>
                        <SelectItem value="resource">Sort: Resource</SelectItem>
                    </SelectContent>
                </Select>
                {hasActiveFilters && (
                    <Button variant="ghost" size="sm" onClick={resetFilters}>
                        <X className="h-4 w-4" />
                        <span className="ml-1">Reset</span>
                    </Button>
                )}
            </div>

            <RecommendationsTable
                recommendations={recommendations}
                loading={loading}
                getHref={buildDetailHref}
            />

            {total > PAGE_SIZE && (
                <PaginationBar
                    currentPage={page}
                    totalItems={total}
                    pageSize={PAGE_SIZE}
                    onPageChange={setPage}
                    onPageSizeChange={() => { /* fixed page size for MVP */ }}
                    itemLabel="recommendations"
                />
            )}
        </div>
    );
}

function FilterSelect({
    value,
    onChange,
    placeholder,
    options,
}: {
    value: string;
    onChange: (v: string) => void;
    placeholder: string;
    options: [string, string][];
}) {
    return (
        <Select value={value} onValueChange={onChange}>
            <SelectTrigger className="w-44">
                <SelectValue placeholder={placeholder} />
            </SelectTrigger>
            <SelectContent>
                <SelectItem value="all">{placeholder}: All</SelectItem>
                {options.map(([v, label]) => (
                    <SelectItem key={v} value={v}>
                        {label}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}

export default function RightSizingPage() {
    return (
        <Suspense fallback={null}>
            <RightSizingPageInner />
        </Suspense>
    );
}
