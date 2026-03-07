"use client";

/**
 * Column Registry for the dynamic inventory grid.
 *
 * Each resource type maps to a curated ColumnDef[] array.
 * Common columns are composed via shared constants; type-specific columns
 * read from resource.metadata (populated by the discovery Lambda).
 * Columns gracefully show "—" when metadata fields are absent.
 */

import React from "react";
import { ColumnDef } from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ArrowUpDown, Tag, Server, Database, Cloud, Box } from "lucide-react";
import { Resource } from "./types";
import { getServiceName } from "@/lib/resource-types";

// ---------------------------------------------------------------------------
// Cell Renderers
// ---------------------------------------------------------------------------

function ResourceIcon({ type }: { type: string }) {
    if (type.includes("ec2") || type.includes("asg")) return <Server className="h-4 w-4 text-muted-foreground shrink-0" />;
    if (type.includes("rds") || type.includes("dynamo") || type.includes("docdb")) return <Database className="h-4 w-4 text-muted-foreground shrink-0" />;
    if (type.includes("ecs")) return <Box className="h-4 w-4 text-muted-foreground shrink-0" />;
    return <Cloud className="h-4 w-4 text-muted-foreground shrink-0" />;
}

function NameCell({ name, resourceId, type }: { name: string; resourceId: string; type: string }) {
    return (
        <div className="flex items-center gap-2">
            <ResourceIcon type={type} />
            <div>
                <div className="font-medium">{name}</div>
                <div className="text-xs text-muted-foreground truncate max-w-[200px]">{resourceId}</div>
            </div>
        </div>
    );
}

const STATE_COLORS: Record<string, string> = {
    running: "bg-green-500/10 text-green-500 border-green-500/20",
    stopped: "bg-red-500/10 text-red-500 border-red-500/20",
    available: "bg-blue-500/10 text-blue-500 border-blue-500/20",
    pending: "bg-yellow-500/10 text-yellow-500 border-yellow-500/20",
    terminated: "bg-gray-500/10 text-gray-500 border-gray-500/20",
    active: "bg-green-500/10 text-green-500 border-green-500/20",
    inactive: "bg-red-500/10 text-red-500 border-red-500/20",
};

function StateBadge({ state }: { state: string }) {
    if (!state) return <span className="text-muted-foreground">—</span>;
    return (
        <Badge variant="outline" className={STATE_COLORS[state.toLowerCase()] ?? "bg-gray-500/10"}>
            {state}
        </Badge>
    );
}

function TagsCell({ tags }: { tags: Record<string, string> }) {
    const entries = Object.entries(tags ?? {});
    return (
        <TooltipProvider>
            <Tooltip>
                <TooltipTrigger asChild>
                    <div className="flex items-center gap-1 cursor-default">
                        <Tag className="h-3 w-3 text-muted-foreground" />
                        <span className="text-sm text-muted-foreground">{entries.length}</span>
                    </div>
                </TooltipTrigger>
                <TooltipContent>
                    {entries.length === 0 ? (
                        <p>No tags</p>
                    ) : (
                        <div className="max-w-xs space-y-1">
                            {entries.slice(0, 5).map(([k, v]) => (
                                <div key={k} className="text-xs">
                                    <span className="font-medium">{k}:</span> {v}
                                </div>
                            ))}
                            {entries.length > 5 && (
                                <p className="text-xs text-muted-foreground">+{entries.length - 5} more</p>
                            )}
                        </div>
                    )}
                </TooltipContent>
            </Tooltip>
        </TooltipProvider>
    );
}

/** Generic metadata cell — shows "—" when value is missing */
function MetaCell({ value }: { value: unknown }) {
    if (value === null || value === undefined || value === "") {
        return <span className="text-muted-foreground">—</span>;
    }
    if (typeof value === "boolean") {
        return <Badge variant={value ? "default" : "secondary"}>{value ? "Yes" : "No"}</Badge>;
    }
    return <span>{String(value)}</span>;
}

// ---------------------------------------------------------------------------
// Sortable Header Helper
// ---------------------------------------------------------------------------

