/**
 * IScalingAuditRepository
 *
 * Read-only + export contract for the Scaling Audit module (SA-001) — a SEBI
 * compliance record of ECS + ASG scaling events. Implemented by
 * ScalingAuditPostgresRepository.
 *
 * Deliberately NO update/delete method exists here: rows are written exclusively
 * by the worker (apps/workers/src/jobs/scaling-audit/), and the database itself
 * rejects UPDATE/DELETE on scaling_events (see the migration). This interface
 * enforces the same append-only contract at the application layer, mirroring
 * IAuditLogRepository.
 *
 * Multi-tenant safety: every query is scoped by tenantId via getTenantClient().
 */

export type ScalingScope = 'asg' | 'ecs' | 'rds' | 'msk' | 'elasticache' | 'docdb';
/**
 * - aws_api    — polled from the ASG / Application Auto Scaling activity APIs
 * - platform   — written synchronously by this platform's own schedulers
 * - cloudtrail — out-of-band changes the activity APIs cannot see (a direct
 *                ecs:UpdateService), plus the human principal behind a manual
 *                ASG change. One physical ASG change can legitimately appear as
 *                BOTH an aws_api and a cloudtrail row: two independent
 *                observations, deliberately not merged (there is no exact join
 *                key, and a wrong merge would attribute a change to the wrong
 *                principal). Count distinct changes, not rows.
 */
export type ScalingSource = 'aws_api' | 'platform' | 'cloudtrail';
export type ScalingType =
    | 'scheduled'
    | 'target_tracking'
    | 'step'
    | 'simple'
    | 'predictive'
    | 'manual'
    /** Direct API call outside any scaling policy — mechanism, not intent. */
    | 'direct_api'
    /** AWS-initiated, not a human/pipeline call — e.g. RDS's own storage autoscaling. */
    | 'storage_autoscaling'
    | 'health_check_replacement'
    | 'capacity_rebalance'
    | 'instance_refresh'
    | 'az_rebalance'
    | 'max_instance_lifetime'
    | 'not_scaled'
    | 'unparsed';
/**
 * Which rows count as "the resource actually scaled or descaled".
 *
 * Application Auto Scaling emits a record for every policy *evaluation*, not just
 * every scaling action — a service with a target-tracking policy produces a
 * steady stream of "Attempting to scale due to alarm triggered" rows carrying a
 * NotScaledReasons code (AlreadyAtDesiredCapacity, AlreadyAtMinCapacity, ...)
 * where capacity never moved. Those legitimately belong in the compliance record
 * (a suppressed scale-out is often the most audit-relevant event there is) but
 * they swamp the far smaller set of real capacity changes: in a measured sample
 * of one live account, 46 of 52 captured rows were suppressed evaluations and
 * only 4 were actual capacity changes.
 *
 * - 'capacity_changes' — desired/actual capacity genuinely moved (the default view)
 * - 'all'              — the complete, unfiltered compliance record
 */
export type ScalingEffectFilter = 'capacity_changes' | 'all';

export type CoverageStatus = 'covered' | 'partial' | 'failed' | 'skipped';
export type RunStatus = 'queued' | 'running' | 'completed' | 'partial' | 'failed';
export type RunTrigger = 'schedule' | 'manual' | 'backfill';

export interface ScalingEvent {
    id: string;
    tenantId: string;
    accountId: string;
    region: string;
    scope: ScalingScope;
    source: ScalingSource;
    activityId: string;
    resourceId: string;
    asgName?: string | null;
    clusterName?: string | null;
    serviceName?: string | null;
    scalableDimension?: string | null;
    inventoryMatched: boolean;
    scalingType: ScalingType;
    policyName?: string | null;
    scheduledActionName?: string | null;
    alarmName?: string | null;
    notScaledCode?: string | null;
    cause: string;
    description?: string | null;
    statusCode?: string | null;
    statusMessage?: string | null;
    notScaledReasons?: unknown;
    rawPayload: Record<string, unknown>;
    desiredBefore?: number | null;
    desiredAfter?: number | null;
    minBefore?: number | null;
    maxBefore?: number | null;
    minAfter?: number | null;
    maxAfter?: number | null;
    capacityDelta?: number | null;
    /** 'activity' when the AWS Cause/Description text named desiredBefore
     *  directly, 'cloudwatch' when it was backfilled from the DesiredTaskCount
     *  metric — see workers/src/lib/cloudwatch-client.ts. */
    desiredBeforeSource?: 'activity' | 'cloudwatch' | null;
    /** Peak CPU/Memory utilization in the 15 minutes before startedAt. */
    peakCpuBeforeScale?: number | null;
    peakMemoryBeforeScale?: number | null;
    actor: string;
    actorType: string;
    initiatedBy?: string | null;
    correlationId?: string | null;
    startedAt: string;
    endedAt?: string | null;
    durationSeconds?: number | null;
    reportDateIst: string;
    capturedByRunId: string;
    capturedAt: string;
}

