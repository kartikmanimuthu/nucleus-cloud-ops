// workers/src/jobs/spot-guard/services/db-writer.ts
//
// Postgres writers for Spot Guard (SG-007).
//
// Raw pg throughout, matching right-sizing/services/db-writer.ts. The
// getTenantClient() Prisma extension does NOT intercept raw SQL (documented in
// apps/web-ui/lib/db/pg-config.ts), so EVERY query below scopes "tenantId" by hand.
// The one deliberate exception is claimAction, which is cross-tenant by design — see
// its comment.
import { getPool } from '../../discovery/services/db.js';
import { createLogger } from '../../../lib/logger.js';
import { SPOT_GUARD_CONFIG } from '../config.js';
import type {
    CapacityProviderStrategyItem,
    CapacityState,
    CapacityType,
    ManagementState,
    SpotEventSeverity,
    SpotEventType,
    SpotGuardActionType,
} from '../types.js';

const log = createLogger('spot-guard-db');

const DAY_MS = 24 * 60 * 60 * 1000;

// ── Service registry ─────────────────────────────────────────────────────────

export interface SpotServiceRow {
    id: string;
    tenantId: string;
    accountId: string;
    region: string;
    clusterName: string;
    serviceName: string;
    desiredStrategy: CapacityProviderStrategyItem[];
    observedStrategy: CapacityProviderStrategyItem[];
    capacityState: CapacityState;
    managementState: ManagementState;
    restorePending: boolean;
    backoffUntil: Date | null;
    consecutiveFailures: number;
    /**
     * Last known task count. Nullable because a row created by the task-event path has never had
     * one — which is exactly the case the event path now checks for, to notice that a service it
     * believes is stopped has just started a task.
     */
    desiredCount: number | null;
}

export async function findService(input: {
    tenantId: string;
    accountId: string;
    region: string;
    clusterName: string;
    serviceName: string;
}): Promise<SpotServiceRow | null> {
    const client = await getPool().connect();
    try {
        const { rows } = await client.query<SpotServiceRow>(
            `SELECT id, "tenantId", "accountId", region, "clusterName", "serviceName",
                    "desiredStrategy", "observedStrategy", "capacityState", "managementState",
                    "restorePending", "backoffUntil", "consecutiveFailures", "desiredCount"
               FROM spot_guard_services
              WHERE "tenantId" = $1 AND "accountId" = $2 AND region = $3
                AND "clusterName" = $4 AND "serviceName" = $5`,
            [input.tenantId, input.accountId, input.region, input.clusterName, input.serviceName],
        );
        return rows[0] ?? null;
    } finally {
        client.release();
    }
}

/**
 * Services the hourly job should consider restoring to Spot.
 *
 * Filters in SQL rather than scanning every row and deciding in application code (the
 * reference did a full DynamoDB Scan and filtered in Python). The final decision still
 * belongs to evaluateRestore against LIVE AWS state — this only narrows the candidates:
 *
 *  - managementState = 'managed'  — never touch unmanaged or opted-out services.
 *  - restorePending OR capacityState = 'on_demand' — the second disjunct is the
 *    self-heal path, covering a fallback applied out-of-band or a flag lost to a crash.
 *  - backoffUntil elapsed, unless the caller is forcing.
 */
export async function listRestoreCandidates(input: {
    tenantId: string;
    serviceIds?: string[];
    force?: boolean;
}): Promise<SpotServiceRow[]> {
    const client = await getPool().connect();
    try {
        const { rows } = await client.query<SpotServiceRow>(
            `SELECT id, "tenantId", "accountId", region, "clusterName", "serviceName",
                    "desiredStrategy", "observedStrategy", "capacityState", "managementState",
                    "restorePending", "backoffUntil", "consecutiveFailures", "desiredCount"
               FROM spot_guard_services
              WHERE "tenantId" = $1
                AND "managementState" = 'managed'
                AND ("restorePending" = true OR "capacityState" = 'on_demand')
                AND ($2::boolean OR "backoffUntil" IS NULL OR "backoffUntil" <= now())
                AND ($3::text[] IS NULL OR id = ANY($3::text[]))
              ORDER BY "lastFallbackAt" ASC NULLS LAST`,
            [input.tenantId, input.force ?? false, input.serviceIds ?? null],
        );
        return rows;
    } finally {
        client.release();
    }
}

