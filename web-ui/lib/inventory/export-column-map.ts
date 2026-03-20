/**
 * Shared export column definitions for the inventory module.
 * No React, no "use client" — safe for both server-side API routes and client components.
 *
 * Mirrors the column structure in column-registry.tsx but as plain data,
 * so the export API route can build dynamic spreadsheet columns per resource type.
 */

import { getServiceName } from '@/lib/resource-types';

export interface ExportColumnDef {
    /** Spreadsheet column header */
    label: string;
    /**
     * Dot-path to the value on the Resource object:
     * - Top-level field: "name", "state", "region", "accountId", "resourceArn", "lastDiscoveredAt"
     * - Metadata field:  "metadata.instanceType", "metadata.engine", etc.
     * - Special:         "tags" (JSON-serialized), "service" (computed via getServiceName)
     */
    accessor: string;
}

// ---------------------------------------------------------------------------
// Common column definitions (mirrors column-registry.tsx constants)
// ---------------------------------------------------------------------------

const NAME: ExportColumnDef = { label: 'Name', accessor: 'name' };
const STATE: ExportColumnDef = { label: 'State', accessor: 'state' };
const REGION: ExportColumnDef = { label: 'Region', accessor: 'region' };
const ACCOUNT_NAME: ExportColumnDef = { label: 'Account Name', accessor: 'accountName' };
const ACCOUNT_ID: ExportColumnDef = { label: 'Account ID', accessor: 'accountId' };
const TAGS: ExportColumnDef = { label: 'Tags', accessor: 'tags' };
const DISCOVERED: ExportColumnDef = { label: 'Discovered', accessor: 'lastDiscoveredAt' };
const RESOURCE_ID: ExportColumnDef = { label: 'Resource ID', accessor: 'resourceId' };
const ARN: ExportColumnDef = { label: 'ARN', accessor: 'resourceArn' };

/** Appended to every type — useful in spreadsheets even though grid embeds them */
const COMMON_TAIL = [REGION, ACCOUNT_NAME, ACCOUNT_ID, TAGS, DISCOVERED, RESOURCE_ID, ARN];
const COMMON_TAIL_NO_TAGS = [REGION, ACCOUNT_NAME, ACCOUNT_ID, DISCOVERED, RESOURCE_ID, ARN];

// ---------------------------------------------------------------------------
// Per-type column maps (order matches column-registry.tsx)
// ---------------------------------------------------------------------------

