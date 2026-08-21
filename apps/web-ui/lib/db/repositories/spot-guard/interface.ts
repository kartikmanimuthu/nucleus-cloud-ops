/**
 * ISpotGuardRepository
 *
 * Contract for Fargate Spot Guard persistence — the managed-service registry, the event
 * timeline, and the Spot-vs-On-Demand hours report.
 * Implemented by SpotGuardPostgresRepository.
 *
 * Multi-tenant safety: every query is scoped by tenantId — no cross-tenant access.
 *
 * ⚠️  THE UNION TYPES BELOW ARE THE DECLARED SOURCE OF TRUTH for the CHECK constraints in
 * libs/prisma/migrations/20260725201753_add_spot_guard/migration.sql. Adding a member here
 * without adding it to the constraint produces an INSERT that fails at runtime — and
 * repository try/catch has swallowed exactly that class of bug in this codebase before
 * (see migration 20260713070000, which exists to repair it). Keep them in lockstep, and
 * keep them in lockstep with apps/workers/src/jobs/spot-guard/types.ts too.
 */

import type { PrismaRowFilter } from '@/lib/db/pg-config';

// ── Enumerations (mirrored by DB CHECK constraints) ──────────────────────────

/** Derived from a whole capacityProviderStrategy, not one provider. */
export type CapacityState = 'spot' | 'on_demand' | 'mixed' | 'unknown';

/** Per-task / per-session capacity. */
export type CapacityType = 'spot' | 'on_demand';

/**
 * managed    — Nucleus automates fallback and restore.
 * unmanaged  — Nucleus observes but never mutates (user opted out of automation only).
 * opted_out  — the user deliberately took the service OFF Spot; never put it back.
 */
export type ManagementState = 'managed' | 'unmanaged' | 'opted_out';

export type EcsServiceStatus = 'ACTIVE' | 'DRAINING' | 'INACTIVE';

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

// ── Domain shapes ────────────────────────────────────────────────────────────

export interface CapacityProviderStrategyItem {
    capacityProvider: string;
    weight?: number;
    base?: number;
}

export interface SpotGuardService {
    id: string;
    tenantId: string;
    accountId: string;
    region: string;
    clusterName: string;
    serviceName: string;
    clusterArn?: string | null;
    serviceArn?: string | null;
    /** The Spot-first baseline the hourly job restores to. */
    desiredStrategy: CapacityProviderStrategyItem[];
    /** Last strategy observed on the live service — drives the drift view. */
    observedStrategy: CapacityProviderStrategyItem[];
    observedAt?: string | null;
    capacityState: CapacityState;
    managementState: ManagementState;
    restorePending: boolean;
    lastFallbackAt?: string | null;
    lastRestoreAt?: string | null;
    lastRestoreAttemptAt?: string | null;
    lastFailedAt?: string | null;
    consecutiveFailures: number;
    backoffUntil?: string | null;
    desiredCount?: number | null;
    runningCount?: number | null;
    serviceStatus?: EcsServiceStatus | null;
    albTargetGroupArns: string[];
    interruptionCount: number;
    placementFailureCount: number;
    fallbackCount: number;
    restoreCount: number;
    enabledBy?: string | null;
    enabledAt?: string | null;
    disabledBy?: string | null;
    disabledAt?: string | null;
    lastEventAt?: string | null;
    createdAt: string;
    updatedAt: string;
    /**
     * Who registered this service, and who last changed it. "system" when no person was
     * involved — the observer registers rows without a user.
     *
     * Distinct from enabledBy/disabledBy, which hold only the latest opt-in and opt-out.
     */
    createdBy: string;
    updatedBy: string;
    /**
     * True when observedStrategy was filled in from the discovery inventory rather than from a
     * live DescribeServices that Spot Guard itself made.
     *
     * The high-volume task-state event path deliberately does not call DescribeServices, so a
     * registry row it creates has no strategy of its own and the column rendered "—" until some
     * mutating path happened to look. Discovery already captures capacityProviderStrategy for
     * every ECS service, so we borrow it — but flag it, because it is as stale as the last
     * discovery scan rather than current.
     */
    strategyFromInventory?: boolean;
}

