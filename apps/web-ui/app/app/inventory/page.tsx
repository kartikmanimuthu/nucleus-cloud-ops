"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/shared/page-header";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RefreshCw, Download, Search, Filter, Database, Server, Loader2, Check, ChevronsUpDown, Sparkles, X, SlidersHorizontal, Settings } from "lucide-react";
import { PaginationBar } from "@/components/ui/pagination-bar";
import { toast } from "sonner";
import { ClientAccountService } from "@/lib/client-account-service";
import { UIAccount } from "@/lib/types";
import { ResourceDetailDialog, ResourceDetailProps } from "@/components/inventory/resource-detail-dialog";
import { AskAIDialog } from "@/components/inventory/ask-ai-dialog";
import { ResourceGrid } from "@/components/inventory/resource-grid";
import { SyncAccountsDialog } from "@/components/inventory/sync-accounts-dialog";
import { cn } from "@/lib/utils";
import { formatDate, formatTime } from "@/lib/date-utils";
import { useTenant } from "@/lib/tenant-context";
import { RESOURCE_TYPE_OPTIONS, REGION_OPTIONS } from "@/lib/resource-types";
import { getColumnsForType } from "@/lib/inventory/column-registry";
import type { Resource } from "@/lib/inventory/types";

interface SyncStatus {
    accountId: string;
    accountName: string;
    lastSyncedAt?: string;
    lastSyncStatus?: string;
    lastSyncResourceCount?: number;
}

interface InventoryStatus {
    totalResources: number;
    accountsSynced: number;
    lastSyncedAt: string | null;
    latestSync: {
        scanId: string;
        totalResources: number;
        accountsSynced: number;
        syncedAt: string;
        status: string;
    } | null;
    accounts: SyncStatus[];
    accountCount: number;
}

const PAGE_SIZES = [10, 20, 50, 100, 200, 500];