export interface ScalingEventFilters {
    tenantId: string;
    accountId?: string;
    region?: string;
    scope?: ScalingScope;
    source?: ScalingSource;
    scalingType?: ScalingType;
    /** Excludes rows matching any of these types — e.g. the resource-detail
     *  page's "Other" scaling tab (everything but scheduled/target_tracking).
     *  Ignored when `scalingType` is also set. */
    excludeScalingTypes?: ScalingType[];
    resourceId?: string;
    searchTerm?: string;
    /** Defaults to 'capacity_changes' — see ScalingEffectFilter. */
    effect?: ScalingEffectFilter;
    /** Inclusive, ISO date/datetime strings — filters on startedAt. */
    dateFrom?: string;
    dateTo?: string;
    page?: number;
    limit?: number;
}

/**
 * One row per resource in the resource-centric list view — the Spot Guard shape:
 * you look at a service, then drill into its history, rather than reading a flat
 * event log where a single busy resource buries everything else.
 */
export interface ScalingResourceSummary {
    resourceId: string;
    scope: ScalingScope;
    accountId: string;
    region: string;
    asgName?: string | null;
    clusterName?: string | null;
    serviceName?: string | null;
    /** Events matching the caller's filter (capacity-changes-only by default). */
    eventCount: number;
    firstEventAt: string;
    lastEventAt: string;
    /**
     * The name used in the detail URL: /scale-sentinel/<scope>/<displayName>.
     * Not guaranteed unique — two clusters or two accounts may each hold a service
     * of the same name — so the detail page resolves by name and disambiguates
     * when more than one resource matches, rather than silently picking one.
     */
    displayName: string;
}

export interface ScalingResourcePage {
    resources: ScalingResourceSummary[];
    total: number;
}

export interface ScalingEventPage {
    events: ScalingEvent[];
    total: number;
}

export interface ScalingAuditFacets {
    accountIds: string[];
    regions: string[];
    scalingTypes: ScalingType[];
}

export interface ScalingAuditSummary {
    totalEvents: number;
    byScalingType: Record<string, number>;
    byScope: Record<string, number>;
    bySource: Record<string, number>;
    openGaps: number;
    lastRunAt: string | null;
    lastRunStatus: RunStatus | null;
}

export interface ScalingAuditRun {
    id: string;
    tenantId: string;
    status: RunStatus;
    trigger: RunTrigger;
    accountsScanned: number;
    scopesPolled: number;
    eventsSeen: number;
    eventsCaptured: number;
    policySnapshots: number;
    gapsDetected: number;
    apiCallCount: number;
    errors: unknown[];
    startedAt: string;
    finishedAt?: string | null;
}

export interface WatermarkGap {
    accountId: string;
    region: string;
    scope: ScalingScope;
    /** Which polled source the gap belongs to — each holds its own position. */
    source?: string;
    gapFromAt?: string | null;
    gapToAt?: string | null;
    gapReason?: string | null;
    lastPolledAt?: string | null;
}

export interface PolicySnapshot {
    id: string;
    accountId: string;
    region: string;
    scope: ScalingScope;
    resourceId: string;
    configHash: string;
    policies: unknown[];
    scheduledActions: unknown[];
    minCapacity?: number | null;
    maxCapacity?: number | null;
    firstSeenAt: string;
    lastSeenAt: string;
}

export interface IScalingAuditRepository {
    listEvents(filters: ScalingEventFilters): Promise<ScalingEventPage>;
    /** Resource-centric roll-up for the default list view. */
    listResources(filters: ScalingEventFilters): Promise<ScalingResourcePage>;
    getEvent(id: string, tenantId: string): Promise<ScalingEvent | null>;
    getSummary(tenantId: string): Promise<ScalingAuditSummary>;
    getFacets(tenantId: string): Promise<ScalingAuditFacets>;
    listRuns(tenantId: string, page?: number, limit?: number): Promise<{ runs: ScalingAuditRun[]; total: number }>;
    getWatermarkGaps(tenantId: string): Promise<WatermarkGap[]>;
    listPolicySnapshots(tenantId: string, accountId: string, region: string, resourceId: string): Promise<PolicySnapshot[]>;
    /** For export: all events matching the filter, unpaginated (caller is
     *  responsible for a sane row cap — see the export route). */
    listAllEvents(filters: Omit<ScalingEventFilters, 'page' | 'limit'>, maxRows: number): Promise<ScalingEvent[]>;
    /** The most recent daily seal at or before `onOrBefore` (default: latest),
     *  for stamping an export with its tamper-evidence chain position. */
    getLatestSeal(tenantId: string): Promise<{ day: string; seal: string; rowCount: number } | null>;
}
