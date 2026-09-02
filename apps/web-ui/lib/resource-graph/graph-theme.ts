export const NODE_KIND = {
    account: 'account',
    hub: 'hub',
    resource: 'resource',
} as const;

export type NodeKind = (typeof NODE_KIND)[keyof typeof NODE_KIND];

// Two disjoint transit-gateway networks exist in a real estate, so the opening view needs
// hue FAMILIES, not one colour: a hub and its spokes share a hue so the eye separates the
// networks instantly. Standalone accounts stay chromatically silent so they read as "not
// part of either network" rather than as a third network.
// Spokes are only a shade lighter than their hub, not a pastel: at 30px on white, a tint
// like #a5b4fc reads as grey and the whole picture goes colourless.
export const HUB_PALETTE = ['#4f46e5', '#d97706', '#db2777', '#0d9488', '#7c3aed'] as const;
export const SPOKE_PALETTE = ['#6366f1', '#f59e0b', '#ec4899', '#14b8a6', '#a855f7'] as const;
export const STANDALONE_ACCOUNT_COLOR = '#64748b';

export function hubColor(group: number): string {
    return HUB_PALETTE[group % HUB_PALETTE.length];
}

export function spokeColor(group: number | null): string {
    return group === null ? STANDALONE_ACCOUNT_COLOR : SPOKE_PALETTE[group % SPOKE_PALETTE.length];
}

export const RESOURCE_TYPE_COLORS: Record<string, string> = {
    ec2_instances: '#f59e0b',
    ec2_vpcs: '#6366f1',
    ec2_subnets: '#818cf8',
    ec2_security_groups: '#ef4444',
    ec2_volumes: '#a855f7',
    ec2_network_interfaces: '#c084fc',
    ec2_nat_gateways: '#8b5cf6',
    ec2_transit_gateways: '#4f46e5',
    elbv2_load_balancers: '#10b981',
    elbv2_targroups: '#34d399',
    rds_db_instances: '#0ea5e9',
    rds_db_clusters: '#0284c7',
    docdb_db_clusters: '#0369a1',
    elasticache_cache_clusters: '#06b6d4',
    ecs_clusters: '#f97316',
    ecs_services: '#fb923c',
    eks_clusters: '#ea580c',
    lambda_functions: '#eab308',
    s3_buckets: '#22c55e',
    dynamodb_tables: '#14b8a6',
    kms_keys: '#64748b',
    iam_roles: '#94a3b8',
    cloudfront_distributions: '#ec4899',
    acm_certificates: '#f472b6',
    autoscaling_auto_scaling_groups: '#d946ef',
    __account: '#0f766e',
    __fallback: '#71717a',
};

export function colorForType(resourceType: string): string {
    return RESOURCE_TYPE_COLORS[resourceType] ?? RESOURCE_TYPE_COLORS.__fallback;
}

// A graph reads as a diagram rather than a dot plot when every node carries a glyph.
// Cytoscape accepts a background-image, so glyphs are generated as inline SVG data URIs
// tinted with the node's own colour — no icon library, no network request, no sprite sheet.
const GLYPHS = {
    compute: '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1" fill="#fff" fill-opacity=".65"/>',
    database: '<ellipse cx="12" cy="7" rx="6.5" ry="2.8"/><path d="M5.5 7v9.5c0 1.6 2.9 2.8 6.5 2.8s6.5-1.2 6.5-2.8V7" fill="none" stroke-width="2"/>',
    network: '<circle cx="12" cy="4.8" r="2.4"/><circle cx="5" cy="18.5" r="2.4"/><circle cx="19" cy="18.5" r="2.4"/><path d="M12 7.6v3.6M11 12l-5 4.2M13 12l5 4.2" fill="none" stroke-width="1.7"/>',
    storage: '<path d="M12 3.5l8 3.8-8 3.8-8-3.8z"/><path d="M4 12l8 3.8 8-3.8M4 16.5l8 3.8 8-3.8" fill="none" stroke-width="1.7"/>',
    security: '<path d="M12 3l7 2.8v5.6c0 4.2-2.9 7.7-7 9.1-4.1-1.4-7-4.9-7-9.1V5.8z"/>',
    container: '<rect x="3.5" y="10" width="5.6" height="5.6" rx="1"/><rect x="10.2" y="10" width="5.6" height="5.6" rx="1"/><rect x="6.8" y="4" width="5.6" height="5" rx="1"/>',
    serverless: '<path d="M13.5 2.5L5 13.8h5.6L9.2 21.5 19 10.2h-5.9z"/>',
    balancer: '<circle cx="12" cy="4.6" r="2.3"/><path d="M12 7v3.6M4.5 20v-4h15v4M12 10.6v5.4" fill="none" stroke-width="1.8"/>',
    identity: '<circle cx="12" cy="8.6" r="3.3"/><path d="M5.2 20c0-3.8 3-6.8 6.8-6.8s6.8 3 6.8 6.8" fill="none" stroke-width="1.9"/>',
    generic: '<circle cx="12" cy="12" r="6.5"/>',
} as const;

