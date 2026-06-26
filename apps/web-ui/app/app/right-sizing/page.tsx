"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PaginationBar } from "@/components/ui/pagination-bar";
import { RefreshCw, Play, Search, TrendingDown, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { SummaryCards } from "@/components/right-sizing/summary-cards";
import { RecommendationsTable } from "@/components/right-sizing/recommendations-table";
import { RecommendationDetailDialog } from "@/components/right-sizing/recommendation-detail-dialog";
import type { RightSizingRecommendation, RightSizingSummary } from "@/lib/db/repositories/right-sizing/interface";

const PAGE_SIZE = 25;
const ALL = "all";

export default function RightSizingPage() {
    const [recommendations, setRecommendations] = useState<RightSizingRecommendation[]>([]);
    const [summary, setSummary] = useState<RightSizingSummary | null>(null);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [loading, setLoading] = useState(true);
    const [scanning, setScanning] = useState(false);

    const [search, setSearch] = useState("");
    const [resourceType, setResourceType] = useState(ALL);
    const [finding, setFinding] = useState(ALL);
    const [status, setStatus] = useState(ALL);
    const [sort, setSort] = useState("savings");

    const [selected, setSelected] = useState<RightSizingRecommendation | null>(null);
    const [dialogOpen, setDialogOpen] = useState(false);

    const fetchData = useCallback(async () => {
        setLoading(true);
        try {
            const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE), sort });
            if (search.trim()) params.set("search", search.trim());
            if (resourceType !== ALL) params.set("resourceType", resourceType);
            if (finding !== ALL) params.set("finding", finding);
            if (status !== ALL) params.set("status", status);

            const [recRes, sumRes] = await Promise.all([
                fetch(`/api/right-sizing/recommendations?${params.toString()}`),
                fetch(`/api/right-sizing/summary`),
            ]);
            const recJson = await recRes.json();
            const sumJson = await sumRes.json();
            if (recJson.success) {
                setRecommendations(recJson.data);
                setTotal(recJson.meta?.total ?? 0);
            }
            if (sumJson.success) setSummary(sumJson.data);
        } catch {
            toast.error("Failed to load right-sizing data");
        } finally {
            setLoading(false);
        }
    }, [page, sort, search, resourceType, finding, status]);

    useEffect(() => {
        void fetchData();
    }, [fetchData]);

    async function runScan() {
        setScanning(true);
        try {
            const res = await fetch(`/api/right-sizing/runs`, { method: "POST" });
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json.error || "Failed to start scan");
            toast.success(json.alreadyRunning ? "A scan is already running" : "Scan started — recommendations will update shortly");
        } catch (e) {
            toast.error(e instanceof Error ? e.message : "Failed to start scan");
        } finally {
            setScanning(false);
        }
    }

    return (
        <div className="space-y-6 p-6">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="flex items-center gap-2 text-2xl font-bold">
                        <TrendingDown className="h-6 w-6" /> Right Sizing
                    </h1>
                    <p className="text-sm text-muted-foreground">
                        Cost-saving recommendations from real CloudWatch utilization.
                    </p>
                </div>
                <div className="flex gap-2">
                    <Button variant="outline" onClick={() => void fetchData()} disabled={loading}>
                        <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
                        <span className="ml-1">Refresh</span>
                    </Button>
                    <Button onClick={runScan} disabled={scanning}>
                        {scanning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                        <span className="ml-1">Run scan</span>
                    </Button>
                </div>
            </div>

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
                onUpdated={fetchData}
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
