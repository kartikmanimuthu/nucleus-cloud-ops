/**
 * Shared Right Sizing types (RS-004).
 *
 * Canonical types for the module — re-exports the repository-facing types and adds
 * engine/metric types used by the worker analysis pipeline. The workers package keeps
 * a structurally-identical copy under workers/src/jobs/right-sizing/ (separate npm package).
 */

export type {
    Finding,
    RiskLevel,
    RecommendationStatus,
    RunStatus,
    RunTrigger,
} from '@/lib/db/repositories/right-sizing/interface';

/** Resource type keys — MUST match inventory_resources.resourceType written by discovery. */
export const RESOURCE_TYPES = {
    EC2: 'ec2_instances',
    RDS: 'rds_db_instances',
    EBS: 'ec2_volumes',
    ASG: 'autoscaling_auto_scaling_groups',
} as const;
export type ResourceTypeKey = (typeof RESOURCE_TYPES)[keyof typeof RESOURCE_TYPES];

/** Summary stats for a single CloudWatch signal over the lookback window. */
export interface SignalSummary {
    avg: number;
    p95: number;
    p99: number;
    max: number;
    count: number;
}

/**
 * Compact per-resource metric summary persisted on each recommendation and consumed
 * by the engine. Signal keys are nullable — a signal absent in CloudWatch (e.g. memory
 * without the CW agent) is null and excluded from rules + flagged in the rationale.
 */
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
    /** Days of data actually observed in the window. */
    coverageDays: number;
    /** Fraction [0,1] of expected datapoints actually present. */
    datapointDensity: number;
}

/** Normalized resource configuration (current or recommended). */
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
