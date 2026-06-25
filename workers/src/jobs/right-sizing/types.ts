// workers/src/jobs/right-sizing/types.ts
//
// Right Sizing pipeline types (workers package). Structurally mirrors
// web-ui/lib/right-sizing/types.ts (separate npm package, so duplicated by design).

// Values MUST match inventory_resources.resourceType written by discovery.
// (ASG is not discovered today; the rule stays dormant until autoscaling_auto_scaling_groups exist.)
export const RESOURCE_TYPES = {
    EC2: 'ec2_instances',
    RDS: 'rds_db_instances',
    EBS: 'ec2_volumes',
    ASG: 'autoscaling_auto_scaling_groups',
} as const;
export type ResourceTypeKey = (typeof RESOURCE_TYPES)[keyof typeof RESOURCE_TYPES];

export type Finding = 'over_provisioned' | 'under_provisioned' | 'idle' | 'optimized';
export type RiskLevel = 'low' | 'medium' | 'high';

/** A signal we may collect from CloudWatch. */
export type SignalKey =
    | 'cpu'
    | 'memory'
    | 'networkIn'
    | 'networkOut'
    | 'diskReadOps'
    | 'diskWriteOps'
    | 'connections'
    | 'freeableMemory'
    | 'iops'
    | 'throughputPercent'
    | 'burstBalance';

export interface SignalSummary {
    avg: number;
    p95: number;
    p99: number;
    max: number;
    count: number;
}

export interface MetricsSummary {
    cpu?: SignalSummary | null;
    memory?: SignalSummary | null;
    networkIn?: SignalSummary | null;
    networkOut?: SignalSummary | null;
    diskReadOps?: SignalSummary | null;
    diskWriteOps?: SignalSummary | null;
    connections?: SignalSummary | null;
    freeableMemory?: SignalSummary | null;
    iops?: SignalSummary | null;
    throughputPercent?: SignalSummary | null;
    burstBalance?: SignalSummary | null;
    coverageDays: number;
    datapointDensity: number;
}

export interface ResourceConfig {
    instanceType?: string;
    dbInstanceClass?: string;
    vcpu?: number;
    memGiB?: number;
    volumeType?: string;
    sizeGiB?: number;
    iops?: number;
    throughput?: number;
    minSize?: number;
    desiredCapacity?: number;
    maxSize?: number;
    [key: string]: unknown;
}

/** A resource (from inventory_resources) to analyze. */
export interface AnalyzableResource {
    accountId: string;
    region: string;
    resourceType: ResourceTypeKey;
    resourceId: string;
    name?: string | null;
    status?: string | null;
    metadata: Record<string, unknown>;
}

/** Raw collected series, keyed by resourceId then signal → numeric values (per period). */
export type CollectedMetrics = Map<string, Partial<Record<SignalKey, number[]>>>;

/** Engine output for one resource (shape consumed by the worker upsert). */
export interface RecommendationOutput {
    accountId: string;
    region: string;
    resourceType: string;
    resourceId: string;
    name?: string | null;
    finding: Finding;
    currentConfig: ResourceConfig;
    recommendedConfig?: ResourceConfig | null;
    metricsSummary: MetricsSummary;
    lookbackDays: number;
    currency: string;
    currentMonthlyCost?: number | null;
    recommendedMonthlyCost?: number | null;
    estimatedMonthlySavings: number;
    confidence: number;
    riskLevel: RiskLevel;
    rationale: string;
    source: string;
}