export const EXPORT_COLUMN_MAP: Record<string, ExportColumnDef[]> = {
    // EC2 Instances
    ec2_instances: [
        NAME, STATE,
        { label: 'Instance Type', accessor: 'metadata.instanceType' },
        { label: 'Private IP', accessor: 'metadata.privateIpAddress' },
        { label: 'Public IP', accessor: 'metadata.publicIpAddress' },
        { label: 'Platform', accessor: 'metadata.platform' },
        ...COMMON_TAIL,
    ],

    // Elastic IPs
    ec2_addresses: [
        NAME,
        { label: 'Public IP', accessor: 'metadata.publicIp' },
        { label: 'Allocation ID', accessor: 'metadata.allocationId' },
        { label: 'Attached To', accessor: 'metadata.associatedInstanceId' },
        ...COMMON_TAIL,
    ],

    // VPCs
    ec2_vpcs: [
        NAME, STATE,
        { label: 'CIDR Block', accessor: 'metadata.cidrBlock' },
        { label: 'Default', accessor: 'metadata.isDefault' },
        { label: 'Tenancy', accessor: 'metadata.instanceTenancy' },
        ...COMMON_TAIL,
    ],

    // Subnets
    ec2_subnets: [
        NAME, STATE,
        { label: 'CIDR Block', accessor: 'metadata.cidrBlock' },
        { label: 'AZ', accessor: 'metadata.availabilityZone' },
        { label: 'Available IPs', accessor: 'metadata.availableIpAddressCount' },
        { label: 'Auto-assign IP', accessor: 'metadata.mapPublicIpOnLaunch' },
        ...COMMON_TAIL,
    ],

    // Security Groups
    ec2_security_groups: [
        NAME,
        { label: 'Description', accessor: 'metadata.description' },
        { label: 'VPC', accessor: 'metadata.vpcId' },
        { label: 'Inbound Rules', accessor: 'metadata.inboundRulesCount' },
        { label: 'Outbound Rules', accessor: 'metadata.outboundRulesCount' },
        ...COMMON_TAIL,
    ],

    // Network Interfaces (ENIs)
    ec2_network_interfaces: [
        NAME, STATE,
        { label: 'Private IP', accessor: 'metadata.privateIpAddress' },
        { label: 'Public IP', accessor: 'metadata.publicIp' },
        { label: 'MAC Address', accessor: 'metadata.macAddress' },
        { label: 'Attached To', accessor: 'metadata.attachedTo' },
        ...COMMON_TAIL,
    ],

    // NAT Gateways
    ec2_nat_gateways: [
        NAME, STATE,
        { label: 'Public IP', accessor: 'metadata.publicIp' },
        { label: 'Private IP', accessor: 'metadata.privateIp' },
        { label: 'VPC', accessor: 'metadata.vpcId' },
        ...COMMON_TAIL,
    ],

    // EBS Volumes
    ec2_volumes: [
        NAME, STATE,
        { label: 'Type', accessor: 'metadata.volumeType' },
        { label: 'Size (GB)', accessor: 'metadata.size' },
        { label: 'IOPS', accessor: 'metadata.iops' },
        { label: 'Encrypted', accessor: 'metadata.encrypted' },
        { label: 'AZ', accessor: 'metadata.availabilityZone' },
        ...COMMON_TAIL,
    ],

    // Transit Gateways
    ec2_transit_gateways: [
        NAME, STATE,
        { label: 'Description', accessor: 'metadata.description' },
        { label: 'Owner', accessor: 'metadata.ownerId' },
        { label: 'ASN', accessor: 'metadata.amazonSideAsn' },
        ...COMMON_TAIL,
    ],

    // Transit Gateway Attachments
    ec2_transit_gateway_attachments: [
        NAME, STATE,
        { label: 'Resource Type', accessor: 'metadata.resourceType' },
        { label: 'Resource ID', accessor: 'metadata.resourceId' },
        { label: 'Transit Gateway', accessor: 'metadata.transitGatewayId' },
        ...COMMON_TAIL,
    ],

    // VPC Peering Connections
    ec2_vpc_peering_connections: [
        NAME, STATE,
        { label: 'Requester VPC', accessor: 'metadata.requesterVpcId' },
        { label: 'Requester CIDR', accessor: 'metadata.requesterCidr' },
        { label: 'Accepter VPC', accessor: 'metadata.accepterVpcId' },
        { label: 'Accepter CIDR', accessor: 'metadata.accepterCidr' },
        { label: 'Accepter Account', accessor: 'metadata.accepterOwnerId' },
        ...COMMON_TAIL,
    ],

    // RDS Instances
    rds_instances: [
        NAME, STATE,
        { label: 'Engine', accessor: 'metadata.engine' },
        { label: 'Version', accessor: 'metadata.engineVersion' },
        { label: 'Instance Class', accessor: 'metadata.dbInstanceClass' },
        { label: 'Multi-AZ', accessor: 'metadata.multiAZ' },
        { label: 'Endpoint', accessor: 'metadata.endpoint' },
        ...COMMON_TAIL,
    ],
    rds_db_instances: [
        NAME, STATE,
        { label: 'Engine', accessor: 'metadata.engine' },
        { label: 'Version', accessor: 'metadata.engineVersion' },
        { label: 'Instance Class', accessor: 'metadata.dbInstanceClass' },
        { label: 'Multi-AZ', accessor: 'metadata.multiAZ' },
        { label: 'Endpoint', accessor: 'metadata.endpoint' },
        ...COMMON_TAIL,
    ],

    // RDS Clusters (Aurora)
    rds_db_clusters: [
        NAME, STATE,
        { label: 'Engine', accessor: 'metadata.engine' },
        { label: 'Version', accessor: 'metadata.engineVersion' },
        { label: 'Multi-AZ', accessor: 'metadata.multiAZ' },
        { label: 'Endpoint', accessor: 'metadata.endpoint' },
        ...COMMON_TAIL,
    ],

    // DocumentDB
    docdb_instances: [
        NAME, STATE,
        { label: 'Engine Version', accessor: 'metadata.engineVersion' },
        { label: 'Encrypted', accessor: 'metadata.storageEncrypted' },
        ...COMMON_TAIL,
    ],
    docdb_db_clusters: [
        NAME, STATE,
        { label: 'Engine Version', accessor: 'metadata.engineVersion' },
        { label: 'Encrypted', accessor: 'metadata.storageEncrypted' },
        ...COMMON_TAIL,
    ],

    // ECS Clusters
    ecs_clusters: [
        NAME, STATE,
        { label: 'Services', accessor: 'metadata.activeServicesCount' },
        { label: 'Running Tasks', accessor: 'metadata.runningTasksCount' },
        { label: 'Instances', accessor: 'metadata.registeredContainerInstances' },
        { label: 'Capacity Providers', accessor: 'metadata.capacityProviders' },
        ...COMMON_TAIL,
    ],
    ecs_describe_clusters: [
        NAME, STATE,
        { label: 'Services', accessor: 'metadata.activeServicesCount' },
        { label: 'Running Tasks', accessor: 'metadata.runningTasksCount' },
        { label: 'Instances', accessor: 'metadata.registeredContainerInstances' },
        { label: 'Capacity Providers', accessor: 'metadata.capacityProviders' },
        ...COMMON_TAIL,
    ],

    // ECS Services
    ecs_services: [
        NAME, STATE,
        { label: 'Cluster', accessor: 'metadata.clusterArn' },
        { label: 'Desired', accessor: 'metadata.desiredCount' },
        { label: 'Running', accessor: 'metadata.runningCount' },
        { label: 'Launch Type', accessor: 'metadata.launchType' },
        ...COMMON_TAIL,
    ],
    ecs_describe_services: [
        NAME, STATE,
        { label: 'Cluster', accessor: 'metadata.clusterArn' },
        { label: 'Desired', accessor: 'metadata.desiredCount' },
        { label: 'Running', accessor: 'metadata.runningCount' },
        { label: 'Launch Type', accessor: 'metadata.launchType' },
        ...COMMON_TAIL,
    ],

    // Auto Scaling Groups
    asg_groups: [
        NAME,
        { label: 'Min', accessor: 'metadata.minSize' },
        { label: 'Desired', accessor: 'metadata.desiredCapacity' },
        { label: 'Max', accessor: 'metadata.maxSize' },
        { label: 'Launch Template', accessor: 'metadata.launchTemplate' },
        ...COMMON_TAIL,
    ],
    autoscaling_auto_scaling_groups: [
        NAME,
        { label: 'Min', accessor: 'metadata.minSize' },
        { label: 'Desired', accessor: 'metadata.desiredCapacity' },
        { label: 'Max', accessor: 'metadata.maxSize' },
        { label: 'Launch Template', accessor: 'metadata.launchTemplate' },
        ...COMMON_TAIL,
    ],

    // Lambda Functions
    lambda_functions: [
        NAME, STATE,
        { label: 'Runtime', accessor: 'metadata.runtime' },
        { label: 'Memory (MB)', accessor: 'metadata.memorySize' },
        { label: 'Timeout (s)', accessor: 'metadata.timeout' },
        ...COMMON_TAIL,
    ],

    // S3 Buckets
    s3_buckets: [
        NAME,
        { label: 'Versioning', accessor: 'metadata.versioning' },
        { label: 'Encryption', accessor: 'metadata.encryption' },
        ...COMMON_TAIL,
    ],

    // Load Balancers
    elbv2_load_balancers: [
        NAME, STATE,
        { label: 'Type', accessor: 'metadata.type' },
        { label: 'DNS Name', accessor: 'metadata.dnsName' },
        { label: 'Scheme', accessor: 'metadata.scheme' },
        ...COMMON_TAIL,
    ],

    // ElastiCache
    elasticache_cache_clusters: [
        NAME, STATE,
        { label: 'Engine', accessor: 'metadata.engine' },
        { label: 'Version', accessor: 'metadata.engineVersion' },
        { label: 'Node Type', accessor: 'metadata.cacheNodeType' },
        { label: 'Nodes', accessor: 'metadata.numCacheNodes' },
        ...COMMON_TAIL,
    ],

    // EFS File Systems
    efs_file_systems: [
        NAME,
        { label: 'State', accessor: 'metadata.lifecycleState' },
        { label: 'Performance', accessor: 'metadata.performanceMode' },
        { label: 'Throughput', accessor: 'metadata.throughputMode' },
        { label: 'Encrypted', accessor: 'metadata.encrypted' },
        ...COMMON_TAIL,
    ],

    // KMS Keys
    kms_keys: [
        NAME,
        { label: 'Enabled', accessor: 'metadata.enabled' },
        { label: 'State', accessor: 'metadata.keyState' },
        { label: 'Manager', accessor: 'metadata.keyManager' },
        { label: 'Key Spec', accessor: 'metadata.keySpec' },
        { label: 'Description', accessor: 'metadata.description' },
        ...COMMON_TAIL,
    ],

    // ACM Certificates
    acm_certificates: [
        NAME,
        { label: 'Domain', accessor: 'metadata.domainName' },
        { label: 'Status', accessor: 'metadata.status' },
        { label: 'Issuer', accessor: 'metadata.issuer' },
        { label: 'Expires', accessor: 'metadata.notAfter' },
        ...COMMON_TAIL,
    ],

    // ECR Repositories
    ecr_repositories: [
        NAME,
        { label: 'Repository URI', accessor: 'metadata.repositoryUri' },
        { label: 'Tag Mutability', accessor: 'metadata.imageTagMutability' },
        ...COMMON_TAIL,
    ],

    // CloudFront Distributions
    cloudfront_distributions: [
        NAME,
        { label: 'Domain Name', accessor: 'metadata.domainName' },
        { label: 'Status', accessor: 'metadata.status' },
        { label: 'Aliases', accessor: 'metadata.aliases' },
        ...COMMON_TAIL,
    ],

    // DynamoDB Tables
    dynamodb_tables: [
        NAME,
        { label: 'Status', accessor: 'metadata.tableStatus' },
        { label: 'Items', accessor: 'metadata.itemCount' },
        { label: 'Size (bytes)', accessor: 'metadata.tableSizeBytes' },
        { label: 'Billing', accessor: 'metadata.billingMode' },
        ...COMMON_TAIL,
    ],

    // SSM Parameters (no Tags column in grid)
    ssm_parameters: [
        NAME,
        { label: 'Type', accessor: 'metadata.type' },
        { label: 'Tier', accessor: 'metadata.tier' },
        { label: 'Version', accessor: 'metadata.version' },
        ...COMMON_TAIL_NO_TAGS,
    ],

    // IAM Roles
    iam_roles: [
        NAME,
        { label: 'Path', accessor: 'metadata.path' },
        { label: 'Created', accessor: 'metadata.createDate' },
        { label: 'Description', accessor: 'metadata.description' },
        ...COMMON_TAIL,
    ],

    // IAM Users
    iam_users: [
        NAME,
        { label: 'Path', accessor: 'metadata.path' },
        { label: 'Created', accessor: 'metadata.createDate' },
        { label: 'Description', accessor: 'metadata.description' },
        ...COMMON_TAIL,
    ],

    // EKS Clusters
    eks_clusters: [
        NAME, STATE,
        { label: 'K8s Version', accessor: 'metadata.version' },
        { label: 'Platform', accessor: 'metadata.platformVersion' },
        { label: 'Endpoint', accessor: 'metadata.endpoint' },
        ...COMMON_TAIL,
    ],

    // CloudWatch Alarms
    cloudwatch_metric_alarms: [
        NAME, STATE,
        { label: 'Metric', accessor: 'metadata.metricName' },
        { label: 'Namespace', accessor: 'metadata.namespace' },
        { label: 'Threshold', accessor: 'metadata.threshold' },
        ...COMMON_TAIL,
    ],

    // WAFv2 Web ACLs
    wafv2_web_acls: [
        NAME, STATE,
        { label: 'Scope', accessor: 'metadata.scope' },
        { label: 'Description', accessor: 'metadata.description' },
        { label: 'Firewall Manager', accessor: 'metadata.managedByFirewallManager' },
        ...COMMON_TAIL,
    ],

    // Default — used when "All Types" is selected or type is unknown
    _default: [
        NAME,
        { label: 'Service', accessor: 'service' },
        { label: 'Type', accessor: 'resourceType' },
        STATE, REGION, ACCOUNT_NAME, ACCOUNT_ID, TAGS, DISCOVERED, RESOURCE_ID, ARN,
    ],
};