function SortableHeader({ label, column }: { label: string; column: { toggleSorting: (asc: boolean) => void; getIsSorted: () => false | "asc" | "desc" } }) {
    return (
        <Button
            variant="ghost"
            size="sm"
            className="-ml-3 h-8 gap-1"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
        >
            {label}
            <ArrowUpDown className="h-3 w-3" />
        </Button>
    );
}

const sortableHeader = (label: string) =>
    ({ column }: { column: Parameters<typeof SortableHeader>[0]["column"] }) => (
        <SortableHeader label={label} column={column} />
    );

// ---------------------------------------------------------------------------
// Common Column Definitions
// ---------------------------------------------------------------------------

const NAME_COL: ColumnDef<Resource> = {
    id: "name",
    accessorKey: "name",
    header: sortableHeader("Name"),
    cell: ({ row }) => (
        <NameCell
            name={row.original.name}
            resourceId={row.original.resourceId}
            type={row.original.resourceType}
        />
    ),
    size: 240,
    meta: { label: "Name" },
};

const STATE_COL: ColumnDef<Resource> = {
    id: "state",
    accessorKey: "state",
    header: sortableHeader("State"),
    cell: ({ getValue }) => <StateBadge state={getValue() as string} />,
    size: 110,
    meta: { label: "State" },
};

const REGION_COL: ColumnDef<Resource> = {
    id: "region",
    accessorKey: "region",
    header: sortableHeader("Region"),
    size: 150,
    meta: { label: "Region" },
};

const ACCOUNT_COL: ColumnDef<Resource> = {
    id: "accountId",
    accessorKey: "accountId",
    header: "Account",
    cell: ({ getValue }) => <span className="font-mono text-sm">{getValue() as string}</span>,
    size: 130,
    meta: { label: "Account" },
};

const TAGS_COL: ColumnDef<Resource> = {
    id: "tags",
    accessorKey: "tags",
    header: "Tags",
    cell: ({ getValue }) => <TagsCell tags={getValue() as Record<string, string>} />,
    enableSorting: false,
    size: 75,
    meta: { label: "Tags" },
};

const LAST_DISCOVERED_COL: ColumnDef<Resource> = {
    id: "lastDiscoveredAt",
    accessorKey: "lastDiscoveredAt",
    header: sortableHeader("Discovered"),
    cell: ({ getValue }) => {
        const val = getValue() as string;
        return val
            ? <span className="text-muted-foreground">{new Date(val).toLocaleDateString()}</span>
            : <span className="text-muted-foreground">—</span>;
    },
    size: 130,
    meta: { label: "Discovered" },
};

// ---------------------------------------------------------------------------
// EC2 Instances
// ---------------------------------------------------------------------------

const EC2_COLS: ColumnDef<Resource>[] = [
    NAME_COL,
    STATE_COL,
    {
        id: "instanceType",
        accessorFn: (row) => row.metadata?.instanceType,
        header: "Instance Type",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 130,
        meta: { label: "Instance Type" },
    },
    {
        id: "privateIp",
        accessorFn: (row) => row.metadata?.privateIp,
        header: "Private IP",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 120,
        meta: { label: "Private IP" },
    },
    {
        id: "publicIp",
        accessorFn: (row) => row.metadata?.publicIp,
        header: "Public IP",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 120,
        meta: { label: "Public IP" },
    },
    {
        id: "platform",
        accessorFn: (row) => row.metadata?.platform,
        header: "Platform",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 100,
        meta: { label: "Platform" },
    },
    REGION_COL,
    ACCOUNT_COL,
    TAGS_COL,
    LAST_DISCOVERED_COL,
];

// ---------------------------------------------------------------------------
// RDS Instances
// ---------------------------------------------------------------------------