/**
 * Record what we observed on the live service. Creates the registry row if this is the
 * first time we have seen the service.
 *
 * managementState is only set on INSERT, never on update: a service the user explicitly
 * unmanaged or opted out of must not be silently pulled back under management by the
 * next event that arrives.
 *
 * desiredStrategy is likewise NOT touched here — it is the restore baseline and is only
 * written by the deliberate paths that have verified the strategy is good.
 */
export async function upsertObservedService(input: {
    tenantId: string;
    accountId: string;
    region: string;
    clusterName: string;
    serviceName: string;
    clusterArn?: string | null;
    observedStrategy: CapacityProviderStrategyItem[];
    capacityState: CapacityState;
    desiredCount?: number | null;
    runningCount?: number | null;
    serviceStatus?: string | null;
    initialManagementState?: ManagementState;
}): Promise<string> {
    const client = await getPool().connect();
    try {
        const { rows } = await client.query<{ id: string }>(
            `INSERT INTO spot_guard_services
                (id, "tenantId", "accountId", region, "clusterName", "serviceName", "clusterArn",
                 "observedStrategy", "observedAt", "capacityState", "managementState",
                 "desiredCount", "runningCount", "serviceStatus", "lastEventAt", "updatedAt")
             VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6,
                     $7::jsonb, now(), $8, $9, $10, $11, $12, now(), now())
             ON CONFLICT ("tenantId", "accountId", region, "clusterName", "serviceName") DO UPDATE
                SET "observedStrategy" = EXCLUDED."observedStrategy",
                    "observedAt"       = now(),
                    "capacityState"    = EXCLUDED."capacityState",
                    "clusterArn"       = COALESCE(EXCLUDED."clusterArn", spot_guard_services."clusterArn"),
                    "desiredCount"     = COALESCE(EXCLUDED."desiredCount", spot_guard_services."desiredCount"),
                    "runningCount"     = COALESCE(EXCLUDED."runningCount", spot_guard_services."runningCount"),
                    "serviceStatus"    = COALESCE(EXCLUDED."serviceStatus", spot_guard_services."serviceStatus"),
                    "lastEventAt"      = now(),
                    "updatedAt"        = now()
             RETURNING id`,
            [
                input.tenantId,
                input.accountId,
                input.region,
                input.clusterName,
                input.serviceName,
                input.clusterArn ?? null,
                JSON.stringify(input.observedStrategy),
                input.capacityState,
                input.initialManagementState ?? 'managed',
                input.desiredCount ?? null,
                input.runningCount ?? null,
                input.serviceStatus ?? null,
            ],
        );
        return rows[0].id;
    } finally {
        client.release();
    }
}

/**
 * Persist the restore baseline and arm the backoff after a fallback.
 *
 * Callers MUST only reach this when the engine returned persistDesiredStrategy: true.
 * Writing a Spot-weight-0 strategy here is the one unrecoverable bug in the feature —
 * the hourly job would then "restore" the service to On-Demand forever and it would
 * silently never see Spot pricing again.
 */
export async function recordFallback(input: {
    tenantId: string;
    serviceId: string;
    desiredStrategy: CapacityProviderStrategyItem[];
    backoffUntil: Date;
}): Promise<void> {
    const client = await getPool().connect();
    try {
        await client.query(
            `UPDATE spot_guard_services
                SET "desiredStrategy"     = $3::jsonb,
                    "restorePending"      = true,
                    "lastFallbackAt"      = now(),
                    "lastFailedAt"        = now(),
                    "consecutiveFailures" = spot_guard_services."consecutiveFailures" + 1,
                    "backoffUntil"        = $4,
                    "fallbackCount"       = spot_guard_services."fallbackCount" + 1,
                    "updatedAt"           = now()
              WHERE "tenantId" = $1 AND id = $2`,
            [input.tenantId, input.serviceId, JSON.stringify(input.desiredStrategy), input.backoffUntil],
        );
    } finally {
        client.release();
    }
}

