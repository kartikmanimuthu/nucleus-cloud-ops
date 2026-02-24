"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { RefreshCw, Download, Search, Filter, ChevronLeft, ChevronRight, Database, Server, Cloud, Loader2, Check, ChevronsUpDown, Tag, Box, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { ClientAccountService } from "@/lib/client-account-service";
import { UIAccount } from "@/lib/types";
import { ResourceDetailDialog, ResourceDetailProps } from "@/components/inventory/resource-detail-dialog";
import { AskAIDialog } from "@/components/inventory/ask-ai-dialog";
import { cn } from "@/lib/utils";

interface Resource {
    resourceId: string;
    resourceArn: string;
    resourceType: string;
    name: string;
    region: string;
    state: string;
    accountId: string;
    lastDiscoveredAt: string;
    tags: Record<string, string>;
    metadata?: Record<string, any>;
}

interface SyncStatus {
    // Legacy per-account status
    accountId: string;
    accountName: string;
    lastSyncedAt?: string;
    lastSyncStatus?: string;
    lastSyncResourceCount?: number;
}

interface InventoryStatus {
    // New sync status from SYNC#INVENTORY
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

const RESOURCE_TYPES = [
    { value: "all", label: "All Types" },
    { value: "ec2_instances", label: "EC2 Instances" },
    { value: "rds_db_instances", label: "RDS Instances" },
    { value: "docdb_db_clusters", label: "DocumentDB Clusters" },
    { value: "autoscaling_auto_scaling_groups", label: "Auto Scaling Groups" },
    { value: "ecs_services", label: "ECS Services" },
    { value: "ec2_addresses", label: "Elastic IPs" },
    { value: "ec2_nat_gateways", label: "NAT Gateways" },
    { value: "ec2_security_groups", label: "Security Groups" },
    { value: "ec2_subnets", label: "Subnets" },
    { value: "ec2_network_interfaces", label: "Elastic Network Interfaces" },
    { value: "lambda_functions", label: "Lambda Functions" },
    { value: "dynamodb_tables", label: "DynamoDB Tables" },
    { value: "acm_certificates", label: "ACM Certificates" },
    { value: "apigateway_rest_apis", label: "API Gateway" },
    { value: "kms_keys", label: "KMS Keys" },
];

const REGIONS = [
    { value: "all", label: "All Regions" },
    { value: "us-east-1", label: "US East (N. Virginia)" },
    { value: "us-west-2", label: "US West (Oregon)" },
    { value: "eu-west-1", label: "Europe (Ireland)" },
    { value: "ap-south-1", label: "Asia Pacific (Mumbai)" },
    { value: "ap-southeast-1", label: "Asia Pacific (Singapore)" },
];



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

