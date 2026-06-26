"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PaginationBar } from "@/components/ui/pagination-bar";
import { RefreshCw, Play, Search, TrendingDown, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { SummaryCards } from "@/components/right-sizing/summary-cards";
import { RecommendationsTable } from "@/components/right-sizing/recommendations-table";
import { RecommendationDetailDialog } from "@/components/right-sizing/recommendation-detail-dialog";
import { PageHeader } from "@/components/shared/page-header";
import type { RightSizingRecommendation } from "@/lib/db/repositories/right-sizing/interface";
import { queryKeys } from "@/lib/queries/query-keys";
import {
    useRightSizingRecommendations,
    useRightSizingSummary,
    useRunRightSizingScan,
} from "@/lib/queries/right-sizing";

const PAGE_SIZE = 25;
const ALL = "all";

export default function RightSizingPage() {
    const queryClient = useQueryClient();

    const [page, setPage] = useState(1);
    const [search, setSearch] = useState("");
    const [resourceType, setResourceType] = useState(ALL);
    const [finding, setFinding] = useState(ALL);
    const [status, setStatus] = useState(ALL);
    const [sort, setSort] = useState("savings");

    const [selected, setSelected] = useState<RightSizingRecommendation | null>(null);
    const [dialogOpen, setDialogOpen] = useState(false);

    // Effective filters — also the query key.
    const filters = {
        page,
        limit: PAGE_SIZE,
        sort,
        search: search.trim() || undefined,
        resourceType: resourceType !== ALL ? resourceType : undefined,
        finding: finding !== ALL ? finding : undefined,
        status: status !== ALL ? status : undefined,
    };

    const recsQuery = useRightSizingRecommendations(filters);
    const summaryQuery = useRightSizingSummary();
    const scanMutation = useRunRightSizingScan();

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
            </div>

            <RecommendationsTable
                recommendations={recommendations}
                loading={loading}
                onRowClick={(r) => {
                    setSelected(r);
                    setDialogOpen(true);
                }}
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

            <RecommendationDetailDialog
                recommendation={selected}
                open={dialogOpen}
                onOpenChange={setDialogOpen}
                onUpdated={refresh}
                canReview={true}
            />
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
