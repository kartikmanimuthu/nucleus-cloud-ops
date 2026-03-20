/**
 * Shared resource type definitions and helpers for the inventory module.
 * Single source of truth — replaces duplicated mappings across page.tsx,
 * resource-detail-dialog.tsx, and export/route.ts.
 */

export const RESOURCE_TYPE_LABELS: Record<string, string> = {
    ec2_instances: "EC2 Instances",
    rds_db_instances: "RDS Instances",
    docdb_db_clusters: "DocumentDB Clusters",
    autoscaling_auto_scaling_groups: "Auto Scaling Groups",
    ecs_clusters: "ECS Clusters",
    ecs_services: "ECS Services",
    ec2_addresses: "Elastic IPs",
    ec2_nat_gateways: "NAT Gateways",
    ec2_security_groups: "Security Groups",
    ec2_subnets: "Subnets",
    ec2_network_interfaces: "Elastic Network Interfaces",
    ec2_vpcs: "VPCs",
    lambda_functions: "Lambda Functions",
    dynamodb_tables: "DynamoDB Tables",
    acm_certificates: "ACM Certificates",
    apigateway_rest_apis: "API Gateway REST APIs",
    kms_keys: "KMS Keys",
    s3_buckets: "S3 Buckets",
    sns_topics: "SNS Topics",
    sqs_queues: "SQS Queues",
    ecr_repositories: "ECR Repositories",
    // EBS
    ec2_volumes: "EBS Volumes",
    // Load Balancers
    elbv2_load_balancers: "Load Balancers",
    // Caching & Messaging
    elasticache_cache_clusters: "ElastiCache Clusters",
    // Storage
    efs_file_systems: "EFS File Systems",
    // Database
    rds_db_clusters: "RDS Clusters",
    // Security & Config
    secretsmanager_secrets: "Secrets Manager",
    // DevOps
    codepipeline_pipelines: "CodePipeline Pipelines",
    ssm_parameters: "SSM Parameters",
    // CDN
    cloudfront_distributions: "CloudFront Distributions",
    // IAM
    iam_roles: "IAM Roles",
    iam_users: "IAM Users",
    // Container
    eks_clusters: "EKS Clusters",
    // Observability
    cloudwatch_metric_alarms: "CloudWatch Alarms",
    events_rules: "EventBridge Rules",
    // Networking Advanced
    ec2_transit_gateways: "Transit Gateways",
    ec2_transit_gateway_attachments: "Transit Gateway Attachments",
    ec2_vpc_peering_connections: "VPC Peering Connections",
    // Security
    wafv2_web_acls: "WAF Web ACLs",
    backup_backup_plans: "Backup Plans",
};

export const SERVICE_NAME_MAP: Record<string, string> = {
    ec2_instances: "EC2",
    rds_db_instances: "RDS",
    rds_instances: "RDS",
    ecs_clusters: "ECS",
    ecs_services: "ECS",
    ec2_addresses: "EC2",
    ec2_nat_gateways: "EC2",
    ec2_security_groups: "EC2",
    ec2_subnets: "EC2",
    ec2_network_interfaces: "EC2",
    ec2_vpcs: "EC2",
    lambda_functions: "Lambda",
    autoscaling_auto_scaling_groups: "Auto Scaling",
    asg_groups: "Auto Scaling",
    dynamodb_tables: "DynamoDB",
    docdb_db_clusters: "DocumentDB",
    docdb_instances: "DocumentDB",
    acm_certificates: "ACM",
    apigateway_rest_apis: "API Gateway",
    kms_keys: "KMS",
    s3_buckets: "S3",
    sns_topics: "SNS",
    sqs_queues: "SQS",
    ecr_repositories: "ECR",
    ec2_volumes: "EC2",
    elbv2_load_balancers: "ELB",
    elasticache_cache_clusters: "ElastiCache",
    efs_file_systems: "EFS",
    rds_db_clusters: "RDS",
    secretsmanager_secrets: "Secrets Manager",
    codepipeline_pipelines: "CodePipeline",
    ssm_parameters: "SSM",
    cloudfront_distributions: "CloudFront",
    iam_roles: "IAM",
    iam_users: "IAM",
    eks_clusters: "EKS",
    cloudwatch_metric_alarms: "CloudWatch",
    events_rules: "EventBridge",
    ec2_transit_gateways: "EC2",
    ec2_transit_gateway_attachments: "EC2",
    ec2_vpc_peering_connections: "EC2",
    wafv2_web_acls: "WAF",
    backup_backup_plans: "Backup",
};

export function getServiceName(resourceType: string): string {
    return SERVICE_NAME_MAP[resourceType] ?? resourceType.replace(/_/g, " ").toUpperCase();
}

export const RESOURCE_TYPE_OPTIONS = [
    { value: "all", label: "All Types" },
    ...Object.entries(RESOURCE_TYPE_LABELS).map(([value, label]) => ({ value, label })),
];

export const REGION_OPTIONS = [
    { value: "all", label: "All Regions" },
    { value: "us-east-1", label: "US East (N. Virginia)" },
    { value: "us-east-2", label: "US East (Ohio)" },
    { value: "us-west-1", label: "US West (N. California)" },
    { value: "us-west-2", label: "US West (Oregon)" },
    { value: "eu-west-1", label: "Europe (Ireland)" },
    { value: "eu-west-2", label: "Europe (London)" },
    { value: "eu-central-1", label: "Europe (Frankfurt)" },
    { value: "ap-south-1", label: "Asia Pacific (Mumbai)" },
    { value: "ap-southeast-1", label: "Asia Pacific (Singapore)" },
    { value: "ap-southeast-2", label: "Asia Pacific (Sydney)" },
    { value: "ap-northeast-1", label: "Asia Pacific (Tokyo)" },
    { value: "sa-east-1", label: "South America (São Paulo)" },
    { value: "ca-central-1", label: "Canada (Central)" },
];