export default function InventoryPage() {
    const router = useRouter();
    const { timezone } = useTenant();
    const [resources, setResources] = useState<Resource[]>([]);
    const [loading, setLoading] = useState(true);
    const [exporting, setExporting] = useState(false);
    const [inventoryStatus, setInventoryStatus] = useState<InventoryStatus | null>(null);

    // Accounts for filter
    const [accounts, setAccounts] = useState<UIAccount[]>([]);
    const [openAccountCombobox, setOpenAccountCombobox] = useState(false);
    const [accountSearch, setAccountSearch] = useState("");
    const [openResourceTypeCombobox, setOpenResourceTypeCombobox] = useState(false);
    const [resourceTypeSearch, setResourceTypeSearch] = useState("");

    // Resource detail dialog
    const [selectedResource, setSelectedResource] = useState<ResourceDetailProps | null>(null);
    const [dialogOpen, setDialogOpen] = useState(false);

    // Ask AI Dialog
    const [askAIOpen, setAskAIOpen] = useState(false);

    // Sync Accounts Dialog
    const [syncDialogOpen, setSyncDialogOpen] = useState(false);

    // Applied filters (what the API actually uses)
    const [searchTerm, setSearchTerm] = useState("");
    const [resourceType, setResourceType] = useState("all");
    const [region, setRegion] = useState("all");
    const [selectedAccounts, setSelectedAccounts] = useState<string[]>([]);

    // Draft filters (what the user is editing before clicking Apply)
    const [draftSearch, setDraftSearch] = useState("");
    const [draftResourceType, setDraftResourceType] = useState("all");
    const [draftRegion, setDraftRegion] = useState("all");
    const [draftAccounts, setDraftAccounts] = useState<string[]>([]);

    // Pagination
    const [currentPage, setCurrentPage] = useState(1);
    const [totalItems, setTotalItems] = useState(0);
    const [pageSize, setPageSize] = useState(50);

    const hasPendingChanges =
        draftSearch !== searchTerm ||
        draftResourceType !== resourceType ||
        draftRegion !== region ||
        JSON.stringify(draftAccounts) !== JSON.stringify(selectedAccounts);

    const handleApplyFilters = () => {
        setSearchTerm(draftSearch);
        setResourceType(draftResourceType);
        setRegion(draftRegion);
        setSelectedAccounts(draftAccounts);
        setCurrentPage(1);
    };

    const handleClearFilters = () => {
        setDraftSearch("");
        setDraftResourceType("all");
        setDraftRegion("all");
        setDraftAccounts([]);
        setSearchTerm("");
        setResourceType("all");
        setRegion("all");
        setSelectedAccounts([]);
        setCurrentPage(1);
    };

    // Dynamic columns — recomputed whenever the resourceType filter changes
    const columns = useMemo(
        () => getColumnsForType(resourceType === "all" ? "_default" : resourceType),
        [resourceType]
    );

    // Keep a ref to fetchResources so the debounce effect can always call the latest version
    // without listing fetchResources as a dependency (which would cause it to fire on page size changes too)
    const fetchResourcesRef = useRef<() => Promise<void>>(async () => {});

    const fetchResources = useCallback(async () => {
        setLoading(true);
        try {
            const params = new URLSearchParams();
            params.set("limit", pageSize.toString());
            params.set("page", currentPage.toString());
            if (resourceType !== "all") params.set("resourceType", resourceType);
            if (region !== "all") params.set("region", region);
            if (selectedAccounts.length > 0) params.set("accountIds", selectedAccounts.join(","));
            if (searchTerm) params.set("search", searchTerm);

            const response = await fetch(`/api/inventory/resources?${params.toString()}`);
            const data = await response.json();

            if (response.ok) {
                setResources(data.resources || []);
                setTotalItems(data.total || 0);
            } else {
                toast.error(data.error || "Failed to fetch resources");
            }
        } catch {
            toast.error("Failed to fetch resources");
        } finally {
            setLoading(false);
        }
    }, [resourceType, region, selectedAccounts, searchTerm, pageSize, currentPage]);

    // Keep ref in sync so the debounce effect always calls the latest version
    useEffect(() => {
        fetchResourcesRef.current = fetchResources;
    }, [fetchResources]);

    const fetchSyncStatus = async () => {
        try {
            const response = await fetch("/api/inventory/status");
            const data = await response.json();
            if (response.ok) {
                setInventoryStatus(data);
            }
        } catch (error) {
            console.error("Failed to fetch sync status:", error);
        }
    };

    const handleExport = async () => {
        setExporting(true);
        try {
            const body: Record<string, string | string[]> = {};
            if (resourceType !== "all") body.resourceType = resourceType;
            if (region !== "all") body.region = region;
            if (selectedAccounts.length === 1) body.accountId = selectedAccounts[0];
            else if (selectedAccounts.length > 1) body.accountIds = selectedAccounts;

            const response = await fetch("/api/inventory/export", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            const data = await response.json();

            if (response.ok && data.downloadUrl) {
                window.location.href = data.downloadUrl;
                if (data.capped) {
                    toast.warning(`Exported ${data.resourceCount} resources (capped). ${data.warning}`);
                } else {
                    toast.success(`Exported ${data.resourceCount} resources`);
                }
            } else {
                toast.error(data.error || "Failed to export");
            }
        } catch {
            toast.error("Failed to export resources");
        } finally {
            setExporting(false);
        }
    };

    useEffect(() => {
        fetchResources();
        fetchSyncStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Re-fetch when applied filters change (triggered by Apply button)
    useEffect(() => {
        fetchResourcesRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [searchTerm, resourceType, region, selectedAccounts, currentPage, pageSize]);

    useEffect(() => {
        const fetchAccounts = async () => {
            try {
                const result = await ClientAccountService.getAccounts({ statusFilter: "active", connectionFilter: "connected", limit: 1000 });
                setAccounts(result.accounts);
            } catch (error) {
                console.error("Failed to fetch accounts:", error);
            }
        };
        fetchAccounts();
    }, []);

    const handleRowClick = (resource: Resource) => {
        setSelectedResource({
            resourceId: resource.resourceId,
            resourceArn: resource.resourceArn,
            resourceType: resource.resourceType,
            name: resource.name,
            region: resource.region,
            state: resource.state,
            accountId: resource.accountId,
            accountName: resource.accountName,
            lastDiscoveredAt: resource.lastDiscoveredAt,
            tags: resource.tags,
            metadata: resource.metadata as Record<string, unknown>,
        });
        setDialogOpen(true);
    };

    const totalResources = inventoryStatus?.totalResources || 0;
    const accountsSynced = inventoryStatus?.accountsSynced || 0;
    const lastSyncedAt = inventoryStatus?.lastSyncedAt;

    return (
        <>
            <div className="space-y-6">
                {/* Header */}
                <PageHeader
                    icon={Database}
                    title="Inventory Discovery"
                    description="Auto-discovered AWS resources across all connected accounts"
                    actions={
                        <>
                            <Button variant="ghost" size="icon" onClick={() => router.push("/app/inventory/settings")} title="Inventory Settings">
                                <Settings className="h-5 w-5" />
                            </Button>
                            <Button variant="outline" onClick={() => { fetchResourcesRef.current(); fetchSyncStatus(); }} disabled={loading}>
                                {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <RefreshCw className="h-4 w-4 mr-2" />}
                                Refresh
                            </Button>
                            <Button variant="secondary" onClick={() => setAskAIOpen(true)}>
                                <Sparkles className="h-4 w-4 mr-2 text-indigo-500" />
                                Ask AI
                            </Button>
                            <Button variant="outline" onClick={handleExport} disabled={exporting}>
                                {exporting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Download className="h-4 w-4 mr-2" />}
                                Export
                            </Button>
                            <Button onClick={() => setSyncDialogOpen(true)}>
                                <RefreshCw className="h-4 w-4 mr-2" />
                                Sync Now
                            </Button>
                        </>
                    }
                />

                {/* Stats Cards */}
                <div className="grid gap-4 md:grid-cols-4">
                    <Card>
                        <CardHeader className="flex flex-row items-center justify-between pb-2">
                            <CardTitle className="text-sm font-medium">Total Resources</CardTitle>
                            <Database className="h-4 w-4 text-muted-foreground" />
                        </CardHeader>
                        <CardContent>
                            <div className="text-2xl font-bold">{totalResources.toLocaleString()}</div>
                            <p className="text-xs text-muted-foreground">Across all accounts</p>
                        </CardContent>
                    </Card>
                    <Card>
                        <CardHeader className="flex flex-row items-center justify-between pb-2">
                            <CardTitle className="text-sm font-medium">Accounts Synced</CardTitle>
                            <Server className="h-4 w-4 text-muted-foreground" />
                        </CardHeader>
                        <CardContent>
                            <div className="text-2xl font-bold">{accountsSynced}</div>
                            <p className="text-xs text-muted-foreground">of {inventoryStatus?.accountCount || 0} total</p>
                        </CardContent>
                    </Card>
                    <Card>
                        <CardHeader className="flex flex-row items-center justify-between pb-2">
                            <CardTitle className="text-sm font-medium">Last Sync</CardTitle>
                            <RefreshCw className="h-4 w-4 text-muted-foreground" />
                        </CardHeader>
                        <CardContent>
                            <div className="text-2xl font-bold">
                                {lastSyncedAt ? formatDate(lastSyncedAt, 'shortDate', timezone) : "Never"}
                            </div>
                            <p className="text-xs text-muted-foreground">
                                {lastSyncedAt ? formatTime(lastSyncedAt, timezone) : "Click Sync Now"}
                            </p>
                        </CardContent>
                    </Card>
                    <Card>
                        <CardHeader className="flex flex-row items-center justify-between pb-2">
                            <CardTitle className="text-sm font-medium">Current View</CardTitle>
                            <Filter className="h-4 w-4 text-muted-foreground" />
                        </CardHeader>
                        <CardContent>
                            <div className="text-2xl font-bold">{totalItems.toLocaleString()}</div>
                            <p className="text-xs text-muted-foreground">Matching filters</p>
                        </CardContent>
                    </Card>
                </div>

                {/* Filters */}
                <Card>
                    <CardContent className="pt-6">
                        <div className="flex flex-wrap gap-4 items-center">
                            <div className="flex-1 min-w-[200px]">
                                <div className="relative">
                                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                                    <Input
                                        placeholder="Search by name or ID..."
                                        value={draftSearch}
                                        onChange={(e) => setDraftSearch(e.target.value)}
                                        onKeyDown={(e) => e.key === "Enter" && handleApplyFilters()}
                                        className="pl-9"
                                    />
                                </div>
                            </div>
                            {/* Resource Type Filter — single-select with search */}
                            <Popover open={openResourceTypeCombobox} onOpenChange={setOpenResourceTypeCombobox}>
                                <PopoverTrigger asChild>
                                    <Button
                                        variant="outline"
                                        role="combobox"
                                        aria-expanded={openResourceTypeCombobox}
                                        className={cn(
                                            "w-[200px] justify-between",
                                            draftResourceType === "all" && "text-muted-foreground"
                                        )}
                                    >
                                        <span className="truncate">
                                            {draftResourceType === "all"
                                                ? "All Types"
                                                : (RESOURCE_TYPE_OPTIONS.find(o => o.value === draftResourceType)?.label ?? draftResourceType)}
                                        </span>
                                        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                                    </Button>
                                </PopoverTrigger>
                                <PopoverContent className="w-[280px] p-0" align="start">
                                    <div className="flex items-center border-b px-3">
                                        <Search className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
                                        <input
                                            className="flex h-10 w-full bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground"
                                            placeholder="Search types..."
                                            value={resourceTypeSearch}
                                            onChange={e => setResourceTypeSearch(e.target.value)}
                                        />
                                        {resourceTypeSearch && (
                                            <button onClick={() => setResourceTypeSearch("")} className="text-muted-foreground hover:text-foreground">
                                                <X className="h-4 w-4" />
                                            </button>
                                        )}
                                    </div>
                                    <div className="max-h-[280px] overflow-y-auto p-1">
                                        {RESOURCE_TYPE_OPTIONS.filter(opt =>
                                            !resourceTypeSearch || opt.label.toLowerCase().includes(resourceTypeSearch.toLowerCase())
                                        ).map(opt => (
                                            <button
                                                key={opt.value}
                                                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
                                                onClick={() => {
                                                    setDraftResourceType(opt.value);
                                                    setOpenResourceTypeCombobox(false);
                                                    setResourceTypeSearch("");
                                                }}
                                            >
                                                <Check className={cn("h-4 w-4 shrink-0", draftResourceType === opt.value ? "opacity-100" : "opacity-0")} />
                                                {opt.label}
                                            </button>
                                        ))}
                                    </div>
                                </PopoverContent>
                            </Popover>
                            <Select value={draftRegion} onValueChange={setDraftRegion}>
                                <SelectTrigger className="w-[180px]">
                                    <SelectValue placeholder="Region" />
                                </SelectTrigger>
                                <SelectContent>
                                    {REGION_OPTIONS.map((r) => (
                                        <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>

                            {/* Account Filter — multi-select with search + Select All */}
                            <Popover open={openAccountCombobox} onOpenChange={setOpenAccountCombobox}>
                                <PopoverTrigger asChild>
                                    <Button
                                        variant="outline"
                                        role="combobox"
                                        aria-expanded={openAccountCombobox}
                                        className={cn(
                                            "w-[220px] justify-between",
                                            draftAccounts.length === 0 && "text-muted-foreground"
                                        )}
                                    >
                                        <span className="truncate">
                                            {draftAccounts.length === 0
                                                ? "All Accounts"
                                                : draftAccounts.length === 1
                                                    ? (accounts.find(a => a.accountId === draftAccounts[0])?.name || draftAccounts[0])
                                                    : `${draftAccounts.length} accounts`}
                                        </span>
                                        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                                    </Button>
                                </PopoverTrigger>
                                <PopoverContent className="w-[320px] p-0" align="start">
                                    <div className="flex items-center border-b px-3">
                                        <Search className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
                                        <input
                                            className="flex h-10 w-full bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground"
                                            placeholder="Search accounts..."
                                            value={accountSearch}
                                            onChange={e => setAccountSearch(e.target.value)}
                                        />
                                        {accountSearch && (
                                            <button onClick={() => setAccountSearch("")} className="text-muted-foreground hover:text-foreground">
                                                <X className="h-4 w-4" />
                                            </button>
                                        )}
                                    </div>
                                    <div className="max-h-[280px] overflow-y-auto p-1">
                                        {/* Select All — operates on filtered list */}
                                        {(() => {
                                            const filtered = accounts.filter(a =>
                                                !accountSearch ||
                                                a.name.toLowerCase().includes(accountSearch.toLowerCase()) ||
                                                a.accountId.includes(accountSearch)
                                            );
                                            const filteredIds = filtered.map(a => a.accountId);
                                            const allFilteredSelected = filteredIds.length > 0 && filteredIds.every(id => draftAccounts.includes(id));
                                            const someFilteredSelected = filteredIds.some(id => draftAccounts.includes(id));
                                            return (
                                                <>
                                                <button
                                                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
                                                    onClick={() => {
                                                        if (allFilteredSelected) {
                                                            setDraftAccounts(prev => prev.filter(id => !filteredIds.includes(id)));
                                                        } else {
                                                            setDraftAccounts(prev => [...new Set([...prev, ...filteredIds])]);
                                                        }
                                                    }}
                                                >
                                                    <div className={cn(
                                                        "flex h-4 w-4 items-center justify-center rounded border",
                                                        allFilteredSelected
                                                            ? "bg-primary border-primary text-primary-foreground"
                                                            : someFilteredSelected
                                                                ? "bg-primary/30 border-primary"
                                                                : "border-input"
                                                    )}>
                                                        {allFilteredSelected && <Check className="h-3 w-3" />}
                                                        {!allFilteredSelected && someFilteredSelected && (
                                                            <span className="h-0.5 w-2 bg-primary block" />
                                                        )}
                                                    </div>
                                                    <span className="font-medium">Select All</span>
                                                    <span className="ml-auto text-xs text-muted-foreground">{filtered.length}</span>
                                                </button>
                                                <div className="my-1 border-t" />
                                                {/* Account list */}
                                                {filtered.map(account => {
                                                    const checked = draftAccounts.includes(account.accountId);
                                                    return (
                                                        <button
                                                            key={account.accountId}
                                                            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
                                                            onClick={() => {
                                                                setDraftAccounts(prev =>
                                                                    checked
                                                                        ? prev.filter(id => id !== account.accountId)
                                                                        : [...prev, account.accountId]
                                                                );
                                                            }}
                                                        >
                                                            <div className={cn(
                                                                "flex h-4 w-4 items-center justify-center rounded border",
                                                                checked ? "bg-primary border-primary text-primary-foreground" : "border-input"
                                                            )}>
                                                                {checked && <Check className="h-3 w-3" />}
                                                            </div>
                                                            <div className="flex flex-col items-start min-w-0">
                                                                <span className="truncate max-w-[200px]">{account.name}</span>
                                                                <span className="text-xs text-muted-foreground">{account.accountId}</span>
                                                            </div>
                                                        </button>
                                                    );
                                                })}
                                                {filtered.length === 0 && (
                                                    <p className="py-6 text-center text-sm text-muted-foreground">No accounts found.</p>
                                                )}
                                                </>
                                            );
                                        })()}
                                    </div>
                                    {draftAccounts.length > 0 && (
                                        <div className="border-t p-2">
                                            <Button variant="ghost" size="sm" className="w-full" onClick={() => setDraftAccounts([])}>
                                                Clear selection
                                            </Button>
                                        </div>
                                    )}
                                </PopoverContent>
                            </Popover>

                            {/* Apply + Clear */}
                            <Button onClick={handleApplyFilters} disabled={!hasPendingChanges} size="sm">
                                <SlidersHorizontal className="h-4 w-4 mr-1" />
                                Apply
                            </Button>
                            {(searchTerm || resourceType !== "all" || region !== "all" || selectedAccounts.length > 0) && (
                                <Button variant="ghost" size="sm" onClick={handleClearFilters}>
                                    <X className="h-4 w-4 mr-1" />
                                    Clear
                                </Button>
                            )}
                        </div>
                    </CardContent>
                </Card>

                {/* Resources Grid */}
                <Card>
                    <CardHeader>
                        <CardTitle>Discovered Resources</CardTitle>
                        <CardDescription>
                            {loading
                                ? "Loading..."
                                : `Showing ${resources.length} resources${resourceType !== "all" ? ` · ${resourceType}` : ""}`}
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        {loading ? (
                            <div className="flex items-center justify-center py-12">
                                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                            </div>
                        ) : resources.length === 0 ? (
                            <div className="text-center py-12">
                                <Database className="mx-auto h-12 w-12 text-muted-foreground" />
                                <h3 className="mt-4 text-lg font-medium">No resources found</h3>
                                <p className="text-muted-foreground">
                                    {searchTerm || resourceType !== "all" || region !== "all"
                                        ? "Try adjusting your filters"
                                        : "Click 'Sync Now' to discover resources"}
                                </p>
                            </div>
                        ) : (
                            <>
                                <ResourceGrid
                                    columns={columns}
                                    data={resources}
                                    onRowClick={handleRowClick}
                                />
                            </>
                        )}
                    </CardContent>
                </Card>

                {/* Pagination */}
                {!loading && (
                    <PaginationBar
                        currentPage={currentPage}
                        totalItems={totalItems}
                        pageSize={pageSize}
                        onPageChange={setCurrentPage}
                        onPageSizeChange={(size) => { setPageSize(size); setCurrentPage(1); }}
                        pageSizeOptions={PAGE_SIZES}
                        itemLabel="resources"
                    />
                )}
            </div>

            {/* Resource Detail Dialog */}
            <ResourceDetailDialog
                resource={selectedResource}
                open={dialogOpen}
                onOpenChange={setDialogOpen}
            />

            {/* Ask AI Dialog — passes active grid filters for contextual responses */}
            <AskAIDialog
                open={askAIOpen}
                onOpenChange={setAskAIOpen}
                filters={{
                    accountId: selectedAccounts.length === 1 ? selectedAccounts[0] : undefined,
                    region: region !== "all" ? region : undefined,
                    resourceType: resourceType !== "all" ? resourceType : undefined,
                }}
            />

            {/* Sync Accounts Dialog */}
            <SyncAccountsDialog
                open={syncDialogOpen}
                onOpenChange={setSyncDialogOpen}
                accounts={accounts}
                onSyncStarted={(count) => {
                    toast.success(
                        count === 1
                            ? "Sync started for 1 account. It may take a few minutes to complete."
                            : `Sync started for ${count} accounts. It may take a few minutes to complete.`,
                        { duration: 5000 }
                    );
                    fetchSyncStatus();
                }}
            />
        </>
    );
}
