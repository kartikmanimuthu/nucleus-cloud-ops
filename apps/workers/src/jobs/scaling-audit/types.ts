// workers/src/jobs/scaling-audit/types.ts
//
// Shared types for the Scaling Audit job (SA-001). See
// apps/web-ui/lib/db/repositories/scaling-audit/interface.ts for the corresponding
// web-ui-side union types — the two must be kept in sync (they are the declared
// source of truth for the CHECK constraints in
// libs/prisma/migrations/20260805120000_add_scaling_audit/migration.sql).

export type ScalingScope = 'asg' | 'ecs' | 'rds' | 'msk' | 'elasticache' | 'docdb';
export type ScalingSource = 'aws_api' | 'platform' | 'cloudtrail';

/**
 * Sources that are POLLED, and therefore hold a watermark. 'platform' is absent
 * by design: those rows are written synchronously by the schedulers at mutation
 * time, so there is no API position to resume from. Mirrored by the CHECK on
 * scaling_audit_watermarks.source.
 */
export type PolledSource = 'aws_api' | 'cloudtrail';

export type ScalingType =
    | 'scheduled'
    | 'target_tracking'
    | 'step'
    | 'simple'
    | 'predictive'
    | 'manual'
    // A direct API call outside any scaling policy. Describes the MECHANISM;
    // says nothing about whether the caller was a person (see cloudtrail-client).
    | 'direct_api'
    // AWS-initiated, not a human/pipeline call — e.g. RDS's own storage
    // autoscaling growing a volume when free space drops below the threshold.
    | 'storage_autoscaling'
    | 'health_check_replacement'
    | 'capacity_rebalance'
    | 'instance_refresh'
    | 'az_rebalance'
    | 'max_instance_lifetime'
    | 'not_scaled'
    | 'unparsed';

export type CoverageStatus = 'covered' | 'partial' | 'failed' | 'skipped';
export type RunStatus = 'queued' | 'running' | 'completed' | 'partial' | 'failed';
export type RunTrigger = 'schedule' | 'manual' | 'backfill';

/** Output of the pure cause-classifier — see services/cause-classifier.ts. */
export interface ClassifiedCause {
    scalingType: ScalingType;
    policyName?: string;
    scheduledActionName?: string;
    alarmName?: string;
    desiredBefore?: number;
    desiredAfter?: number;
}

/** One AWS scaling activity (ASG or ECS/Application Auto Scaling), pre-classification. */
export interface RawScalingActivity {
    activityId: string;
    resourceId: string;
    asgName?: string;
    clusterName?: string;
    serviceName?: string;
    scalableDimension?: string;
    cause: string;
    description?: string;
    statusCode?: string;
    statusMessage?: string;
    notScaledReasons?: unknown;
    startedAt: Date;
    endedAt?: Date;
    progress?: number;
    rawPayload: Record<string, unknown>;
    /**
     * Set only by the CloudTrail client, which is the one source that knows the
     * principal PER EVENT — the activity APIs report a trigger, not a caller, so
     * for them attribution comes from the surrounding NormalizeContext instead.
     * When present these win over the context values (see normalizeActivity).
     */
    actor?: string;
    actorType?: 'system' | 'user' | 'unattributed_out_of_band';
    /**
     * Pre-classified by the source when the source knows the MECHANISM that the
     * cause text cannot express — CloudTrail sets 'direct_api', meaning the call
     * bypassed every scaling policy.
     *
     * It deliberately does NOT say 'manual'. An earlier version did, on the
     * reasoning that userIdentity proves a person; that was wrong, because
     * AssumedRole covers CI/CD pipelines and other automation just as much as
     * human SSO sessions. Asserting a human is the very inference
     * cause-classifier.ts refuses to make.
     */
    scalingTypeOverride?: ScalingType;
}

/** A fully normalized, classified, ready-to-insert scaling event. */
export interface NormalizedScalingEvent extends RawScalingActivity, ClassifiedCause {
    scope: ScalingScope;
    source: ScalingSource;
    tenantId: string;
    accountId: string;
    region: string;
    inventoryMatched: boolean;
    notScaledCode?: string;
    minBefore?: number;
    maxBefore?: number;
    minAfter?: number;
    maxAfter?: number;
    actor: string;
    actorType: 'system' | 'user' | 'unattributed_out_of_band';
    initiatedBy?: string;
    correlationId?: string;
    /** How desiredBefore was known — set by normalizeActivity() when the Cause/
     *  Description text names it, or by index.ts's CloudWatch enrichment step
     *  when it doesn't. See lib/cloudwatch-client.ts. */
    desiredBeforeSource?: 'activity' | 'cloudwatch';
    peakCpuBeforeScale?: number;
    peakMemoryBeforeScale?: number;
}

export interface ScopeWatermark {
    accountId: string;
    region: string;
    scope: ScalingScope;
    /** Each polled source tracks its own position for the same scope. */
    source: PolledSource;
    lastActivityAt: Date | null;
    lastActivityId: string | null;
}

export interface PollOutcome {
    /** Raw activities straight off the AWS SDK — normalizeActivity() classifies
     *  and enriches these into NormalizedScalingEvent afterward, in index.ts. */
    events: RawScalingActivity[];
    apiCallCount: number;
    pagesFetched: number;
    truncated: boolean;
    oldestActivitySeenAt: Date | null;
    newestActivitySeenAt: Date | null;
    /** Set when the poll could not complete (AssumeRole/AccessDenied/throttle/etc). */
    error?: { reason: string; message: string };
}

export interface CoverageRow {
    tenantId: string;
    accountId: string;
    region: string;
    scope: ScalingScope;
    source: ScalingSource;
    windowStart: Date;
    windowEnd: Date;
    status: CoverageStatus;
    reason?: string;
    activityCount: number;
    apiCallCount: number;
    pagesFetched: number;
    truncated: boolean;
    oldestActivitySeenAt?: Date | null;
    newestActivitySeenAt?: Date | null;
    runId: string;
}