    // Helper: Get service name from resource type
    const getServiceName = (resourceType: string): string => {
        const serviceMap: Record<string, string> = {
            ec2_instances: "EC2",
            rds_db_instances: "RDS",
            ecs_services: "ECS",
            ec2_addresses: "EC2",
            ec2_nat_gateways: "EC2",
            ec2_security_groups: "EC2",
            ec2_subnets: "EC2",
            ec2_network_interfaces: "EC2",
            lambda_functions: "Lambda",
            autoscaling_auto_scaling_groups: "Auto Scaling",
            dynamodb_tables: "DynamoDB",
            docdb_db_clusters: "DocumentDB",
            acm_certificates: "ACM",
            apigateway_rest_apis: "APIGateway",
            kms_keys: "KMS",
        };
        return serviceMap[resourceType] || resourceType.replace(/_/g, " ").toUpperCase();
    };

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
        } catch (error) {
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
                    description: `Scan ID: ${data.scanId?.substring(0, 8) || 'N/A'}`,
                    duration: 5000,
                });
            } else {
                toast.error(data.error || "Failed to trigger sync");
            }
        } catch (error) {
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
                toast.success(`Exported ${data.resourceCount} resources`);
            } else {
                toast.error(data.error || "Failed to export");
            }
        } catch (error) {
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
            fetchResources();
        }, 300);
        return () => clearTimeout(timer);
    }, [searchTerm, resourceType, region, accountId, fetchResources]);

    // Fetch accounts for filter dropdown
    useEffect(() => {
        const fetchAccounts = async () => {
            try {
                const result = await ClientAccountService.getAccounts({ statusFilter: 'active', connectionFilter: 'connected', limit: 1000 });
                setAccounts(result.accounts);
            } catch (error) {
                console.error("Failed to fetch accounts:", error);
            }
        };
        fetchAccounts();
    }, []);

    // Handle row click to open resource detail
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
            metadata: resource.metadata,
        });
        setDialogOpen(true);
    };

    const getResourceIcon = (type: string) => {
        if (type.includes("ec2") || type.includes("instance")) return <Server className="h-4 w-4" />;
        if (type.includes("rds") || type.includes("dynamo") || type.includes("docdb")) return <Database className="h-4 w-4" />;
        return <Cloud className="h-4 w-4" />;
    };



    // Use centralized sync status from new API structure
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
                                {lastSyncedAt
                                    ? new Date(lastSyncedAt).toLocaleDateString()
                                    : "Never"}
                            </div>
                            <p className="text-xs text-muted-foreground">
                                {lastSyncedAt
                                    ? new Date(lastSyncedAt).toLocaleTimeString()
                                    : "Click Sync Now"}
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
                                    {RESOURCE_TYPES.map(type => (
                                        <SelectItem key={type.value} value={type.value}>{type.label}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            <Select value={region} onValueChange={setRegion}>
                                <SelectTrigger className="w-[180px]">
                                    <SelectValue placeholder="Region" />
                                </SelectTrigger>
                                <SelectContent>
                                    {REGIONS.map(r => (
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
                                                    <Check
                                                        className={cn(
                                                            "mr-2 h-4 w-4",
                                                            accountId === "all" ? "opacity-100" : "opacity-0"
                                                        )}
                                                    />
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
                                                        <Check
                                                            className={cn(
                                                                "mr-2 h-4 w-4",
                                                                account.accountId === accountId ? "opacity-100" : "opacity-0"
                                                            )}
                                                        />
                                                        {account.name} ({account.accountId})
                                                    </CommandItem>
                                                ))}
                                            </CommandGroup>
                                        </CommandList>
                                    </Command>
                                </PopoverContent>
                            </Popover>
                        </div>
                    </CardContent>
                </Card>

                {/* Resources Table */}
                <Card>
                    <CardHeader>
                        <CardTitle>Discovered Resources</CardTitle>
                        <CardDescription>
                            {loading ? "Loading..." : `Showing ${resources.length} resources`}
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
                                <Table>
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead>Name</TableHead>
                                            <TableHead>Service</TableHead>
                                            <TableHead>Type</TableHead>
                                            <TableHead>Region</TableHead>
                                            <TableHead>Account</TableHead>

                                            <TableHead>Tags</TableHead>
                                            <TableHead>Last Discovered</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {resources.map((resource) => (
                                            <TableRow
                                                key={resource.resourceArn || resource.resourceId}
                                                className="cursor-pointer hover:bg-muted/50"
                                                onClick={() => handleRowClick(resource)}
                                            >
                                                <TableCell>
                                                    <div className="flex items-center gap-2">
                                                        {getResourceIcon(resource.resourceType)}
                                                        <div>
                                                            <div className="font-medium">{resource.name}</div>
                                                            <div className="text-xs text-muted-foreground truncate max-w-[200px]">
                                                                {resource.resourceId}
                                                            </div>
                                                        </div>
                                                    </div>
                                                </TableCell>
                                                <TableCell>
                                                    <Badge variant="outline" className="bg-primary/10">
                                                        {getServiceName(resource.resourceType)}
                                                    </Badge>
                                                </TableCell>
                                                <TableCell>
                                                    <Badge variant="secondary">{resource.resourceType}</Badge>
                                                </TableCell>
                                                <TableCell>{resource.region}</TableCell>
                                                <TableCell className="font-mono text-sm">{resource.accountId}</TableCell>

                                                <TableCell>
                                                    <TooltipProvider>
                                                        <Tooltip>
                                                            <TooltipTrigger asChild>
                                                                <div className="flex items-center gap-1">
                                                                    <Tag className="h-3 w-3 text-muted-foreground" />
                                                                    <span className="text-sm text-muted-foreground">
                                                                        {Object.keys(resource.tags || {}).length}
                                                                    </span>
                                                                </div>
                                                            </TooltipTrigger>
                                                            <TooltipContent>
                                                                {Object.keys(resource.tags || {}).length === 0 ? (
                                                                    <p>No tags</p>
                                                                ) : (
                                                                    <div className="max-w-xs space-y-1">
                                                                        {Object.entries(resource.tags || {}).slice(0, 5).map(([k, v]) => (
                                                                            <div key={k} className="text-xs">
                                                                                <span className="font-medium">{k}:</span> {v}
                                                                            </div>
                                                                        ))}
                                                                        {Object.keys(resource.tags || {}).length > 5 && (
                                                                            <p className="text-xs text-muted-foreground">+{Object.keys(resource.tags || {}).length - 5} more</p>
                                                                        )}
                                                                    </div>
                                                                )}
                                                            </TooltipContent>
                                                        </Tooltip>
                                                    </TooltipProvider>
                                                </TableCell>
                                                <TableCell className="text-muted-foreground">
                                                    {resource.lastDiscoveredAt
                                                        ? new Date(resource.lastDiscoveredAt).toLocaleDateString()
                                                        : "-"}
                                                </TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>

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
                                                    {PAGE_SIZES.map(size => (
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
                                            onClick={() => fetchResources()}
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

            {/* Ask AI Dialog */}
            <AskAIDialog
                open={askAIOpen}
                onOpenChange={setAskAIOpen}
            />
        </>
    );
}
