// workers/src/jobs/spot-guard/types.ts
//
// Shared types for Fargate Spot Guard (SG-*).
//
// The string-union types here are the DECLARED SOURCE OF TRUTH that the CHECK
// constraints in libs/prisma/migrations/20260725201753_add_spot_guard/migration.sql
// mirror. Adding a member here without adding it to the constraint produces an insert
// that fails at runtime — and repository try/catch has swallowed exactly that class of
// bug before (see migration 20260713070000). Keep them in lockstep.

// ── Capacity ──────────────────────────────────────────────────────────────────

/** One entry of an ECS service's capacityProviderStrategy. */
export interface CapacityProviderStrategyItem {
    capacityProvider: string;
    weight?: number;
    base?: number;
}

export type CapacityType = 'spot' | 'on_demand';

/** Derived from a whole strategy, not a single provider. */
export type CapacityState = 'spot' | 'on_demand' | 'mixed' | 'unknown';

/**
 * managed     — Nucleus automates fallback + restore.
 * unmanaged   — Nucleus observes but never mutates (user opted out of automation).
 * opted_out   — user deliberately took the service OFF Spot; never put it back.
 */
export type ManagementState = 'managed' | 'unmanaged' | 'opted_out';

export type EcsServiceStatus = 'ACTIVE' | 'DRAINING' | 'INACTIVE';

// ── Events ────────────────────────────────────────────────────────────────────

export type SpotEventType =
    | 'interruption'
    | 'placement_failure'
    | 'fallback_applied'
    | 'restore_attempted'
    | 'restore_succeeded'
    | 'restore_failed'
    | 'spot_enabled'
    | 'spot_disabled'
    | 'unmanaged'
    | 'capacity_transition'
    | 'alb_predrain'
    | 'governance_skip'
    | 'backoff_skip';

export type SpotEventSeverity = 'info' | 'warning' | 'critical';

export type SpotGuardActionType = 'fallback' | 'restore' | 'alb_predrain' | 'enable_spot' | 'disable_spot';

// ── EventBridge envelope ──────────────────────────────────────────────────────

/**
 * The EventBridge envelope as delivered to the hub bus and forwarded through SQS.
 *
 * SECURITY: `account` is stamped by EventBridge from the authenticated caller and is
 * NOT settable by the sender — PutEventsRequestEntry has exactly seven fields
 * (Detail, DetailType, EventBusName, Resources, Source, Time, TraceHeader) and none is
 * Account. EventBridge also refuses to relay an event a second hop. Every ARN inside
 * `detail`/`resources`, by contrast, IS sender-controlled, which is why the handler
 * cross-checks ARN account segments against this field.
 */
export interface EcsEventEnvelope {
    id?: string;
    account?: string;
    region?: string;
    time?: string;
    source?: string;
    'detail-type'?: string;
    resources?: string[];
    detail?: EcsEventDetail;
}

export interface EcsEventDetail {
    // ECS Task State Change
    clusterArn?: string;
    taskArn?: string;
    group?: string; // "service:<name>"
    lastStatus?: string;
    desiredStatus?: string;
    capacityProviderName?: string;
    launchType?: string;
    stopCode?: string;
    stoppedReason?: string;
    createdAt?: string;
    startedAt?: string;
    stoppingAt?: string;
    stoppedAt?: string;
    executionStoppedAt?: string;
    cpu?: string;
    memory?: string;
    attachments?: Array<{
        type?: string;
        details?: Array<{ name?: string; value?: string }>;
    }>;
    taskDefinitionArn?: string;

    // ECS Service Action / Deployment State Change
    eventName?: string;
    eventType?: string;
    reason?: string;
    capacityProviderArns?: string[];
}

// ── Job payloads ──────────────────────────────────────────────────────────────

export interface SpotGuardEventJob {
    envelope: EcsEventEnvelope;
    /** Wall-clock ms when the SQS consumer enqueued it — used for staleness checks. */
    ingestedAtMs: number;
}

export interface SpotGuardRestoreScanJob {
    tenantId: string;
    trigger: 'schedule' | 'manual';
    /** Restrict to specific SpotGuardService ids (manual "Restore now"). */
    serviceIds?: string[];
    /** Bypass the backoff gate only — never any safety gate. */
    force?: boolean;
}

export interface SpotGuardReportJob {
    tenantId: string;
    trigger: 'schedule' | 'manual';
    /** 'YYYY-MM-DD'; defaults to the day that just ended in the tenant's timezone. */
    date?: string;
}

// ── Resolution ────────────────────────────────────────────────────────────────

/** An onboarded (tenant, AWS account) pair permitted to run Spot automation. */
export interface SpokeBinding {
    tenantId: string;
    accountId: string;
    roleArn: string;
    externalId: string | null;
    regions: string[];
}

/** Live ECS state the restore decision needs. */
export interface LiveServiceState {
    currentStrategy: CapacityProviderStrategyItem[];
    desiredCount: number;
    /** Tasks actually running. The column existed but nothing ever populated it. */
    runningCount: number;
    status: string;
    hasLoadBalancers: boolean;
    /** True when a deployment is mid-rollout — never mutate on top of one. */
    deploymentInProgress: boolean;
}