export interface SpotGuardEvent {
    id: string;
    tenantId: string;
    spotServiceId?: string | null;
    accountId: string;
    region: string;
    clusterName: string;
    serviceName: string;
    eventType: SpotEventType;
    severity: SpotEventSeverity;
    taskArn?: string | null;
    capacityProvider?: string | null;
    fromCapacity?: CapacityType | null;
    toCapacity?: CapacityType | null;
    stopCode?: string | null;
    stoppedReason?: string | null;
    strategyBefore?: CapacityProviderStrategyItem[] | null;
    strategyAfter?: CapacityProviderStrategyItem[] | null;
    message: string;
    metadata: Record<string, unknown>;
    /** False when the alert-dedup window suppressed Slack delivery. */
    notifiedSlack: boolean;
    slackError?: string | null;
    actor: string;
    occurredAt: string;
}

/**
 * A service discovered from inventory that Nucleus is not yet managing.
 *
 * eligibility explains WHY a service can or cannot be put on Spot, so the UI can show a
 * reason instead of a disabled button with no explanation:
 *   spot_capable             — strategy already contains a Spot provider; one click.
 *   spot_addable             — has a strategy but no Spot provider; the cluster must have
 *                              FARGATE_SPOT registered.
 *   needs_capacity_providers — bare launchType with no strategy at all; must be migrated
 *                              off launchType first, which Nucleus cannot do via UpdateService.
 */
export type SpotEligibility = 'spot_capable' | 'spot_addable' | 'needs_capacity_providers';

export interface EligibleService {
    accountId: string;
    region: string;
    clusterName?: string | null;
    clusterArn?: string | null;
    serviceName: string;
    serviceArn?: string | null;
    launchType?: string | null;
    desiredCount?: number | null;
    capacityProviderStrategy: CapacityProviderStrategyItem[];
    /** Capacity providers registered on the cluster, when discovery captured them. */
    clusterCapacityProviders: string[];
    eligibility: SpotEligibility;
    /** Set when Nucleus already manages this service. */
    spotServiceId?: string | null;
    /**
     * The registry's live strategy, when Nucleus already manages this service.
     *
     * capacityProviderStrategy above comes from the discovery inventory, which is only as fresh as
     * the last nightly scan — so for a managed service it can be hours out of date. Anything that
     * needs the CURRENT split (such as seeding the capacity dialog) must prefer this.
     */
    registryStrategy?: CapacityProviderStrategyItem[] | null;
    managementState?: ManagementState | null;
}

export interface SpotGuardSummary {
    managedServices: number;
    servicesOnSpot: number;
    servicesInFallback: number;
    servicesUnmanaged: number;
    interruptions24h: number;
    placementFailures24h: number;
    /** Trailing 7 days. */
    spotHours7d: number;
    onDemandHours7d: number;
    spotShare7d: number;
    lastEventAt?: string | null;
}

export interface HoursReportRow {
    accountId: string;
    accountName?: string;
    region: string;
    clusterName: string;
    serviceName: string;
    spotSeconds: number;
    onDemandSeconds: number;
    spotHours: number;
    onDemandHours: number;
    spotShare: number;
    sessions: number;
    inFlightSessions: number;
    interruptions: number;
}

export interface HoursReport {
    from: string;
    to: string;
    rows: HoursReportRow[];
    totals: {
        spotHours: number;
        onDemandHours: number;
        spotShare: number;
        interruptions: number;
        inFlightSessions: number;
    };
    dataQuality: { orphaned: number; staleOpen: number };
}

// ── Filters ──────────────────────────────────────────────────────────────────