const RDS_COLS: ColumnDef<Resource>[] = [
    NAME_COL,
    STATE_COL,
    {
        id: "engine",
        accessorFn: (row) => row.metadata?.engine,
        header: sortableHeader("Engine"),
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 100,
        meta: { label: "Engine" },
    },
    {
        id: "engineVersion",
        accessorFn: (row) => row.metadata?.engineVersion,
        header: "Version",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 90,
        meta: { label: "Version" },
    },
    {
        id: "instanceClass",
        accessorFn: (row) => row.metadata?.instanceClass,
        header: "Instance Class",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 140,
        meta: { label: "Instance Class" },
    },
    {
        id: "multiAZ",
        accessorFn: (row) => row.metadata?.multiAZ,
        header: "Multi-AZ",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 90,
        meta: { label: "Multi-AZ" },
    },
    REGION_COL,
    ACCOUNT_COL,
    TAGS_COL,
    LAST_DISCOVERED_COL,
];

// ---------------------------------------------------------------------------
// DocumentDB Clusters
// ---------------------------------------------------------------------------

const DOCDB_COLS: ColumnDef<Resource>[] = [
    NAME_COL,
    STATE_COL,
    {
        id: "engineVersion",
        accessorFn: (row) => row.metadata?.engineVersion,
        header: "Engine Version",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 130,
        meta: { label: "Engine Version" },
    },
    {
        id: "storageEncrypted",
        accessorFn: (row) => row.metadata?.storageEncrypted,
        header: "Encrypted",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 100,
        meta: { label: "Encrypted" },
    },
    REGION_COL,
    ACCOUNT_COL,
    TAGS_COL,
    LAST_DISCOVERED_COL,
];

// ---------------------------------------------------------------------------
// ECS Services
// ---------------------------------------------------------------------------

const ECS_COLS: ColumnDef<Resource>[] = [
    NAME_COL,
    STATE_COL,
    {
        id: "cluster",
        // clusterArn is already populated by the discovery Lambda
        accessorFn: (row) => {
            const arn = row.metadata?.clusterArn as string | undefined;
            return arn ? arn.split("/").pop() : undefined;
        },
        header: sortableHeader("Cluster"),
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 180,
        meta: { label: "Cluster" },
    },
    {
        id: "desiredCount",
        accessorFn: (row) => row.metadata?.desiredCount,
        header: "Desired",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 80,
        meta: { label: "Desired" },
    },
    {
        id: "runningCount",
        accessorFn: (row) => row.metadata?.runningCount,
        header: "Running",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 80,
        meta: { label: "Running" },
    },
    {
        id: "launchType",
        accessorFn: (row) => row.metadata?.launchType,
        header: "Launch Type",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 110,
        meta: { label: "Launch Type" },
    },
    REGION_COL,
    ACCOUNT_COL,
    TAGS_COL,
    LAST_DISCOVERED_COL,
];

// ---------------------------------------------------------------------------
// Auto Scaling Groups
// ---------------------------------------------------------------------------

const ASG_COLS: ColumnDef<Resource>[] = [
    NAME_COL,
    {
        id: "minSize",
        accessorFn: (row) => row.metadata?.minSize,
        header: "Min",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 70,
        meta: { label: "Min" },
    },
    {
        id: "desiredCapacity",
        accessorFn: (row) => row.metadata?.desiredCapacity,
        header: "Desired",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 80,
        meta: { label: "Desired" },
    },
    {
        id: "maxSize",
        accessorFn: (row) => row.metadata?.maxSize,
        header: "Max",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 70,
        meta: { label: "Max" },
    },
    {
        id: "launchTemplate",
        accessorFn: (row) => row.metadata?.launchTemplate,
        header: "Launch Template",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 160,
        meta: { label: "Launch Template" },
    },
    REGION_COL,
    ACCOUNT_COL,
    TAGS_COL,
    LAST_DISCOVERED_COL,
];

// ---------------------------------------------------------------------------
// Lambda Functions
// ---------------------------------------------------------------------------

