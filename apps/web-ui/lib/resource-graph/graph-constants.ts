export const SEED_NODE_CAP = 1500;
// Deliberately not MAX_LIMIT: the measured p90 account carries 970 edges and the largest
// 1,725, so a 500-edge cap would silently drop edges from real accounts.
export const SEED_EDGE_CAP = 4000;
export const EXPAND_CAP = 50;
export const DEFAULT_PATH_DEPTH = 4;
export const DEFAULT_QUERY_LIMIT = 500;

// Measured 2026-08-25: 3,017 rows tenant-wide, roughly 30 per account. Leaf types
// (instances, volumes, network interfaces) are deliberately absent — they arrive by
// expansion, not by seeding.
export const STRUCTURAL_TYPES = [
    'ec2_vpcs',
    'ec2_subnets',
    'ec2_nat_gateways',
    'ec2_transit_gateways',
    'elbv2_load_balancers',
    'elbv2_targroups',
    'rds_db_instances',
    'rds_db_clusters',
    'docdb_db_clusters',
    'elasticache_cache_clusters',
    'ecs_clusters',
    'ecs_services',
    'eks_clusters',
    'autoscaling_auto_scaling_groups',
    'cloudfront_distributions',
] as const;

// 29,403 of 49,975 measured resources, almost none of them connected to anything a
// human would put on a canvas.
export const HIDDEN_NODE_TYPES = ['ssm_parameters', 'iam_roles'] as const;

export const OBSERVATION_RELATIONS = ['monitors', 'notifies'] as const;

// One node, alias/aws/ssm, carried 9,294 of 34,815 edges. Excluding AWS-managed key
// aliases drops the maximum degree in the graph from 9,294 to 237.
export const AWS_MANAGED_KEY_PREFIX = 'alias/aws/';

// The types CloudWatch alarms can name in a Dimension, mirroring DIMENSION_TO_TYPE in
// the workers' edge-derivers. A type absent here cannot be "unmonitored", it is simply
// not monitorable, and reporting it as a gap would be noise.
export const MONITORABLE_TYPES = [
    'ec2_instances',
    'rds_db_instances',
    'rds_db_clusters',
    'autoscaling_auto_scaling_groups',
    'lambda_functions',
    'dynamodb_tables',
    'elasticache_cache_clusters',
    's3_buckets',
    'efs_file_systems',
    'sqs_queues',
    'ecs_clusters',
] as const;

export type GraphPredicate =
    | { kind: 'by-type'; resourceType: string }
    | { kind: 'by-vpc'; vpcId: string }
    | { kind: 'internet-facing' }
    | { kind: 'unmonitored' }
    | { kind: 'isolated' };

export interface GraphFilters {
    accountId?: string;
    includeAwsManagedKeys?: boolean;
    includeHiddenTypes?: boolean;
    includeObservation?: boolean;
}

export function isHiddenType(resourceType: string, filters: GraphFilters): boolean {
    if (filters.includeHiddenTypes) return false;
    return (HIDDEN_NODE_TYPES as readonly string[]).includes(resourceType);
}