export function getAwsConsoleUrl(resource: {
    resourceType: string;
    region: string;
    resourceId: string;
    resourceArn: string;
}): string | null {
    const { resourceType, region, resourceId, resourceArn } = resource;
    const base = `https://${region}.console.aws.amazon.com`;

    switch (resourceType) {
        case "ec2_instances":
            return `${base}/ec2/home?region=${region}#Instances:instanceId=${resourceId}`;
        case "rds_db_instances":
        case "rds_instances":
            return `${base}/rds/home?region=${region}#database:id=${resourceId}`;
        case "ecs_clusters":
            return `${base}/ecs/v2/clusters/${resourceId}?region=${region}`;
        case "ecs_services": {
            const m = resourceArn.match(/cluster\/([^/]+)\/service\/([^/]+)/);
            return m
                ? `${base}/ecs/v2/clusters/${m[1]}/services/${m[2]}?region=${region}`
                : `${base}/ecs/v2/clusters?region=${region}`;
        }
        case "autoscaling_auto_scaling_groups":
        case "asg_groups":
            return `${base}/ec2autoscaling/home?region=${region}#/details/${resourceId}`;
        case "dynamodb_tables":
            return `${base}/dynamodb/home?region=${region}#table?name=${resourceId}`;
        case "docdb_db_clusters":
        case "docdb_instances":
            return `${base}/docdb/home?region=${region}#cluster-details/${resourceId}`;
        case "lambda_functions":
            return `${base}/lambda/home?region=${region}#/functions/${resourceId}`;
        case "s3_buckets":
            return `https://s3.console.aws.amazon.com/s3/buckets/${resourceId}`;
        case "apigateway_rest_apis":
            return `${base}/apigateway/home?region=${region}#/apis/${resourceId}/resources`;
        case "ecr_repositories":
            return `${base}/ecr/repositories/private/${resourceId}?region=${region}`;
        case "sns_topics":
            return `${base}/sns/v3/home?region=${region}#/topics/${resourceArn}`;
        case "sqs_queues":
            return `${base}/sqs/v3/home?region=${region}#/queues/${encodeURIComponent(resourceArn)}`;
        case "ec2_vpcs":
            return `${base}/vpc/home?region=${region}#vpcs:VpcId=${resourceId}`;
        case "ec2_security_groups":
            return `${base}/ec2/home?region=${region}#SecurityGroups:groupId=${resourceId}`;
        case "ec2_subnets":
            return `${base}/vpc/home?region=${region}#subnets:SubnetId=${resourceId}`;
        case "kms_keys":
            return `${base}/kms/home?region=${region}#/kms/keys/${resourceId}`;
        case "acm_certificates":
            return `${base}/acm/home?region=${region}#/certificates/${resourceId}`;
        case "ec2_volumes":
            return `${base}/ec2/home?region=${region}#Volumes:volumeId=${resourceId}`;
        case "ec2_network_interfaces":
            return `${base}/ec2/home?region=${region}#NetworkInterfaces:networkInterfaceId=${resourceId}`;
        case "ec2_nat_gateways":
            return `${base}/vpc/home?region=${region}#NatGateways:natGatewayId=${resourceId}`;
        case "ec2_transit_gateways":
            return `${base}/vpc/home?region=${region}#TransitGateways:transitGatewayId=${resourceId}`;
        case "ec2_transit_gateway_attachments":
            return `${base}/vpc/home?region=${region}#TransitGatewayAttachments:transitGatewayAttachmentId=${resourceId}`;
        case "ec2_vpc_peering_connections":
            return `${base}/vpc/home?region=${region}#PeeringConnections:vpcPeeringConnectionId=${resourceId}`;
        case "wafv2_web_acls":
            return `${base}/wafv2/homev2/home?region=${region}#/webacls`;
        case "elbv2_load_balancers":
            return `${base}/ec2/home?region=${region}#LoadBalancers:search=${resourceId}`;
        case "elasticache_cache_clusters":
            return `${base}/elasticache/home?region=${region}#/redis/${resourceId}`;
        case "efs_file_systems":
            return `${base}/efs/home?region=${region}#/file-systems/${resourceId}`;
        case "rds_db_clusters":
            return `${base}/rds/home?region=${region}#database:id=${resourceId}`;
        case "secretsmanager_secrets":
            return `${base}/secretsmanager/home?region=${region}#/secret?name=${encodeURIComponent(resourceId)}`;
        case "codepipeline_pipelines":
            return `${base}/codesuite/codepipeline/home?region=${region}#/view/${resourceId}`;
        case "ssm_parameters":
            return `${base}/systems-manager/parameters${resourceId}?region=${region}&tab=Table`;
        case "cloudfront_distributions":
            return `https://us-east-1.console.aws.amazon.com/cloudfront/v4/home#/distributions/${resourceId}`;
        case "iam_roles":
            return `https://us-east-1.console.aws.amazon.com/iam/home#/roles/${resourceId}`;
        case "iam_users":
            return `https://us-east-1.console.aws.amazon.com/iam/home#/users/${resourceId}`;
        case "eks_clusters":
            return `${base}/eks/home?region=${region}#/clusters/${resourceId}`;
        case "cloudwatch_metric_alarms":
            return `${base}/cloudwatch/home?region=${region}#alarmsV2:alarm/${encodeURIComponent(resourceId)}`;
        case "events_rules":
            return `${base}/events/home?region=${region}#/rules/${resourceId}`;
        case "backup_backup_plans":
            return `${base}/backup/home?region=${region}#/backupplans/${resourceId}`;
        default:
            return null;
    }
}
