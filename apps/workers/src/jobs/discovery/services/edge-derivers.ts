import type { ResourceEdge } from '../types.js';

export type DeriverContext = { accountId: string; region: string };
type Deriver = (raw: Record<string, any>, fromId: string, ctx: DeriverContext) => ResourceEdge[];

type DimensionMapping = string | { toType: string; toId: (value: string, ctx: DeriverContext) => string };

// LoadBalancer/TargetGroup dimension values are the tail of the resource's ARN (AWS's own
// documented format), while elbv2_load_balancers/elbv2_targroups are inventoried on the full
// ARN — verified against real inventory rows. The two tails are NOT the same shape: the
// LoadBalancer value omits the "loadbalancer/" resource-type segment (e.g. app/name/id) but
// the TargetGroup value already includes "targetgroup/" (e.g. targetgroup/name/id) — confirmed
// against AWS's own CLI example in the CloudWatch metrics docs. Get this wrong and every edge
// is dangling.
const DIMENSION_TO_TYPE: Record<string, DimensionMapping> = {
    InstanceId: 'ec2_instances',
    DBInstanceIdentifier: 'rds_db_instances',
    DBClusterIdentifier: 'rds_db_clusters',
    AutoScalingGroupName: 'autoscaling_auto_scaling_groups',
    FunctionName: 'lambda_functions',
    TableName: 'dynamodb_tables',
    CacheClusterId: 'elasticache_cache_clusters',
    BucketName: 's3_buckets',
    FileSystemId: 'efs_file_systems',
    QueueName: 'sqs_queues',
    ClusterName: 'ecs_clusters',
    LoadBalancer: {
        toType: 'elbv2_load_balancers',
        toId: (value, ctx) => `arn:aws:elasticloadbalancing:${ctx.region}:${ctx.accountId}:loadbalancer/${value}`,
    },
    TargetGroup: {
        toType: 'elbv2_targroups',
        toId: (value, ctx) => `arn:aws:elasticloadbalancing:${ctx.region}:${ctx.accountId}:${value}`,
    },
};

const cloudwatchAlarms: Deriver = (raw, fromId, ctx) => {
    const edges: ResourceEdge[] = [];

    for (const dim of raw.Dimensions || []) {
        const mapping = DIMENSION_TO_TYPE[dim?.Name];
        if (!mapping || !dim?.Value) continue;
        const toType = typeof mapping === 'string' ? mapping : mapping.toType;
        const toId = typeof mapping === 'string' ? dim.Value : mapping.toId(dim.Value, ctx);
        edges.push({
            fromType: 'cloudwatch_alarms',
            fromId,
            relation: 'monitors',
            toType,
            toId,
        });
    }

    for (const action of raw.AlarmActions || []) {
        if (typeof action !== 'string' || !action.startsWith('arn:aws:sns:')) continue;
        edges.push({
            fromType: 'cloudwatch_alarms',
            fromId,
            relation: 'notifies',
            toType: 'sns_topics',
            toId: action,
        });
    }

    return edges;
};

const S3_ORIGIN = /^(.+?)\.s3[.-](?:[a-z0-9-]+\.)?amazonaws\.com$/;

const cloudfrontDistributions: Deriver = (raw, fromId) => {
    const edges: ResourceEdge[] = [];

    for (const origin of raw.Origins?.Items || []) {
        const match = S3_ORIGIN.exec(origin?.DomainName || '');
        if (!match) continue;
        edges.push({
            fromType: 'cloudfront_distributions',
            fromId,
            relation: 'origin_is',
            toType: 's3_buckets',
            toId: match[1],
        });
    }

    return edges;
};

const ARN_SERVICE_TO_TYPE: Record<string, string> = {
    lambda: 'lambda_functions',
    sqs: 'sqs_queues',
    sns: 'sns_topics',
    ecs: 'ecs_clusters',
};

// inventory_resources.resourceId shape differs by type: lambda/sqs are keyed on
// the short name, sns/ecs are keyed on the full ARN (see extractResourceIdentifiers
// in scanner.ts, which prefers TopicArn/clusterArn over any name key).
const FULL_ARN_TYPES = new Set(['sns_topics', 'ecs_clusters']);

function arnResourceName(resource: string): string {
    if (resource.includes('/')) return resource.split('/').pop()!;
    if (resource.includes(':')) return resource.split(':')[1];
    return resource;
}

