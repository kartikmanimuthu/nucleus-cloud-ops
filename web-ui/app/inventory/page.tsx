"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RefreshCw, Download, Search, Filter, ChevronLeft, ChevronRight, Database, Server, Loader2, Check, ChevronsUpDown, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import { ClientAccountService } from "@/lib/client-account-service";
import { UIAccount } from "@/lib/types";
import { ResourceDetailDialog, ResourceDetailProps } from "@/components/inventory/resource-detail-dialog";
import { AskAIDialog } from "@/components/inventory/ask-ai-dialog";
import { ResourceGrid } from "@/components/inventory/resource-grid";
import { cn } from "@/lib/utils";
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
    const [resources, setResources] = useState<Resource[]>([]);
    const [loading, setLoading] = useState(true);
    const [syncing, setSyncing] = useState(false);
    const [exporting, setExporting] = useState(false);
    const [inventoryStatus, setInventoryStatus] = useState<InventoryStatus | null>(null);

    // Accounts for filter
    const [accounts, setAccounts] = useState<UIAccount[]>([]);
    const [openAccountCombobox, setOpenAccountCombobox] = useState(false);

    // Resource detail dialog
    const [selectedResource, setSelectedResource] = useState<ResourceDetailProps | null>(null);
    const [dialogOpen, setDialogOpen] = useState(false);

    // Ask AI Dialog
    const [askAIOpen, setAskAIOpen] = useState(false);

    // Filters
    const [searchTerm, setSearchTerm] = useState("");
    const [resourceType, setResourceType] = useState("all");
    const [region, setRegion] = useState("all");
    const [accountId, setAccountId] = useState("all");

    // Pagination
    const [cursor, setCursor] = useState<string | undefined>();
    const [hasMore, setHasMore] = useState(false);
    const [pageSize, setPageSize] = useState(50);

    // Dynamic columns — recomputed whenever the resourceType filter changes
    const columns = useMemo(
        () => getColumnsForType(resourceType === "all" ? "_default" : resourceType),
        [resourceType]
    );

    const fetchResources = useCallback(async (newCursor?: string) => {
        setLoading(true);
        try {
            const params = new URLSearchParams();
            params.set("limit", pageSize.toString());
            if (resourceType !== "all") params.set("resourceType", resourceType);
            if (region !== "all") params.set("region", region);
            if (accountId !== "all") params.set("accountId", accountId);
            if (searchTerm) params.set("search", searchTerm);
            if (newCursor) params.set("cursor", newCursor);

            const response = await fetch(`/api/inventory/resources?${params.toString()}`);
            const data = await response.json();

            if (response.ok) {
                setResources(data.resources || []);
                setHasMore(data.hasMore || false);
                setCursor(data.nextCursor);
            } else {
                toast.error(data.error || "Failed to fetch resources");
            }
        } catch {
            toast.error("Failed to fetch resources");
        } finally {
            setLoading(false);
        }
    }, [resourceType, region, accountId, searchTerm, pageSize]);

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

    const handleSync = async () => {
        setSyncing(true);
        try {
            const response = await fetch("/api/inventory/sync", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({}),
            });
            const data = await response.json();

            if (response.ok) {
                toast.success("Execution started in the background. It may take a few minutes to complete.", {
                    description: `Scan ID: ${data.scanId?.substring(0, 8) || "N/A"}`,
                    duration: 5000,
                });
            } else {
                toast.error(data.error || "Failed to trigger sync");
            }
        } catch {
            toast.error("Failed to trigger sync");
        } finally {
            setSyncing(false);
        }
    };

    const handleExport = async () => {
        setExporting(true);
        try {
            const body: Record<string, string> = {};
            if (resourceType !== "all") body.resourceType = resourceType;
            if (region !== "all") body.region = region;

            const response = await fetch("/api/inventory/export", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            const data = await response.json();

            if (response.ok && data.downloadUrl) {
                window.open(data.downloadUrl, "_blank");
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
    }, [fetchResources]);

    useEffect(() => {
        const timer = setTimeout(() => {
            setCursor(undefined);
            fetchResources();
        }, 300);
        return () => clearTimeout(timer);
    }, [searchTerm, resourceType, region, accountId, fetchResources]);

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
                <div className="flex items-center justify-between">
                    <div>
                        <h1 className="text-3xl font-bold tracking-tight">Inventory Discovery</h1>
                        <p className="text-muted-foreground">
                            Auto-discovered AWS resources across all connected accounts
                        </p>
                    </div>
                    <div className="flex items-center gap-2">
                        <Button variant="secondary" onClick={() => setAskAIOpen(true)}>
                            <Sparkles className="h-4 w-4 mr-2 text-indigo-500" />
                            Ask AI
                        </Button>
                        <Button variant="outline" onClick={handleExport} disabled={exporting}>
                            {exporting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Download className="h-4 w-4 mr-2" />}
                            Export
                        </Button>
                        <Button onClick={handleSync} disabled={syncing}>
                            {syncing ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <RefreshCw className="h-4 w-4 mr-2" />}
                            Sync Now
                        </Button>
                    </div>
                </div>

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
                                {lastSyncedAt ? new Date(lastSyncedAt).toLocaleDateString() : "Never"}
                            </div>
                            <p className="text-xs text-muted-foreground">
                                {lastSyncedAt ? new Date(lastSyncedAt).toLocaleTimeString() : "Click Sync Now"}
                            </p>
                        </CardContent>
                    </Card>
                    <Card>
                        <CardHeader className="flex flex-row items-center justify-between pb-2">
                            <CardTitle className="text-sm font-medium">Current View</CardTitle>
                            <Filter className="h-4 w-4 text-muted-foreground" />
                        </CardHeader>
                        <CardContent>
                            <div className="text-2xl font-bold">{resources.length}</div>
                            <p className="text-xs text-muted-foreground">Matching filters</p>
                        </CardContent>
                    </Card>
                </div>

                {/* Filters */}
                <Card>
                    <CardContent className="pt-6">
                        <div className="flex flex-wrap gap-4">
                            <div className="flex-1 min-w-[200px]">
                                <div className="relative">
                                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                                    <Input
                                        placeholder="Search by name or ID..."
                                        value={searchTerm}
                                        onChange={(e) => setSearchTerm(e.target.value)}
                                        className="pl-9"
                                    />
                                </div>
                            </div>
                            <Select value={resourceType} onValueChange={setResourceType}>
                                <SelectTrigger className="w-[180px]">
                                    <SelectValue placeholder="Resource Type" />
                                </SelectTrigger>
                                <SelectContent>
                                    {RESOURCE_TYPE_OPTIONS.map((type) => (
                                        <SelectItem key={type.value} value={type.value}>{type.label}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            <Select value={region} onValueChange={setRegion}>
                                <SelectTrigger className="w-[180px]">
                                    <SelectValue placeholder="Region" />
                                </SelectTrigger>
                                <SelectContent>
                                    {REGION_OPTIONS.map((r) => (
                                        <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>

                            {/* Account Filter with Search */}
                            <Popover open={openAccountCombobox} onOpenChange={setOpenAccountCombobox}>
                                <PopoverTrigger asChild>
                                    <Button
                                        variant="outline"
                                        role="combobox"
                                        aria-expanded={openAccountCombobox}
                                        className={cn(
                                            "w-[220px] justify-between",
                                            accountId === "all" && "text-muted-foreground"
                                        )}
                                    >
                                        {accountId === "all"
                                            ? "All Accounts"
                                            : accounts.find((a) => a.accountId === accountId)?.name || accountId}
                                        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                                    </Button>
                                </PopoverTrigger>
                                <PopoverContent className="w-[300px] p-0">
                                    <Command>
                                        <CommandInput placeholder="Search account..." />
                                        <CommandList>
                                            <CommandEmpty>No account found.</CommandEmpty>
                                            <CommandGroup>
                                                <CommandItem
                                                    value="all"
                                                    onSelect={() => {
                                                        setAccountId("all");
                                                        setOpenAccountCombobox(false);
                                                    }}
                                                >
                                                    <Check className={cn("mr-2 h-4 w-4", accountId === "all" ? "opacity-100" : "opacity-0")} />
                                                    All Accounts
                                                </CommandItem>
                                                {accounts.map((account) => (
                                                    <CommandItem
                                                        value={`${account.name} ${account.accountId}`}
                                                        key={account.accountId}
                                                        onSelect={() => {
                                                            setAccountId(account.accountId);
                                                            setOpenAccountCombobox(false);
                                                        }}
                                                    >
                                                        <Check className={cn("mr-2 h-4 w-4", account.accountId === accountId ? "opacity-100" : "opacity-0")} />
                                                        {account.name} ({account.accountId})
                                                    </CommandItem>
                                                ))}
                                            </CommandGroup>
                                        </CommandList>
                                    </Command>
                                </PopoverContent>
                            </Popover>

                            {/* Clear All Filters */}
                            {(searchTerm || resourceType !== "all" || region !== "all" || accountId !== "all") && (
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => {
                                        setSearchTerm("");
                                        setResourceType("all");
                                        setRegion("all");
                                        setAccountId("all");
                                    }}
                                >
                                    <X className="h-4 w-4 mr-1" />
                                    Clear Filters
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

                                {/* Pagination */}
                                <div className="flex items-center justify-between mt-4">
                                    <div className="flex items-center gap-4">
                                        <div className="text-sm text-muted-foreground">
                                            Showing {resources.length} resources
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <span className="text-sm text-muted-foreground">Page size:</span>
                                            <Select value={pageSize.toString()} onValueChange={(val) => setPageSize(parseInt(val, 10))}>
                                                <SelectTrigger className="w-[80px] h-8">
                                                    <SelectValue />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    {PAGE_SIZES.map((size) => (
                                                        <SelectItem key={size} value={size.toString()}>{size}</SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                        </div>
                                    </div>
                                    <div className="flex gap-2">
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            disabled={!cursor}
                                            onClick={() => { setCursor(undefined); fetchResources(); }}
                                        >
                                            <ChevronLeft className="h-4 w-4" />
                                            First
                                        </Button>
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            disabled={!hasMore}
                                            onClick={() => fetchResources(cursor)}
                                        >
                                            Next
                                            <ChevronRight className="h-4 w-4" />
                                        </Button>
                                    </div>
                                </div>
                            </>
                        )}
                    </CardContent>
                </Card>
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
                    accountId: accountId !== "all" ? accountId : undefined,
                    region: region !== "all" ? region : undefined,
                    resourceType: resourceType !== "all" ? resourceType : undefined,
                }}
            />
        </>
    );
}