/**
 * Arm the backoff WITHOUT touching desiredStrategy.
 *
 * This is the fix for the reference implementation's restore-thrashing bug. It stamped
 * the failure timestamp only when its own UpdateService call threw, never when the
 * asynchronous placement failure that actually followed arrived — so
 * Spot -> fail -> On-Demand -> (next hour) -> Spot -> fail looped indefinitely. A
 * placement failure arriving while the service is already in fallback is exactly the
 * signal that the last restore failed out-of-band.
 */
export async function armBackoffOnly(input: {
    tenantId: string;
    serviceId: string;
    backoffUntil: Date;
}): Promise<void> {
    const client = await getPool().connect();
    try {
        await client.query(
            `UPDATE spot_guard_services
                SET "lastFailedAt"        = now(),
                    "consecutiveFailures" = spot_guard_services."consecutiveFailures" + 1,
                    "backoffUntil"        = $3,
                    "placementFailureCount" = spot_guard_services."placementFailureCount" + 1,
                    "updatedAt"           = now()
              WHERE "tenantId" = $1 AND id = $2`,
            [input.tenantId, input.serviceId, input.backoffUntil],
        );
    } finally {
        client.release();
    }
}

/** One managed registry row, as much of it as the re-observation pass needs. */
export interface ManagedServiceRef {
    id: string;
    tenantId: string;
    accountId: string;
    region: string;
    clusterName: string;
    serviceName: string;
    capacityState: CapacityState;
}

/**
 * Every managed service for a tenant, for the hourly re-observation pass.
 *
 * Deliberately WITHOUT listRestoreCandidates' two filters. That query only returns rows that are
 * restore-pending or already on On-Demand, and only when no backoff is armed — so a healthy service
 * sitting on Spot is never visited, and its observedStrategy can stay wrong indefinitely. A real
 * example: stx-kyc-ekyc-pf-app read "100% On-demand" in the console while live AWS had it on
 * FARGATE_SPOT w1, and no code path existed that would ever have corrected it.
 *
 * Ordered by account/region/cluster so the caller can group into one DescribeServices call per
 * cluster without sorting again.
 */
export async function listManagedServices(tenantId: string): Promise<ManagedServiceRef[]> {
    const client = await getPool().connect();
    try {
        const { rows } = await client.query<ManagedServiceRef>(
            `SELECT id, "tenantId", "accountId", region, "clusterName", "serviceName", "capacityState"
               FROM spot_guard_services
              WHERE "tenantId" = $1
                AND "managementState" = 'managed'
              ORDER BY "accountId", region, "clusterName", "serviceName"`,
            [tenantId],
        );
        return rows;
    } finally {
        client.release();
    }
}

/**
 * Record the strategy we just successfully applied as the observed one.
 *
 * MUST be called after UpdateService returns, by every path that mutates the strategy.
 *
 * Both mutating paths read the live strategy BEFORE acting (they need it to decide), and
 * `upsertObservedService` persists that pre-mutation value. Nothing then re-recorded it after the
 * change, so `observedStrategy` sat one action behind until some later scan happened to re-observe
 * without acting — meaning the registry was reliably wrong for the whole window right after every
 * fallback and every restore, which is exactly when someone looks at it. Two sbx services were
 * found showing the precise inverse of their live AWS strategy this way.
 *
 * The applied value is used rather than a fresh DescribeServices on purpose: ECS is eventually
 * consistent, so a read-back can still return the old strategy and would reintroduce the same
 * staleness non-deterministically. UpdateService having succeeded is what makes this authoritative.
 *
 * `capacityState` is deliberately NOT touched. Changing a capacity provider strategy does not move
 * already-running tasks, so the tasks may legitimately still be on the previous provider — that
 * column is owned by the task-state observer, which learns it from real task events.
 *
 * BEST EFFORT ON PURPOSE. Every caller runs this AFTER UpdateService has already changed the
 * customer's service, so throwing here would abort bookkeeping that matters much more than this
 * does — clearing the restore debt, or notifying the remaining tenants of a fallback. This write
 * only improves what the console displays; the next scan re-observes anyway. It must never be the
 * reason a safety mutation is left half-recorded.
 */