const TYPE_GLYPH: Record<string, keyof typeof GLYPHS> = {
    ec2_instances: 'compute',
    lambda_functions: 'serverless',
    ecs_services: 'container',
    ecs_clusters: 'container',
    eks_clusters: 'container',
    rds_db_instances: 'database',
    rds_db_clusters: 'database',
    docdb_db_clusters: 'database',
    dynamodb_tables: 'database',
    elasticache_cache_clusters: 'database',
    ec2_vpcs: 'network',
    ec2_subnets: 'network',
    ec2_nat_gateways: 'network',
    ec2_transit_gateways: 'network',
    ec2_network_interfaces: 'network',
    elbv2_load_balancers: 'balancer',
    elbv2_targroups: 'balancer',
    autoscaling_auto_scaling_groups: 'balancer',
    cloudfront_distributions: 'balancer',
    s3_buckets: 'storage',
    ec2_volumes: 'storage',
    ec2_security_groups: 'security',
    kms_keys: 'security',
    acm_certificates: 'security',
    iam_roles: 'identity',
    iam_users: 'identity',
};

export function iconDataUri(glyph: keyof typeof GLYPHS, color: string): string {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="${color}" stroke="${color}" stroke-linejoin="round">${GLYPHS[glyph]}</svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export function iconForType(resourceType: string, color: string): string {
    return iconDataUri(TYPE_GLYPH[resourceType] ?? 'generic', color);
}

export function accountIcon(color: string): string {
    return iconDataUri('identity', color);
}

export function hubIcon(color: string): string {
    return iconDataUri('network', color);
}

// Human-facing type label, e.g. ec2_instances -> EC2 Instance. The sub-label under each
// node is what turns an anonymous circle into something a reader can identify at a glance.
const SERVICE_LABEL: Record<string, string> = {
    ec2: 'EC2', rds: 'RDS', elbv2: 'ELB', ecs: 'ECS', eks: 'EKS', s3: 'S3',
    iam: 'IAM', kms: 'KMS', acm: 'ACM', docdb: 'DocumentDB', dynamodb: 'DynamoDB',
    elasticache: 'ElastiCache', lambda: 'Lambda', cloudfront: 'CloudFront',
    autoscaling: 'Auto Scaling', cloudwatch: 'CloudWatch', sns: 'SNS', sqs: 'SQS',
    efs: 'EFS', ecr: 'ECR', ssm: 'SSM', wafv2: 'WAF', events: 'EventBridge',
    secretsmanager: 'Secrets Manager', codepipeline: 'CodePipeline',
};

export function typeLabel(resourceType: string): string {
    const [service, ...rest] = resourceType.split('_');
    const prefix = SERVICE_LABEL[service] ?? service.toUpperCase();
    const noun = rest
        .join(' ')
        .replace(/s$/, '')
        .replace(/\b\w/g, (c) => c.toUpperCase());
    return noun ? `${prefix} ${noun}` : prefix;
}
