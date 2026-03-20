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

function sortableHeader(label: string) {
    const Header = ({ column }: { column: Parameters<typeof SortableHeader>[0]["column"] }) => (
        <SortableHeader label={label} column={column} />
    );
    Header.displayName = `SortableHeader_${label}`;
    return Header;
}

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
    cell: ({ row }) => {
        const accountId = row.original.accountId;
        const accountName = row.original.accountName;
        return (
            <div>
                {accountName && <div className="text-sm font-medium truncate max-w-[160px]">{accountName}</div>}
                <div className="font-mono text-xs text-muted-foreground">{accountId}</div>
            </div>
        );
    },
    size: 170,
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
        accessorFn: (row) => row.metadata?.privateIpAddress,
        header: "Private IP",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 120,
        meta: { label: "Private IP" },
    },
    {
        id: "publicIp",
        accessorFn: (row) => row.metadata?.publicIpAddress,
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
        accessorFn: (row) => row.metadata?.dbInstanceClass,
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
    {
        id: "endpoint",
        accessorFn: (row) => row.metadata?.endpoint,
        header: "Endpoint",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 260,
        meta: { label: "Endpoint" },
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
// ECS Clusters
// ---------------------------------------------------------------------------

const ECS_CLUSTER_COLS: ColumnDef<Resource>[] = [
    NAME_COL,
    STATE_COL,
    {
        id: "activeServicesCount",
        accessorFn: (row) => row.metadata?.activeServicesCount,
        header: "Services",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 90,
        meta: { label: "Services" },
    },
    {
        id: "runningTasksCount",
        accessorFn: (row) => row.metadata?.runningTasksCount,
        header: "Running Tasks",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 120,
        meta: { label: "Running Tasks" },
    },
    {
        id: "registeredContainerInstances",
        accessorFn: (row) => row.metadata?.registeredContainerInstances,
        header: "Instances",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 100,
        meta: { label: "Instances" },
    },
    {
        id: "capacityProviders",
        accessorFn: (row) => row.metadata?.capacityProviders,
        header: "Capacity Providers",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 160,
        meta: { label: "Capacity Providers" },
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
// VPCs
// ---------------------------------------------------------------------------

const VPC_COLS: ColumnDef<Resource>[] = [
    NAME_COL,
    STATE_COL,
    {
        id: "cidrBlock",
        accessorFn: (row) => row.metadata?.cidrBlock,
        header: "CIDR Block",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 140,
        meta: { label: "CIDR Block" },
    },
    {
        id: "isDefault",
        accessorFn: (row) => row.metadata?.isDefault,
        header: "Default",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 80,
        meta: { label: "Default" },
    },
    {
        id: "instanceTenancy",
        accessorFn: (row) => row.metadata?.instanceTenancy,
        header: "Tenancy",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 90,
        meta: { label: "Tenancy" },
    },
    REGION_COL,
    ACCOUNT_COL,
    TAGS_COL,
    LAST_DISCOVERED_COL,
];

// ---------------------------------------------------------------------------
// Subnets
// ---------------------------------------------------------------------------

const SUBNET_COLS: ColumnDef<Resource>[] = [
    NAME_COL,
    STATE_COL,
    {
        id: "cidrBlock",
        accessorFn: (row) => row.metadata?.cidrBlock,
        header: "CIDR Block",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 140,
        meta: { label: "CIDR Block" },
    },
    {
        id: "availabilityZone",
        accessorFn: (row) => row.metadata?.availabilityZone,
        header: "AZ",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 120,
        meta: { label: "AZ" },
    },
    {
        id: "availableIpAddressCount",
        accessorFn: (row) => row.metadata?.availableIpAddressCount,
        header: "Available IPs",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 110,
        meta: { label: "Available IPs" },
    },
    {
        id: "mapPublicIpOnLaunch",
        accessorFn: (row) => row.metadata?.mapPublicIpOnLaunch,
        header: "Auto-assign IP",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 110,
        meta: { label: "Auto-assign IP" },
    },
    REGION_COL,
    ACCOUNT_COL,
    TAGS_COL,
    LAST_DISCOVERED_COL,
];

// ---------------------------------------------------------------------------
// Security Groups
// ---------------------------------------------------------------------------

const SG_COLS: ColumnDef<Resource>[] = [
    NAME_COL,
    {
        id: "description",
        accessorFn: (row) => row.metadata?.description,
        header: "Description",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 200,
        meta: { label: "Description" },
    },
    {
        id: "vpcId",
        accessorFn: (row) => row.metadata?.vpcId,
        header: "VPC",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 130,
        meta: { label: "VPC" },
    },
    {
        id: "inboundRulesCount",
        accessorFn: (row) => row.metadata?.inboundRulesCount,
        header: "Inbound Rules",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 110,
        meta: { label: "Inbound Rules" },
    },
    {
        id: "outboundRulesCount",
        accessorFn: (row) => row.metadata?.outboundRulesCount,
        header: "Outbound Rules",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 110,
        meta: { label: "Outbound Rules" },
    },
    REGION_COL,
    ACCOUNT_COL,
    TAGS_COL,
    LAST_DISCOVERED_COL,
];

// ---------------------------------------------------------------------------
// Network Interfaces (ENIs)
// ---------------------------------------------------------------------------

const ENI_COLS: ColumnDef<Resource>[] = [
    NAME_COL,
    STATE_COL,
    {
        id: "privateIpAddress",
        accessorFn: (row) => row.metadata?.privateIpAddress,
        header: sortableHeader("Private IP"),
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 130,
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
        id: "macAddress",
        accessorFn: (row) => row.metadata?.macAddress,
        header: "MAC Address",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 140,
        meta: { label: "MAC Address" },
    },
    {
        id: "attachedTo",
        accessorFn: (row) => row.metadata?.attachedTo,
        header: "Attached To",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 130,
        meta: { label: "Attached To" },
    },
    REGION_COL,
    ACCOUNT_COL,
    TAGS_COL,
    LAST_DISCOVERED_COL,
];

// ---------------------------------------------------------------------------
// NAT Gateways
// ---------------------------------------------------------------------------

const NAT_GW_COLS: ColumnDef<Resource>[] = [
    NAME_COL,
    STATE_COL,
    {
        id: "publicIp",
        accessorFn: (row) => row.metadata?.publicIp,
        header: sortableHeader("Public IP"),
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 130,
        meta: { label: "Public IP" },
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
        id: "vpcId",
        accessorFn: (row) => row.metadata?.vpcId,
        header: "VPC",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 130,
        meta: { label: "VPC" },
    },
    REGION_COL,
    ACCOUNT_COL,
    TAGS_COL,
    LAST_DISCOVERED_COL,
];

// ---------------------------------------------------------------------------
// EBS Volumes
// ---------------------------------------------------------------------------

const EBS_COLS: ColumnDef<Resource>[] = [
    NAME_COL,
    STATE_COL,
    {
        id: "volumeType",
        accessorFn: (row) => row.metadata?.volumeType,
        header: "Type",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 80,
        meta: { label: "Type" },
    },
    {
        id: "size",
        accessorFn: (row) => row.metadata?.size,
        header: "Size (GB)",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 90,
        meta: { label: "Size (GB)" },
    },
    {
        id: "iops",
        accessorFn: (row) => row.metadata?.iops,
        header: "IOPS",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 80,
        meta: { label: "IOPS" },
    },
    {
        id: "encrypted",
        accessorFn: (row) => row.metadata?.encrypted,
        header: "Encrypted",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 90,
        meta: { label: "Encrypted" },
    },
    {
        id: "availabilityZone",
        accessorFn: (row) => row.metadata?.availabilityZone,
        header: "AZ",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 110,
        meta: { label: "AZ" },
    },
    REGION_COL,
    ACCOUNT_COL,
    TAGS_COL,
    LAST_DISCOVERED_COL,
];

// ---------------------------------------------------------------------------
// Load Balancers (ALB / NLB)
// ---------------------------------------------------------------------------

const ELB_COLS: ColumnDef<Resource>[] = [
    NAME_COL,
    STATE_COL,
    {
        id: "type",
        accessorFn: (row) => row.metadata?.type,
        header: "Type",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 100,
        meta: { label: "Type" },
    },
    {
        id: "dnsName",
        accessorFn: (row) => row.metadata?.dnsName,
        header: "DNS Name",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 260,
        meta: { label: "DNS Name" },
    },
    {
        id: "scheme",
        accessorFn: (row) => row.metadata?.scheme,
        header: "Scheme",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 120,
        meta: { label: "Scheme" },
    },
    REGION_COL,
    ACCOUNT_COL,
    TAGS_COL,
    LAST_DISCOVERED_COL,
];

// ---------------------------------------------------------------------------
// ElastiCache Clusters
// ---------------------------------------------------------------------------

const ELASTICACHE_COLS: ColumnDef<Resource>[] = [
    NAME_COL,
    STATE_COL,
    {
        id: "engine",
        accessorFn: (row) => row.metadata?.engine,
        header: sortableHeader("Engine"),
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 90,
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
        id: "cacheNodeType",
        accessorFn: (row) => row.metadata?.cacheNodeType,
        header: "Node Type",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 140,
        meta: { label: "Node Type" },
    },
    {
        id: "numCacheNodes",
        accessorFn: (row) => row.metadata?.numCacheNodes,
        header: "Nodes",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 70,
        meta: { label: "Nodes" },
    },
    REGION_COL,
    ACCOUNT_COL,
    TAGS_COL,
    LAST_DISCOVERED_COL,
];

// ---------------------------------------------------------------------------
// KMS Keys
// ---------------------------------------------------------------------------

const KMS_COLS: ColumnDef<Resource>[] = [
    NAME_COL,
    {
        id: "enabled",
        accessorFn: (row) => row.metadata?.enabled,
        header: "Enabled",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 85,
        meta: { label: "Enabled" },
    },
    {
        id: "keyState",
        accessorFn: (row) => row.metadata?.keyState,
        header: "State",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 110,
        meta: { label: "State" },
    },
    {
        id: "keyManager",
        accessorFn: (row) => row.metadata?.keyManager,
        header: "Manager",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 90,
        meta: { label: "Manager" },
    },
    {
        id: "keySpec",
        accessorFn: (row) => row.metadata?.keySpec,
        header: "Key Spec",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 120,
        meta: { label: "Key Spec" },
    },
    {
        id: "description",
        accessorFn: (row) => row.metadata?.description,
        header: "Description",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 200,
        meta: { label: "Description" },
    },
    REGION_COL,
    ACCOUNT_COL,
    TAGS_COL,
    LAST_DISCOVERED_COL,
];

// ---------------------------------------------------------------------------
// ACM Certificates
// ---------------------------------------------------------------------------

const ACM_COLS: ColumnDef<Resource>[] = [
    NAME_COL,
    {
        id: "domainName",
        accessorFn: (row) => row.metadata?.domainName,
        header: "Domain",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 220,
        meta: { label: "Domain" },
    },
    {
        id: "certStatus",
        accessorFn: (row) => row.metadata?.status,
        header: "Status",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 110,
        meta: { label: "Status" },
    },
    {
        id: "issuer",
        accessorFn: (row) => row.metadata?.issuer,
        header: "Issuer",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 130,
        meta: { label: "Issuer" },
    },
    {
        id: "notAfter",
        accessorFn: (row) => row.metadata?.notAfter,
        header: "Expires",
        cell: ({ getValue }) => {
            const val = getValue() as string | undefined;
            if (!val) return <span className="text-muted-foreground">—</span>;
            const date = new Date(val);
            const daysLeft = Math.ceil((date.getTime() - Date.now()) / 86400000);
            const color = daysLeft < 30 ? "text-red-500" : daysLeft < 90 ? "text-yellow-500" : "text-muted-foreground";
            return <span className={color}>{date.toLocaleDateString()}</span>;
        },
        size: 110,
        meta: { label: "Expires" },
    },
    REGION_COL,
    ACCOUNT_COL,
    TAGS_COL,
    LAST_DISCOVERED_COL,
];

// ---------------------------------------------------------------------------
// ECR Repositories
// ---------------------------------------------------------------------------

const ECR_COLS: ColumnDef<Resource>[] = [
    NAME_COL,
    {
        id: "repositoryUri",
        accessorFn: (row) => row.metadata?.repositoryUri,
        header: "Repository URI",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 260,
        meta: { label: "Repository URI" },
    },
    {
        id: "imageTagMutability",
        accessorFn: (row) => row.metadata?.imageTagMutability,
        header: "Tag Mutability",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 120,
        meta: { label: "Tag Mutability" },
    },
    REGION_COL,
    ACCOUNT_COL,
    TAGS_COL,
    LAST_DISCOVERED_COL,
];

// ---------------------------------------------------------------------------
// EFS File Systems
// ---------------------------------------------------------------------------

const EFS_COLS: ColumnDef<Resource>[] = [
    NAME_COL,
    {
        id: "lifecycleState",
        accessorFn: (row) => row.metadata?.lifecycleState,
        header: "State",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 100,
        meta: { label: "State" },
    },
    {
        id: "performanceMode",
        accessorFn: (row) => row.metadata?.performanceMode,
        header: "Performance",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 120,
        meta: { label: "Performance" },
    },
    {
        id: "throughputMode",
        accessorFn: (row) => row.metadata?.throughputMode,
        header: "Throughput",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 110,
        meta: { label: "Throughput" },
    },
    {
        id: "encrypted",
        accessorFn: (row) => row.metadata?.encrypted,
        header: "Encrypted",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 90,
        meta: { label: "Encrypted" },
    },
    REGION_COL,
    ACCOUNT_COL,
    TAGS_COL,
    LAST_DISCOVERED_COL,
];

// ---------------------------------------------------------------------------
// RDS Clusters (Aurora)
// ---------------------------------------------------------------------------

const RDS_CLUSTER_COLS: ColumnDef<Resource>[] = [
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
        id: "multiAZ",
        accessorFn: (row) => row.metadata?.multiAZ,
        header: "Multi-AZ",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 90,
        meta: { label: "Multi-AZ" },
    },
    {
        id: "endpoint",
        accessorFn: (row) => row.metadata?.endpoint,
        header: "Endpoint",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 220,
        meta: { label: "Endpoint" },
    },
    REGION_COL,
    ACCOUNT_COL,
    TAGS_COL,
    LAST_DISCOVERED_COL,
];

// ---------------------------------------------------------------------------
// CloudFront Distributions
// ---------------------------------------------------------------------------

const CLOUDFRONT_COLS: ColumnDef<Resource>[] = [
    NAME_COL,
    {
        id: "domainName",
        accessorFn: (row) => row.metadata?.domainName,
        header: "Domain Name",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 240,
        meta: { label: "Domain Name" },
    },
    {
        id: "status",
        accessorFn: (row) => row.metadata?.status,
        header: "Status",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 100,
        meta: { label: "Status" },
    },
    {
        id: "aliases",
        accessorFn: (row) => row.metadata?.aliases,
        header: "Aliases",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 200,
        meta: { label: "Aliases" },
    },
    REGION_COL,
    ACCOUNT_COL,
    TAGS_COL,
    LAST_DISCOVERED_COL,
];

// ---------------------------------------------------------------------------
// DynamoDB Tables
// ---------------------------------------------------------------------------

const DYNAMODB_COLS: ColumnDef<Resource>[] = [
    NAME_COL,
    {
        id: "tableStatus",
        accessorFn: (row) => row.metadata?.tableStatus,
        header: "Status",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 100,
        meta: { label: "Status" },
    },
    {
        id: "itemCount",
        accessorFn: (row) => row.metadata?.itemCount,
        header: "Items",
        cell: ({ getValue }) => {
            const val = getValue() as number | undefined;
            return <MetaCell value={val !== undefined ? val.toLocaleString() : undefined} />;
        },
        size: 100,
        meta: { label: "Items" },
    },
    {
        id: "tableSizeBytes",
        accessorFn: (row) => row.metadata?.tableSizeBytes,
        header: "Size",
        cell: ({ getValue }) => {
            const bytes = getValue() as number | undefined;
            if (!bytes) return <span className="text-muted-foreground">—</span>;
            const kb = bytes / 1024;
            if (kb < 1024) return <span>{kb.toFixed(1)} KB</span>;
            return <span>{(kb / 1024).toFixed(1)} MB</span>;
        },
        size: 100,
        meta: { label: "Size" },
    },
    {
        id: "billingMode",
        accessorFn: (row) => row.metadata?.billingMode,
        header: "Billing",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 130,
        meta: { label: "Billing" },
    },
    REGION_COL,
    ACCOUNT_COL,
    TAGS_COL,
    LAST_DISCOVERED_COL,
];

// ---------------------------------------------------------------------------
// SSM Parameters
// ---------------------------------------------------------------------------

const SSM_COLS: ColumnDef<Resource>[] = [
    NAME_COL,
    {
        id: "paramType",
        accessorFn: (row) => row.metadata?.type,
        header: "Type",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 130,
        meta: { label: "Type" },
    },
    {
        id: "tier",
        accessorFn: (row) => row.metadata?.tier,
        header: "Tier",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 90,
        meta: { label: "Tier" },
    },
    {
        id: "version",
        accessorFn: (row) => row.metadata?.version,
        header: "Version",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 80,
        meta: { label: "Version" },
    },
    REGION_COL,
    ACCOUNT_COL,
    LAST_DISCOVERED_COL,
];

// ---------------------------------------------------------------------------
// IAM Roles
// ---------------------------------------------------------------------------

const IAM_ROLE_COLS: ColumnDef<Resource>[] = [
    NAME_COL,
    {
        id: "path",
        accessorFn: (row) => row.metadata?.path,
        header: "Path",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 130,
        meta: { label: "Path" },
    },
    {
        id: "createDate",
        accessorFn: (row) => row.metadata?.createDate,
        header: "Created",
        cell: ({ getValue }) => {
            const val = getValue() as string | undefined;
            return val ? <span className="text-muted-foreground">{new Date(val).toLocaleDateString()}</span> : <span className="text-muted-foreground">—</span>;
        },
        size: 110,
        meta: { label: "Created" },
    },
    {
        id: "description",
        accessorFn: (row) => row.metadata?.description,
        header: "Description",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 220,
        meta: { label: "Description" },
    },
    REGION_COL,
    ACCOUNT_COL,
    TAGS_COL,
    LAST_DISCOVERED_COL,
];

// ---------------------------------------------------------------------------
// EKS Clusters
// ---------------------------------------------------------------------------

const EKS_COLS: ColumnDef<Resource>[] = [
    NAME_COL,
    STATE_COL,
    {
        id: "k8sVersion",
        accessorFn: (row) => row.metadata?.version,
        header: "K8s Version",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 110,
        meta: { label: "K8s Version" },
    },
    {
        id: "platformVersion",
        accessorFn: (row) => row.metadata?.platformVersion,
        header: "Platform",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 100,
        meta: { label: "Platform" },
    },
    {
        id: "endpoint",
        accessorFn: (row) => row.metadata?.endpoint,
        header: "Endpoint",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 220,
        meta: { label: "Endpoint" },
    },
    REGION_COL,
    ACCOUNT_COL,
    TAGS_COL,
    LAST_DISCOVERED_COL,
];

// ---------------------------------------------------------------------------
// CloudWatch Alarms
// ---------------------------------------------------------------------------

const CW_ALARM_COLS: ColumnDef<Resource>[] = [
    NAME_COL,
    STATE_COL,
    {
        id: "metricName",
        accessorFn: (row) => row.metadata?.metricName,
        header: "Metric",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 160,
        meta: { label: "Metric" },
    },
    {
        id: "namespace",
        accessorFn: (row) => row.metadata?.namespace,
        header: "Namespace",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 160,
        meta: { label: "Namespace" },
    },
    {
        id: "threshold",
        accessorFn: (row) => row.metadata?.threshold,
        header: "Threshold",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 90,
        meta: { label: "Threshold" },
    },
    REGION_COL,
    ACCOUNT_COL,
    TAGS_COL,
    LAST_DISCOVERED_COL,
];

// ---------------------------------------------------------------------------
// Transit Gateways
// ---------------------------------------------------------------------------

const TGW_COLS: ColumnDef<Resource>[] = [
    NAME_COL,
    STATE_COL,
    {
        id: "description",
        accessorFn: (row) => row.metadata?.description,
        header: "Description",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 200,
        meta: { label: "Description" },
    },
    {
        id: "ownerId",
        accessorFn: (row) => row.metadata?.ownerId,
        header: "Owner",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 130,
        meta: { label: "Owner" },
    },
    {
        id: "amazonSideAsn",
        accessorFn: (row) => row.metadata?.amazonSideAsn,
        header: "ASN",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 90,
        meta: { label: "ASN" },
    },
    REGION_COL,
    ACCOUNT_COL,
    TAGS_COL,
    LAST_DISCOVERED_COL,
];

// ---------------------------------------------------------------------------
// Transit Gateway Attachments
// ---------------------------------------------------------------------------

const TGW_ATTACHMENT_COLS: ColumnDef<Resource>[] = [
    NAME_COL,
    STATE_COL,
    {
        id: "resourceType",
        accessorFn: (row) => row.metadata?.resourceType,
        header: "Resource Type",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 120,
        meta: { label: "Resource Type" },
    },
    {
        id: "resourceId",
        accessorFn: (row) => row.metadata?.resourceId,
        header: "Resource ID",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 180,
        meta: { label: "Resource ID" },
    },
    {
        id: "transitGatewayId",
        accessorFn: (row) => row.metadata?.transitGatewayId,
        header: "Transit Gateway",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 180,
        meta: { label: "Transit Gateway" },
    },
    REGION_COL,
    ACCOUNT_COL,
    TAGS_COL,
    LAST_DISCOVERED_COL,
];

// ---------------------------------------------------------------------------
// VPC Peering Connections
// ---------------------------------------------------------------------------

const VPC_PEERING_COLS: ColumnDef<Resource>[] = [
    NAME_COL,
    STATE_COL,
    {
        id: "requesterVpcId",
        accessorFn: (row) => row.metadata?.requesterVpcId,
        header: "Requester VPC",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 150,
        meta: { label: "Requester VPC" },
    },
    {
        id: "requesterCidr",
        accessorFn: (row) => row.metadata?.requesterCidr,
        header: "Requester CIDR",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 140,
        meta: { label: "Requester CIDR" },
    },
    {
        id: "accepterVpcId",
        accessorFn: (row) => row.metadata?.accepterVpcId,
        header: "Accepter VPC",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 150,
        meta: { label: "Accepter VPC" },
    },
    {
        id: "accepterCidr",
        accessorFn: (row) => row.metadata?.accepterCidr,
        header: "Accepter CIDR",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 140,
        meta: { label: "Accepter CIDR" },
    },
    {
        id: "accepterOwnerId",
        accessorFn: (row) => row.metadata?.accepterOwnerId,
        header: "Accepter Account",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 140,
        meta: { label: "Accepter Account" },
    },
    REGION_COL,
    ACCOUNT_COL,
    TAGS_COL,
    LAST_DISCOVERED_COL,
];

// ---------------------------------------------------------------------------
// WAFv2 Web ACLs
// ---------------------------------------------------------------------------

const WAF_COLS: ColumnDef<Resource>[] = [
    NAME_COL,
    STATE_COL,
    {
        id: "scope",
        accessorFn: (row) => row.metadata?.scope,
        header: "Scope",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 110,
        meta: { label: "Scope" },
    },
    {
        id: "description",
        accessorFn: (row) => row.metadata?.description,
        header: "Description",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 220,
        meta: { label: "Description" },
    },
    {
        id: "managedByFirewallManager",
        accessorFn: (row) => row.metadata?.managedByFirewallManager,
        header: "Firewall Manager",
        cell: ({ getValue }) => <MetaCell value={getValue()} />,
        size: 140,
        meta: { label: "Firewall Manager" },
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
    ec2_vpcs: VPC_COLS,
    ec2_subnets: SUBNET_COLS,
    ec2_security_groups: SG_COLS,
    ec2_network_interfaces: ENI_COLS,
    ec2_nat_gateways: NAT_GW_COLS,
    ec2_volumes: EBS_COLS,
    // RDS
    rds_instances: RDS_COLS,
    rds_db_instances: RDS_COLS,
    rds_db_clusters: RDS_CLUSTER_COLS,
    // DocumentDB
    docdb_instances: DOCDB_COLS,
    docdb_db_clusters: DOCDB_COLS,
    // ECS
    ecs_clusters: ECS_CLUSTER_COLS,
    ecs_describe_clusters: ECS_CLUSTER_COLS,
    ecs_services: ECS_COLS,
    ecs_describe_services: ECS_COLS,
    // ASG
    asg_groups: ASG_COLS,
    autoscaling_auto_scaling_groups: ASG_COLS,
    // Lambda
    lambda_functions: LAMBDA_COLS,
    // S3
    s3_buckets: S3_COLS,
    // Load Balancers
    elbv2_load_balancers: ELB_COLS,
    // Caching
    elasticache_cache_clusters: ELASTICACHE_COLS,
    // Storage
    efs_file_systems: EFS_COLS,
    // KMS
    kms_keys: KMS_COLS,
    // ACM
    acm_certificates: ACM_COLS,
    // ECR
    ecr_repositories: ECR_COLS,
    // CloudFront
    cloudfront_distributions: CLOUDFRONT_COLS,
    // DynamoDB
    dynamodb_tables: DYNAMODB_COLS,
    // SSM
    ssm_parameters: SSM_COLS,
    // IAM
    iam_roles: IAM_ROLE_COLS,
    iam_users: IAM_ROLE_COLS,
    // EKS
    eks_clusters: EKS_COLS,
    // CloudWatch
    cloudwatch_metric_alarms: CW_ALARM_COLS,
    // Transit Gateways
    ec2_transit_gateways: TGW_COLS,
    ec2_transit_gateway_attachments: TGW_ATTACHMENT_COLS,
    // VPC Peering
    ec2_vpc_peering_connections: VPC_PEERING_COLS,
    // WAF
    wafv2_web_acls: WAF_COLS,
    // Default
    _default: DEFAULT_COLS,
};

export function getColumnsForType(resourceType: string): ColumnDef<Resource>[] {
    return COLUMN_REGISTRY[resourceType] ?? COLUMN_REGISTRY._default;
}