const LAMBDA_COLS: ColumnDef<Resource>[] = [
    NAME_COL,
    STATE_COL,
    {
        id: "runtime",
        accessorFn: (row) => row.metadata?.runtime,
        header: "Runtime",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 110,
        meta: { label: "Runtime" },
    },
    {
        id: "memorySize",
        accessorFn: (row) => row.metadata?.memorySize,
        header: "Memory (MB)",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 110,
        meta: { label: "Memory (MB)" },
    },
    {
        id: "timeout",
        accessorFn: (row) => row.metadata?.timeout,
        header: "Timeout (s)",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 110,
        meta: { label: "Timeout (s)" },
    },
    REGION_COL,
    ACCOUNT_COL,
    TAGS_COL,
    LAST_DISCOVERED_COL,
];

// ---------------------------------------------------------------------------
// S3 Buckets
// ---------------------------------------------------------------------------

const S3_COLS: ColumnDef<Resource>[] = [
    NAME_COL,
    {
        id: "versioning",
        accessorFn: (row) => row.metadata?.versioning,
        header: "Versioning",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 100,
        meta: { label: "Versioning" },
    },
    {
        id: "encryption",
        accessorFn: (row) => row.metadata?.encryption,
        header: "Encryption",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 100,
        meta: { label: "Encryption" },
    },
    REGION_COL,
    ACCOUNT_COL,
    TAGS_COL,
    LAST_DISCOVERED_COL,
];

// ---------------------------------------------------------------------------
// Elastic IPs
// ---------------------------------------------------------------------------

const EIP_COLS: ColumnDef<Resource>[] = [
    NAME_COL,
    {
        id: "publicIp",
        accessorFn: (row) => row.metadata?.publicIp,
        header: sortableHeader("Public IP"),
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 130,
        meta: { label: "Public IP" },
    },
    {
        id: "allocationId",
        accessorFn: (row) => row.metadata?.allocationId,
        header: "Allocation ID",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 160,
        meta: { label: "Allocation ID" },
    },
    {
        id: "associatedInstanceId",
        accessorFn: (row) => row.metadata?.associatedInstanceId,
        header: "Attached To",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 150,
        meta: { label: "Attached To" },
    },
    REGION_COL,
    ACCOUNT_COL,
    TAGS_COL,
    LAST_DISCOVERED_COL,
];

// ---------------------------------------------------------------------------
// Default — shown when "All Types" is selected
// ---------------------------------------------------------------------------

const DEFAULT_COLS: ColumnDef<Resource>[] = [
    NAME_COL,
    {
        id: "service",
        accessorFn: (row) => getServiceName(row.resourceType),
        header: sortableHeader("Service"),
        cell: ({ getValue }) => (
            <Badge variant="outline" className="bg-primary/10">
                {getValue() as string}
            </Badge>
        ),
        size: 100,
        meta: { label: "Service" },
    },
    {
        id: "resourceType",
        accessorKey: "resourceType",
        header: sortableHeader("Type"),
        cell: ({ getValue }) => (
            <Badge variant="secondary" className="font-mono text-xs">
                {getValue() as string}
            </Badge>
        ),
        size: 200,
        meta: { label: "Type" },
    },
    STATE_COL,
    REGION_COL,
    ACCOUNT_COL,
    TAGS_COL,
    LAST_DISCOVERED_COL,
];

// ---------------------------------------------------------------------------
// Registry + Lookup
// ---------------------------------------------------------------------------

export const COLUMN_REGISTRY: Record<string, ColumnDef<Resource>[]> = {
    // EC2
    ec2_instances: EC2_COLS,
    ec2_addresses: EIP_COLS,
    // RDS
    rds_instances: RDS_COLS,
    rds_db_instances: RDS_COLS,
    // DocumentDB
    docdb_instances: DOCDB_COLS,
    docdb_db_clusters: DOCDB_COLS,
    // ECS
    ecs_services: ECS_COLS,
    // ASG
    asg_groups: ASG_COLS,
    autoscaling_auto_scaling_groups: ASG_COLS,
    // Lambda
    lambda_functions: LAMBDA_COLS,
    // S3
    s3_buckets: S3_COLS,
    // Default
    _default: DEFAULT_COLS,
};

export function getColumnsForType(resourceType: string): ColumnDef<Resource>[] {
    return COLUMN_REGISTRY[resourceType] ?? COLUMN_REGISTRY._default;
}