const eventsRules: Deriver = (raw, fromId) => {
    const edges: ResourceEdge[] = [];
    const targets = raw._targets;
    if (!Array.isArray(targets)) return edges;

    for (const target of targets) {
        const arn = target?.Arn;
        if (typeof arn !== 'string') continue;
        const parts = arn.split(':');
        const toType = ARN_SERVICE_TO_TYPE[parts[2]];
        if (!toType) continue;
        edges.push({
            fromType: 'events_rules',
            fromId,
            relation: 'triggers',
            toType,
            toId: FULL_ARN_TYPES.has(toType) ? arn : arnResourceName(parts.slice(5).join(':')),
        });
    }

    return edges;
};

// Keyed on actionTypeId.provider, not on configuration key names alone: CodeCommit and
// ECR both use a "RepositoryName" key, but only ECR has an inventory type to join against.
const CODEPIPELINE_ACTION_TARGETS: Record<string, { configKey: string; relation: string; toType: string }> = {
    ECR: { configKey: 'RepositoryName', relation: 'sourced_from', toType: 'ecr_repositories' },
    Lambda: { configKey: 'FunctionName', relation: 'invokes', toType: 'lambda_functions' },
    S3: { configKey: 'BucketName', relation: 'deploys_to', toType: 's3_buckets' },
};

const codepipelinePipelines: Deriver = (raw, fromId) => {
    const edges: ResourceEdge[] = [];

    const artifactBucket = raw.artifactStore?.location;
    if (typeof artifactBucket === 'string' && artifactBucket) {
        edges.push({
            fromType: 'codepipeline_pipelines',
            fromId,
            relation: 'stores_artifacts_in',
            toType: 's3_buckets',
            toId: artifactBucket,
        });
    }

    for (const stage of raw.stages || []) {
        for (const action of stage?.actions || []) {
            const mapping = CODEPIPELINE_ACTION_TARGETS[action?.actionTypeId?.provider];
            if (!mapping) continue;
            const toId = action?.configuration?.[mapping.configKey];
            if (!toId) continue;
            edges.push({
                fromType: 'codepipeline_pipelines',
                fromId,
                relation: mapping.relation,
                toType: mapping.toType,
                toId,
            });
        }
    }

    return edges;
};

const s3BucketNotifications: Deriver = (raw, fromId) => {
    const edges: ResourceEdge[] = [];
    const arns = [
        ...(raw.LambdaFunctionConfigurations || []).map((c: any) => c?.LambdaFunctionArn),
        ...(raw.QueueConfigurations || []).map((c: any) => c?.QueueArn),
        ...(raw.TopicConfigurations || []).map((c: any) => c?.TopicArn),
    ];

    for (const arn of arns) {
        if (typeof arn !== 'string') continue;
        const parts = arn.split(':');
        const toType = ARN_SERVICE_TO_TYPE[parts[2]];
        if (!toType) continue;
        edges.push({
            fromType: 's3_buckets',
            fromId,
            relation: 'notifies_on_event',
            toType,
            toId: FULL_ARN_TYPES.has(toType) ? arn : arnResourceName(parts.slice(5).join(':')),
        });
    }

    return edges;
};

// Only the account's own ECR registry host is matched — public/third-party images (nginx:latest,
// public.ecr.aws/...) and other accounts' registries fall through to null rather than a guessed edge.
// A tag or digest suffix is required: an unqualified reference (no ":tag" or "@digest") is not
// enough to positively identify what was actually pulled, so it resolves to null too.
const ECR_IMAGE = /^(\d{12})\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/(.+)$/;

function ecrRepositoryFromImage(image: string): { accountId: string; repoName: string } | null {
    const match = ECR_IMAGE.exec(image);
    if (!match) return null;
    const [, accountId, pathAndRef] = match;

    const digestIdx = pathAndRef.indexOf('@');
    if (digestIdx !== -1) return { accountId, repoName: pathAndRef.slice(0, digestIdx) };

    const tagIdx = pathAndRef.lastIndexOf(':');
    if (tagIdx === -1) return null;
    return { accountId, repoName: pathAndRef.slice(0, tagIdx) };
}

const ecsServiceImages: Deriver = (raw, fromId, ctx) => {
    const edges: ResourceEdge[] = [];

    for (const image of raw._images || []) {
        if (typeof image !== 'string') continue;
        const parsed = ecrRepositoryFromImage(image);
        if (!parsed || parsed.accountId !== ctx.accountId) continue;
        edges.push({
            fromType: 'ecs_services',
            fromId,
            relation: 'runs_image_from',
            toType: 'ecr_repositories',
            toId: parsed.repoName,
        });
    }

    return edges;
};

export const CUSTOM_DERIVERS: Record<string, Deriver> = {
    cloudwatch_alarms: cloudwatchAlarms,
    cloudfront_distributions: cloudfrontDistributions,
    events_rules: eventsRules,
    codepipeline_pipelines: codepipelinePipelines,
    s3_buckets: s3BucketNotifications,
    ecs_services: ecsServiceImages,
};