export interface ServiceFilters {
    tenantId: string;
    accountId?: string;
    region?: string;
    clusterName?: string;
    capacityState?: CapacityState;
    managementState?: ManagementState;
    searchTerm?: string;
    page?: number;
    limit?: number;
    /**
     * Gate 3 (RBAC row filtering): a Prisma `where` fragment restricting the
     * result to the rows the caller may read. Built by
     * getReadRowFilter() in lib/rbac/row-filter.ts and INTERSECTED with the
     * query below via andWhere() — never merged over it.
     */
    rowFilter?: PrismaRowFilter | null;
}

/** Distinct values for the managed-services filter dropdowns. */
export interface SpotGuardFacets {
    regions: string[];
    clusters: string[];
}

export interface EventFilters {
    tenantId: string;
    spotServiceId?: string;
    accountId?: string;
    serviceName?: string;
    eventType?: SpotEventType;
    /** Match any of these types. Used by the capacity view, which spans several. */
    eventTypes?: SpotEventType[];
    severity?: SpotEventSeverity;
    since?: string;
    page?: number;
    limit?: number;
}

export interface EligibleFilters {
    tenantId: string;
    accountId?: string;
    region?: string;
    eligibility?: SpotEligibility;
    searchTerm?: string;
    page?: number;
    limit?: number;
}

/** Fields the service layer may upsert onto the registry. */
export interface ServiceUpsert {
    accountId: string;
    region: string;
    clusterName: string;
    serviceName: string;
    clusterArn?: string | null;
    serviceArn?: string | null;
    desiredStrategy: CapacityProviderStrategyItem[];
    observedStrategy?: CapacityProviderStrategyItem[];
    capacityState: CapacityState;
    managementState: ManagementState;
    enabledBy?: string;
    disabledBy?: string;
    /**
     * Who is performing this upsert. Recorded as createdBy on insert and updatedBy on every
     * write. Omit for machine-driven writes, which fall back to the column default ("system").
     */
    actor?: string;
    desiredCount?: number;
    runningCount?: number;
    /**
     * Clear restorePending and backoffUntil as part of this write.
     *
     * Set by enableSpot and disableSpot — both apply a strategy directly against live AWS, so
     * any restore the hourly job had queued is now moot, and any backoff was a reason to wait
     * that a direct human action has just overridden. Without this, disabling a service that had
     * restorePending=true left it set: the worker's own candidate query already excludes
     * non-managed rows, so it does not actually restore anything while opted out, but the detail
     * page went on claiming "Restore pending: yes" for a service that will never be restored —
     * confusing in exactly the way "Restore baseline" was for the same services before that hint
     * became management-state-aware.
     */
    resetRestoreState?: boolean;
}

export interface ISpotGuardRepository {
    getFacets(tenantId: string): Promise<SpotGuardFacets>;
    listServices(filters: ServiceFilters): Promise<{ services: SpotGuardService[]; total: number }>;
    getService(id: string, tenantId: string): Promise<SpotGuardService | null>;
    findServiceByTarget(
        tenantId: string,
        target: { accountId: string; region: string; clusterName: string; serviceName: string },
    ): Promise<SpotGuardService | null>;
    upsertService(tenantId: string, input: ServiceUpsert): Promise<SpotGuardService>;
    setManagementState(
        id: string,
        tenantId: string,
        state: ManagementState,
        actor: string,
    ): Promise<SpotGuardService>;
    deleteService(id: string, tenantId: string): Promise<void>;

    listEvents(filters: EventFilters): Promise<{ events: SpotGuardEvent[]; total: number }>;
    recordEvent(
        tenantId: string,
        input: Omit<SpotGuardEvent, 'id' | 'tenantId' | 'occurredAt' | 'notifiedSlack' | 'metadata' | 'severity'> &
            Partial<Pick<SpotGuardEvent, 'severity' | 'metadata'>>,
    ): Promise<SpotGuardEvent>;

    getSummary(tenantId: string): Promise<SpotGuardSummary>;
    getHoursReport(tenantId: string, range: { from: Date; to: Date }): Promise<HoursReport>;
    listEligibleServices(filters: EligibleFilters): Promise<{ services: EligibleService[]; total: number }>;
}