export async function recordAppliedStrategy(input: {
    tenantId: string;
    serviceId: string;
    appliedStrategy: CapacityProviderStrategyItem[];
}): Promise<void> {
    try {
        const client = await getPool().connect();
        try {
            await client.query(
                `UPDATE spot_guard_services
                    SET "observedStrategy" = $3::jsonb,
                        "observedAt"       = now(),
                        "updatedAt"        = now()
                  WHERE "tenantId" = $1 AND id = $2`,
                [input.tenantId, input.serviceId, JSON.stringify(input.appliedStrategy)],
            );
        } finally {
            client.release();
        }
    } catch (err) {
        log.warn('Could not record the applied strategy — the console will show the previous one until the next scan', {
            tenantId: input.tenantId,
            serviceId: input.serviceId,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

/**
 * Count one Spot interruption against the service, and return the row id so the timeline event can
 * be linked to it.
 *
 * interruptionCount was the only one of the four counters nobody ever wrote —
 * fallbackCount, placementFailureCount and restoreCount all have writers above — so the
 * console's per-service Interruptions column was structurally always 0 while the
 * "Interruptions (24h)" card, which counts spot_guard_events rows directly, showed the real
 * number. Twelve real interruptions against nine services all reading zero.
 *
 * The returned id fixes the more damaging half of the same omission: the interruption event was
 * the only event type in handle-spot-event.ts written without a spotServiceId, so it never
 * appeared in a service's own timeline — exactly the view you would open to investigate one
 * service's interruptions.
 *
 * UPDATE, never INSERT. This runs on the high-volume task-event path, which deliberately avoids
 * DescribeServices; creating registry rows is handleTaskStateChange's job via
 * upsertObservedService, and it runs immediately after this for the same event. Returns null when
 * no row exists yet — the very first sighting of a service — and the event is then written
 * unlinked, which is what happened for every interruption before this change.
 */
export async function recordInterruption(input: {
    tenantId: string;
    accountId: string;
    region: string;
    clusterName: string;
    serviceName: string;
}): Promise<string | null> {
    const client = await getPool().connect();
    try {
        const { rows } = await client.query<{ id: string }>(
            `UPDATE spot_guard_services
                SET "interruptionCount" = spot_guard_services."interruptionCount" + 1,
                    "lastEventAt"       = now(),
                    "updatedAt"         = now()
              WHERE "tenantId" = $1 AND "accountId" = $2 AND region = $3
                AND "clusterName" = $4 AND "serviceName" = $5
          RETURNING id`,
            [input.tenantId, input.accountId, input.region, input.clusterName, input.serviceName],
        );
        return rows[0]?.id ?? null;
    } finally {
        client.release();
    }
}

/** Clear the restore debt after a successful restore, resetting the backoff ladder. */
export async function recordRestoreSuccess(input: {
    tenantId: string;
    serviceId: string;
    hardenedStrategy?: CapacityProviderStrategyItem[];
}): Promise<void> {
    const client = await getPool().connect();
    try {
        await client.query(
            `UPDATE spot_guard_services
                SET "restorePending"      = false,
                    "lastRestoreAt"       = now(),
                    "lastRestoreAttemptAt"= now(),
                    "consecutiveFailures" = 0,
                    "backoffUntil"        = NULL,
                    "restoreCount"        = spot_guard_services."restoreCount" + 1,
                    -- Persist the hardened baseline when the engine asked for it. The
                    -- reference mutated this in memory only and recomputed the same fix
                    -- from stale input every hour, forever.
                    "desiredStrategy"     = COALESCE($3::jsonb, spot_guard_services."desiredStrategy"),
                    "updatedAt"           = now()
              WHERE "tenantId" = $1 AND id = $2`,
            [
                input.tenantId,
                input.serviceId,
                input.hardenedStrategy ? JSON.stringify(input.hardenedStrategy) : null,
            ],
        );
    } finally {
        client.release();
    }
}

/** How many restores this service has had in the trailing 24h — the circuit breaker. */
export async function countRestoresInLast24h(input: { tenantId: string; serviceId: string }): Promise<number> {
    const client = await getPool().connect();
    try {
        const { rows } = await client.query<{ n: string }>(
            `SELECT count(*) AS n
               FROM spot_guard_events
              WHERE "tenantId" = $1
                AND "spotServiceId" = $2
                AND "eventType" = 'restore_succeeded'
                AND "occurredAt" > now() - interval '24 hours'`,
            [input.tenantId, input.serviceId],
        );
        return Number(rows[0]?.n ?? 0);
    } finally {
        client.release();
    }
}

// ── Event timeline ───────────────────────────────────────────────────────────

/**
 * Append a timeline row. ALWAYS called, never gated by alert dedup — the dedup windows
 * throttle Slack only. The reference throttled the alert itself, which was acceptable
 * with no UI, but here the event row is the product surface and punching holes in the
 * timeline during a burst of interruptions would hide exactly what an operator needs.
 *
 * Idempotent via the (tenantId, sourceEventId, eventType) unique index, so pg-boss
 * retries and SQS duplicate deliveries converge instead of double-writing. NULL
 * sourceEventId is unconstrained (NULLs are distinct in a Postgres unique index), which
 * is what lets manual/user-initiated events through unrestricted.
 *
 * Returns the row id, or null when the insert was a duplicate no-op.
 */
export async function writeEvent(input: {
    tenantId: string;
    spotServiceId?: string | null;
    accountId: string;
    region: string;
    clusterName: string;
    serviceName: string;
    eventType: SpotEventType;
    severity?: SpotEventSeverity;
    sourceEventId?: string | null;
    taskArn?: string | null;
    capacityProvider?: string | null;
    fromCapacity?: CapacityType | null;
    toCapacity?: CapacityType | null;
    stopCode?: string | null;
    stoppedReason?: string | null;
    strategyBefore?: CapacityProviderStrategyItem[] | null;
    strategyAfter?: CapacityProviderStrategyItem[] | null;
    message?: string;
    metadata?: Record<string, unknown>;
    actor?: string;
    occurredAt?: Date;
}): Promise<string | null> {
    const client = await getPool().connect();
    try {
        const expiresAt = new Date(Date.now() + SPOT_GUARD_CONFIG.eventTtlDays * DAY_MS);
        const { rows } = await client.query<{ id: string }>(
            `INSERT INTO spot_guard_events
                (id, "tenantId", "spotServiceId", "accountId", region, "clusterName", "serviceName",
                 "eventType", severity, "sourceEventId", "taskArn", "capacityProvider",
                 "fromCapacity", "toCapacity", "stopCode", "stoppedReason",
                 "strategyBefore", "strategyAfter", message, metadata, actor, "occurredAt", "expiresAt")
             VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6,
                     $7, $8, $9, $10, $11, $12, $13, $14, $15,
                     $16::jsonb, $17::jsonb, $18, $19::jsonb, $20, COALESCE($21, now()), $22)
             ON CONFLICT ("tenantId", "sourceEventId", "eventType") DO NOTHING
             RETURNING id`,
            [
                input.tenantId,
                input.spotServiceId ?? null,
                input.accountId,
                input.region,
                input.clusterName,
                input.serviceName,
                input.eventType,
                input.severity ?? 'info',
                input.sourceEventId ?? null,
                input.taskArn ?? null,
                input.capacityProvider ?? null,
                input.fromCapacity ?? null,
                input.toCapacity ?? null,
                input.stopCode ?? null,
                input.stoppedReason ?? null,
                input.strategyBefore ? JSON.stringify(input.strategyBefore) : null,
                input.strategyAfter ? JSON.stringify(input.strategyAfter) : null,
                input.message ?? '',
                JSON.stringify(input.metadata ?? {}),
                input.actor ?? 'system',
                input.occurredAt ?? null,
                expiresAt,
            ],
        );
        return rows[0]?.id ?? null;
    } finally {
        client.release();
    }
}

/** Mark whether Slack delivery happened, for the UI's "suppressed" indicator. */
export async function markEventNotified(input: {
    tenantId: string;
    eventId: string;
    notified: boolean;
    slackError?: string | null;
    suppressedByDedup?: boolean;
}): Promise<void> {
    const client = await getPool().connect();
    try {
        await client.query(
            `UPDATE spot_guard_events
                SET "notifiedSlack" = $3,
                    "slackError"    = $4,
                    metadata        = metadata || $5::jsonb
              WHERE "tenantId" = $1 AND id = $2`,
            [
                input.tenantId,
                input.eventId,
                input.notified,
                input.slackError ?? null,
                JSON.stringify(input.suppressedByDedup ? { suppressedBySlackDedup: true } : {}),
            ],
        );
    } finally {
        client.release();
    }
}

// ── Exactly-once mutation claim ──────────────────────────────────────────────

/**
 * Claim the right to perform one AWS mutation for a (service, action) within the
 * current minute. Returns true only for the winner.
 *
 * DELIBERATELY NOT TENANT-SCOPED, and spot_guard_actions is intentionally absent from
 * TENANT_SCOPED_MODELS. The claim must span tenants: the same AWS account can be
 * registered by multiple tenants, so one event can resolve to N tenants, but
 * ecs:UpdateService acts on ONE AWS resource. actingTenant is recorded for the audit
 * trail, never used as a scope.
 *
 * Same INSERT ... ON CONFLICT DO NOTHING shape as tryClaimTenantRun in
 * jobs/scheduler/services/pg-service.ts. This is layer 2 of 4; the strongest layer is
 * the live-AWS-state idempotency guard in the engine, which holds even if this fails.
 */
export async function claimAction(input: {
    accountId: string;
    clusterArn: string;
    serviceName: string;
    action: SpotGuardActionType;
    actingTenant: string;
}): Promise<boolean> {
    const client = await getPool().connect();
    try {
        const expiresAt = new Date(Date.now() + SPOT_GUARD_CONFIG.actionClaimTtlDays * DAY_MS);
        const { rows } = await client.query<{ id: string }>(
            `INSERT INTO spot_guard_actions
                (id, "accountId", "clusterArn", "serviceName", action, "windowStart", "actingTenant", "expiresAt")
             VALUES (gen_random_uuid()::text, $1, $2, $3, $4, date_trunc('minute', now()), $5, $6)
             ON CONFLICT ("accountId", "clusterArn", "serviceName", action, "windowStart") DO NOTHING
             RETURNING id`,
            [input.accountId, input.clusterArn, input.serviceName, input.action, input.actingTenant, expiresAt],
        );
        return rows.length > 0;
    } catch (err) {
        // FAIL CLOSED. Unlike alert dedup (where a duplicate Slack message is harmless),
        // a false "you may mutate" here could mean N concurrent forceNewDeployment calls
        // on one production service. Same fail-closed choice as tryClaimTenantRun.
        log.error('Action claim failed — refusing the mutation (fail closed)', {
            accountId: input.accountId,
            serviceName: input.serviceName,
            action: input.action,
            error: err instanceof Error ? err.message : String(err),
        });
        return false;
    } finally {
        client.release();
    }
}

// ── Task sessions ────────────────────────────────────────────────────────────

/**
 * Open (or back-fill) a task session on a RUNNING event.
 *
 * Upsert in BOTH directions because EventBridge does not guarantee ordering: a late
 * RUNNING arriving after STOPPED heals an already-closed row — real startedAt lands,
 * the duration is recomputed, and the orphaned flag clears.
 *
 * expiresAt here is the OPEN-row TTL (14d), which is the orphan reaper for a lost
 * STOPPED event. closeSession extends it to the 90-day retention. The reference had no
 * TTL on its open rows at all, so a single lost event leaked a row forever.
 */
export async function openSession(input: {
    tenantId: string;
    accountId: string;
    region: string;
    clusterName: string;
    serviceName: string;
    taskArn: string;
    capacityProvider?: string | null;
    capacityType: CapacityType;
    startedAt: Date;
    cpuUnits?: number | null;
    memoryMiB?: number | null;
}): Promise<void> {
    const client = await getPool().connect();
    try {
        const expiresAt = new Date(input.startedAt.getTime() + SPOT_GUARD_CONFIG.openSessionTtlDays * DAY_MS);
        await client.query(
            `INSERT INTO spot_guard_task_sessions
                (id, "tenantId", "accountId", region, "clusterName", "serviceName", "taskArn",
                 "capacityProvider", "capacityType", "startedAt", "isOpen",
                 "cpuUnits", "memoryMiB", "expiresAt", "updatedAt")
             VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8, $9, true, $10, $11, $12, now())
             ON CONFLICT ("tenantId", "taskArn") DO UPDATE
                SET "startedAt"        = LEAST(spot_guard_task_sessions."startedAt", EXCLUDED."startedAt"),
                    "capacityType"     = EXCLUDED."capacityType",
                    "capacityProvider" = COALESCE(EXCLUDED."capacityProvider", spot_guard_task_sessions."capacityProvider"),
                    "cpuUnits"         = COALESCE(EXCLUDED."cpuUnits", spot_guard_task_sessions."cpuUnits"),
                    "memoryMiB"        = COALESCE(EXCLUDED."memoryMiB", spot_guard_task_sessions."memoryMiB"),
                    -- A late RUNNING for an already-closed row is real data, not an orphan.
                    orphaned           = false,
                    "durationSeconds"  = CASE
                        WHEN spot_guard_task_sessions."stoppedAt" IS NOT NULL
                        THEN GREATEST(0, EXTRACT(EPOCH FROM (spot_guard_task_sessions."stoppedAt"
                             - LEAST(spot_guard_task_sessions."startedAt", EXCLUDED."startedAt"))))
                        ELSE NULL END,
                    "updatedAt"        = now()`,
            [
                input.tenantId,
                input.accountId,
                input.region,
                input.clusterName,
                input.serviceName,
                input.taskArn,
                input.capacityProvider ?? null,
                input.capacityType,
                input.startedAt,
                input.cpuUnits ?? null,
                input.memoryMiB ?? null,
                expiresAt,
            ],
        );
    } finally {
        client.release();
    }
}

/**
 * 'YYYY-MM-DD' for an instant in a given IANA timezone.
 *
 * Computed here rather than in SQL deliberately. The SQL form needed
 * `$n::timestamptz AT TIME ZONE $m` on the same parameter that also feeds a
 * TIMESTAMP(3) column, which Postgres rejects with "inconsistent types deduced for
 * parameter $n". Doing it in TypeScript removes the cast, and makes the
 * timezone/midnight behaviour directly unit-testable instead of only reachable through
 * a database round-trip.
 *
 * 'en-CA' is used because it formats as YYYY-MM-DD; the parts are read explicitly so a
 * locale-data change cannot silently reorder them.
 */
export function reportDateFor(instant: Date, timeZone: string): string {
    try {
        const parts = new Intl.DateTimeFormat('en-CA', {
            timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        }).formatToParts(instant);
        const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
        const [y, m, d] = [get('year'), get('month'), get('day')];
        if (y && m && d) return `${y}-${m}-${d}`;
    } catch {
        // An invalid IANA zone (bad tenant config) must not fail the write — the report
        // label degrades to UTC while the session data, which is what matters, is kept.
        log.warn('Invalid report timezone — falling back to UTC', { timeZone });
    }
    return instant.toISOString().slice(0, 10);
}

/**
 * Close a task session on a STOPPED event.
 *
 * When no RUNNING was ever seen the row is created with startedAt = stoppedAt and
 * orphaned = true, so it is EXCLUDED from reported hours rather than silently counted
 * as a zero-length session. Data loss stays visible.
 *
 * reportDate derives from stoppedAt in the tenant's timezone. Note that reportDate is
 * only a coarse indexed pre-filter and a human-readable label — the hours report clips
 * intervals to the window rather than grouping by this column, which is what actually
 * fixes the reference's midnight-spanning bug.
 */
export async function closeSession(input: {
    tenantId: string;
    accountId: string;
    region: string;
    clusterName: string;
    serviceName: string;
    taskArn: string;
    capacityProvider?: string | null;
    capacityType: CapacityType;
    stoppedAt: Date;
    stopCode?: string | null;
    stoppedReason?: string | null;
    interrupted: boolean;
    timezone?: string;
}): Promise<void> {
    const client = await getPool().connect();
    try {
        const openTtl = new Date(input.stoppedAt.getTime() + SPOT_GUARD_CONFIG.openSessionTtlDays * DAY_MS);
        const closedTtl = new Date(input.stoppedAt.getTime() + SPOT_GUARD_CONFIG.closedSessionTtlDays * DAY_MS);
        await client.query(
            `INSERT INTO spot_guard_task_sessions
                (id, "tenantId", "accountId", region, "clusterName", "serviceName", "taskArn",
                 "capacityProvider", "capacityType", "startedAt", "stoppedAt", "durationSeconds",
                 "reportDate", "stopCode", "stoppedReason", interrupted, orphaned, "isOpen",
                 "expiresAt", "updatedAt")
             VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8,
                     $9, $9, NULL,
                     $13,
                     $10, $11, $12,
                     true,   -- orphaned: no RUNNING was ever observed for this task
                     false,
                     $14, now())
             ON CONFLICT ("tenantId", "taskArn") DO UPDATE
                SET "stoppedAt"       = EXCLUDED."stoppedAt",
                    "durationSeconds" = GREATEST(0, EXTRACT(EPOCH FROM
                                          (EXCLUDED."stoppedAt" - spot_guard_task_sessions."startedAt"))),
                    "reportDate"      = EXCLUDED."reportDate",
                    "stopCode"        = EXCLUDED."stopCode",
                    "stoppedReason"   = EXCLUDED."stoppedReason",
                    interrupted       = spot_guard_task_sessions.interrupted OR EXCLUDED.interrupted,
                    "capacityType"    = spot_guard_task_sessions."capacityType",
                    "isOpen"          = false,
                    orphaned          = false,
                    -- Extend the 14-day orphan TTL to the 90-day retention: this is now
                    -- real report data rather than a possibly-abandoned open row.
                    "expiresAt"       = $15,
                    "updatedAt"       = now()`,
            [
                input.tenantId,
                input.accountId,
                input.region,
                input.clusterName,
                input.serviceName,
                input.taskArn,
                input.capacityProvider ?? null,
                input.capacityType,
                input.stoppedAt,
                input.stopCode ?? null,
                input.stoppedReason ?? null,
                input.interrupted,
                reportDateFor(input.stoppedAt, input.timezone ?? SPOT_GUARD_CONFIG.defaultReportTimezone),
                openTtl,
                closedTtl,
            ],
        );
    } finally {
        client.release();
    }
}

/**
 * Claim the per-task ALB pre-drain exactly once. Returns true only for the first caller.
 *
 * Replaces the reference's separate registry table AND fixes its race: that used a
 * non-atomic GetItem-then-PutItem, so two concurrent invocations could both conclude
 * they were first and both deregister. This is one statement.
 *
 * The INSERT branch exists because the interruption warning frequently arrives before
 * any RUNNING event has created a session row. Such a row is marked orphaned so it
 * cannot contribute bogus hours; a later RUNNING heals it.
 */
export async function claimInterruptionHandling(input: {
    tenantId: string;
    accountId: string;
    region: string;
    clusterName: string;
    serviceName: string;
    taskArn: string;
    capacityType: CapacityType;
    observedAt: Date;
}): Promise<boolean> {
    const client = await getPool().connect();
    try {
        const expiresAt = new Date(input.observedAt.getTime() + SPOT_GUARD_CONFIG.openSessionTtlDays * DAY_MS);
        const { rows } = await client.query<{ id: string }>(
            `INSERT INTO spot_guard_task_sessions
                (id, "tenantId", "accountId", region, "clusterName", "serviceName", "taskArn",
                 "capacityType", "startedAt", "isOpen", interrupted, orphaned,
                 "interruptionHandledAt", "expiresAt", "updatedAt")
             VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8, true, true, true,
                     statement_timestamp(), $9, now())
             ON CONFLICT ("tenantId", "taskArn") DO UPDATE
                SET "interruptionHandledAt" = statement_timestamp(),
                    interrupted             = true,
                    "updatedAt"             = now()
              WHERE spot_guard_task_sessions."interruptionHandledAt" IS NULL
             RETURNING id`,
            [
                input.tenantId,
                input.accountId,
                input.region,
                input.clusterName,
                input.serviceName,
                input.taskArn,
                input.capacityType,
                input.observedAt,
                expiresAt,
            ],
        );
        return rows.length > 0;
    } finally {
        client.release();
    }
}