/**
 * Returns the export column definitions for a given resource type.
 * Falls back to _default when the type is unknown or not provided.
 */
export function getExportColumnsForType(resourceType: string): ExportColumnDef[] {
    return EXPORT_COLUMN_MAP[resourceType] ?? EXPORT_COLUMN_MAP._default;
}

/**
 * Resolves a column accessor path against a resource object and returns a string value.
 * Handles special accessors ("tags", "service"), dot-paths ("metadata.instanceType"),
 * top-level fields, booleans, and arrays.
 */
export function resolveExportValue(
    resource: Record<string, unknown>,
    accessor: string
): string {
    // Special: tags → JSON string
    if (accessor === 'tags') {
        const tags = resource.tags;
        if (!tags || typeof tags !== 'object') return '';
        return JSON.stringify(tags);
    }

    // Special: service → computed from resourceType
    if (accessor === 'service') {
        return getServiceName(resource.resourceType as string);
    }

    // Dot-path resolution (e.g. "metadata.instanceType")
    const parts = accessor.split('.');
    let value: unknown = resource;
    for (const part of parts) {
        if (value == null || typeof value !== 'object') return '';
        value = (value as Record<string, unknown>)[part];
    }

    if (value == null) return '';
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    if (Array.isArray(value)) return value.join(', ');
    return String(value);
}
