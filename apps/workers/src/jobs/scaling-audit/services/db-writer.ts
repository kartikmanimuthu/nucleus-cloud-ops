// workers/src/jobs/scaling-audit/services/db-writer.ts
//
// Raw-pg persistence for the scaling-audit worker (SA-001).
// NOTE: raw SQL is NOT intercepted by any tenant extension — every query here
// scopes tenantId manually (CLAUDE.md gotcha, same as right-sizing/db-writer.ts).
import type { PoolClient } from 'pg';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import { getPool } from '../../discovery/services/db.js';
import { createLogger } from '../../../lib/logger.js';
import { causeFingerprint, inventoryIdentityKeys } from './normalize.js';
import { SCALING_AUDIT_CONFIG } from '../config.js';
import type { Account } from '../../discovery/types.js';
import type {
    CoverageRow,
    CoverageStatus,
    NormalizedScalingEvent,
    RunStatus,
    RunTrigger,
    ScalingScope,
    PolledSource,
    ScopeWatermark,
} from '../types.js';

dayjs.extend(utc);
dayjs.extend(timezone);

const log = createLogger('scaling-audit-db-writer');

function reportDateIst(date: Date): string {
    return dayjs(date).tz(SCALING_AUDIT_CONFIG.reportTimezone).format('YYYY-MM-DD');
}

// ── Account eligibility ────────────────────────────────────────────────────────

/**
 * Accounts within this tenant that have opted into the scaling-audit poll
 * (Account.scalingAuditEnabled, mirroring Spot Guard's spotAutomationEnabled).
 * The stack-level SCALING_AUDIT_ENABLED flag (env.ts / index.ts) gates whether
 * this job runs AT ALL; this is the second, per-account layer — turning the
 * stack flag on must not silently start polling every account in every tenant.
 */
export async function getScalingAuditEligibleAccounts(tenantId: string): Promise<Account[]> {
    const client: PoolClient = await getPool().connect();
    try {
        const result = await client.query(
            `SELECT id, "tenantId", "accountId", name, "roleArn", "externalId", regions, active
             FROM accounts
             WHERE "tenantId" = $1 AND active = true AND "scalingAuditEnabled" = true`,
            [tenantId]
        );
        return result.rows;
    } finally {
        client.release();
    }
}

/**
 * Single-account version of the eligibility check above, for the scheduler's
 * synchronous platform-recorder path (platform-recorder.ts) — that path never
 * loads the full eligible-accounts list, so it has no way to know the opt-in
 * without asking directly. Without this, a scheduler-driven ASG/ECS mutation
 * would record a compliance row for an account with Scale Sentinel switched
 * off, silently ignoring the same toggle the AWS-poll side already respects.
 */
export async function isScalingAuditEnabledForAccount(tenantId: string, accountId: string): Promise<boolean> {
    const client: PoolClient = await getPool().connect();
    try {
        const result = await client.query(
            `SELECT 1 FROM accounts
             WHERE "tenantId" = $1 AND "accountId" = $2 AND active = true AND "scalingAuditEnabled" = true
             LIMIT 1`,
            [tenantId, accountId]
        );
        return (result.rowCount ?? 0) > 0;
    } finally {
        client.release();
    }
}

// ── Inventory enrichment ──────────────────────────────────────────────────────

const INVENTORY_RESOURCE_TYPE: Record<'asg' | 'ecs', string> = {
    asg: 'autoscaling_auto_scaling_groups',
    ecs: 'ecs_services',
};

/**
 * Known resource identities for a scope, for the inventoryMatched signal.
 * ecs/asg only — RDS/MSK/ElastiCache/DocDB live under different inventory
 * resource types this lookup was never built to match.
 *
 * Each inventory row is expanded to every equivalent identity via
 * inventoryIdentityKeys(), because discovery records ECS services by ARN while
 * Application Auto Scaling reports them as "service/<cluster>/<name>" — the same
 * resource under two formats that never compare equal. See that function for the
 * full explanation.
 */
export async function getInventoryResourceIds(tenantId: string, accountId: string, scope: 'asg' | 'ecs'): Promise<Set<string>> {
    const client: PoolClient = await getPool().connect();
    try {
        const result = await client.query(
            `SELECT "resourceId" FROM inventory_resources
             WHERE "tenantId" = $1 AND "accountId" = $2 AND "resourceType" = $3 AND "isCurrent" = true`,
            [tenantId, accountId, INVENTORY_RESOURCE_TYPE[scope]]
        );
        return new Set(result.rows.flatMap((r) => inventoryIdentityKeys(r.resourceId as string)));
    } finally {
        client.release();
    }
}

// ── Watermarks ─────────────────────────────────────────────────────────────────

/** Each polled source holds its own position for the same scope — see the
 *  unique key widened in 20260805150000_scaling_audit_cloudtrail_source. */
export async function getWatermark(
    tenantId: string,
    accountId: string,
    region: string,
    scope: ScalingScope,
    source: PolledSource
): Promise<ScopeWatermark> {
    const client: PoolClient = await getPool().connect();
    try {
        const result = await client.query(
            `SELECT "lastActivityAt", "lastActivityId" FROM scaling_audit_watermarks
             WHERE "tenantId" = $1 AND "accountId" = $2 AND region = $3 AND scope = $4 AND "source" = $5`,
            [tenantId, accountId, region, scope, source]
        );
        const row = result.rows[0];
        return {
            accountId,
            region,
            scope,
            source,
            lastActivityAt: row?.lastActivityAt ?? null,
            lastActivityId: row?.lastActivityId ?? null,
        };
    } finally {
        client.release();
    }
}

export interface WatermarkUpdate {
    lastActivityAt?: Date | null;
    lastActivityId?: string | null;
    lastRunId: string;
    success: boolean;
    /** Set when the poll failed OR when the gap ceiling was crossed. */
    gap?: { fromAt: Date | null; toAt: Date | null; reason: string } | null;
}

/** Upsert the per-(account, region, scope, source) watermark. Never advances past
 *  a non-terminal activity — callers must pass the oldest in-flight StartTime
 *  instead of the newest when any in-progress activity was seen. */
export async function upsertWatermark(
    tenantId: string,
    accountId: string,
    region: string,
    scope: ScalingScope,
    source: PolledSource,
    update: WatermarkUpdate
): Promise<void> {
    const client: PoolClient = await getPool().connect();
    try {
        await client.query(
            `INSERT INTO scaling_audit_watermarks
                (id, "tenantId", "accountId", region, scope, "source", "lastActivityAt", "lastActivityId",
                 "lastPolledAt", "lastRunId", "consecutiveFailures", "gapDetected", "gapFromAt", "gapToAt", "gapReason", "updatedAt")
             VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $13, $5, $6, now(), $7,
                     CASE WHEN $8 THEN 0 ELSE 1 END, $9, $10, $11, $12, now())
             ON CONFLICT ("tenantId", "accountId", region, scope, "source") DO UPDATE SET
                "lastActivityAt" = COALESCE(EXCLUDED."lastActivityAt", scaling_audit_watermarks."lastActivityAt"),
                "lastActivityId" = COALESCE(EXCLUDED."lastActivityId", scaling_audit_watermarks."lastActivityId"),
                "lastPolledAt" = now(),
                "lastRunId" = EXCLUDED."lastRunId",
                "consecutiveFailures" = CASE WHEN $8 THEN 0 ELSE scaling_audit_watermarks."consecutiveFailures" + 1 END,
                "gapDetected" = EXCLUDED."gapDetected",
                "gapFromAt" = EXCLUDED."gapFromAt",
                "gapToAt" = EXCLUDED."gapToAt",
                "gapReason" = EXCLUDED."gapReason",
                "updatedAt" = now()`,
            [
                tenantId, accountId, region, scope,
                update.lastActivityAt ?? null, update.lastActivityId ?? null, update.lastRunId,
                update.success,
                !!update.gap, update.gap?.fromAt ?? null, update.gap?.toAt ?? null, update.gap?.reason ?? null,
                source, // $13
            ]
        );
    } finally {
        client.release();
    }
}

// ── Coverage attestation ──────────────────────────────────────────────────────

/** Written BEFORE the fetch as 'failed', so a crash mid-poll leaves a visible
 *  failure row rather than no row at all. Callers flip it via updateCoverage(). */
export async function createCoverageRow(row: Omit<CoverageRow, 'status' | 'activityCount' | 'apiCallCount' | 'pagesFetched' | 'truncated'>): Promise<string> {
    const client: PoolClient = await getPool().connect();
    try {
        const result = await client.query(
            `INSERT INTO scaling_audit_coverage
                (id, "tenantId", "accountId", region, scope, source, "windowStart", "windowEnd",
                 status, "runId", "attemptedAt")
             VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, 'failed', $8, now())
             RETURNING id`,
            [row.tenantId, row.accountId, row.region, row.scope, row.source, row.windowStart, row.windowEnd, row.runId]
        );
        return result.rows[0].id as string;
    } finally {
        client.release();
    }
}

export async function updateCoverageRow(
    id: string,
    fields: {
        status: CoverageStatus;
        reason?: string;
        activityCount: number;
        apiCallCount: number;
        pagesFetched: number;
        truncated: boolean;
        oldestActivitySeenAt?: Date | null;
        newestActivitySeenAt?: Date | null;
    }
): Promise<void> {
    const client: PoolClient = await getPool().connect();
    try {
        await client.query(
            `UPDATE scaling_audit_coverage SET
                status = $2, reason = $3, "activityCount" = $4, "apiCallCount" = $5,
                "pagesFetched" = $6, truncated = $7, "oldestActivitySeenAt" = $8, "newestActivitySeenAt" = $9
             WHERE id = $1`,
            [
                id, fields.status, fields.reason ?? null, fields.activityCount, fields.apiCallCount,
                fields.pagesFetched, fields.truncated, fields.oldestActivitySeenAt ?? null, fields.newestActivitySeenAt ?? null,
            ]
        );
    } finally {
        client.release();
    }
}

// ── Events ─────────────────────────────────────────────────────────────────────

const EVENT_COLUMNS = [
    'tenantId', 'accountId', 'region', 'scope', 'source', 'activityId', 'resourceId',
    'asgName', 'clusterName', 'serviceName', 'scalableDimension', 'inventoryMatched',
    'scalingType', 'policyName', 'scheduledActionName', 'alarmName', 'notScaledCode',
    'derivationVersion', 'causeFingerprint', 'cause', 'description', 'statusCode',
    'statusMessage', 'notScaledReasons', 'rawPayload', 'desiredBefore', 'desiredAfter',
    'minBefore', 'maxBefore', 'minAfter', 'maxAfter', 'capacityDelta',
    'desiredBeforeSource', 'peakCpuBeforeScale', 'peakMemoryBeforeScale',
    'actor', 'actorType',
    'initiatedBy', 'correlationId', 'startedAt', 'endedAt', 'durationSeconds', 'reportDateIst',
    'capturedByRunId',
] as const;

const INSERT_EVENT_SQL = (() => {
    const colList = EVENT_COLUMNS.map((c) => `"${c}"`).join(', ');
    const placeholders = EVENT_COLUMNS.map((_, i) => `$${i + 1}`).join(', ');
    return `INSERT INTO scaling_events (id, ${colList})
            VALUES (gen_random_uuid()::text, ${placeholders})
            ON CONFLICT ("tenantId", source, "activityId") DO NOTHING
            RETURNING id`;
})();

/** Idempotent insert — a re-poll that overlaps the watermark inserts 0 rows for
 *  activities already captured. Returns the count actually inserted (not seen). */
export async function insertEvents(events: NormalizedScalingEvent[], runId: string): Promise<number> {
    if (!events.length) return 0;
    const client: PoolClient = await getPool().connect();
    let inserted = 0;
    try {
        for (const e of events) {
            const durationSeconds = e.endedAt ? (e.endedAt.getTime() - e.startedAt.getTime()) / 1000 : null;
            const capacityDelta =
                e.desiredBefore !== undefined && e.desiredAfter !== undefined ? e.desiredAfter - e.desiredBefore : null;
            const values = [
                e.tenantId, e.accountId, e.region, e.scope, e.source, e.activityId, e.resourceId,
                e.asgName ?? null, e.clusterName ?? null, e.serviceName ?? null, e.scalableDimension ?? null, e.inventoryMatched,
                e.scalingType, e.policyName ?? null, e.scheduledActionName ?? null, e.alarmName ?? null, e.notScaledCode ?? null,
                1, causeFingerprint(e.resourceId, e.cause), e.cause, e.description ?? null, e.statusCode ?? null,
                e.statusMessage ?? null, e.notScaledReasons ? JSON.stringify(e.notScaledReasons) : null, JSON.stringify(e.rawPayload ?? {}),
                e.desiredBefore ?? null, e.desiredAfter ?? null,
                e.minBefore ?? null, e.maxBefore ?? null, e.minAfter ?? null, e.maxAfter ?? null, capacityDelta,
                e.desiredBeforeSource ?? null, e.peakCpuBeforeScale ?? null, e.peakMemoryBeforeScale ?? null,
                e.actor, e.actorType, e.initiatedBy ?? null, e.correlationId ?? null,
                e.startedAt, e.endedAt ?? null, durationSeconds, reportDateIst(e.startedAt), runId,
            ];

            const result = await client.query(INSERT_EVENT_SQL, values);
            if ((result.rowCount ?? 0) > 0) inserted += 1;
        }
        return inserted;
    } catch (err) {
        log.error('Error inserting scaling events', { runId, error: err instanceof Error ? err.message : String(err) });
        throw err;
    } finally {
        client.release();
    }
}

// ── Runs ───────────────────────────────────────────────────────────────────────

export async function createRun(tenantId: string, trigger: RunTrigger): Promise<string> {
    const client: PoolClient = await getPool().connect();
    try {
        const r = await client.query(
            `INSERT INTO scaling_audit_runs (id, "tenantId", status, trigger, "startedAt")
             VALUES (gen_random_uuid()::text, $1, 'running', $2, now()) RETURNING id`,
            [tenantId, trigger]
        );
        return r.rows[0].id;
    } finally {
        client.release();
    }
}

export async function finishRun(
    runId: string,
    tenantId: string,
    fields: {
        status: RunStatus;
        accountsScanned: number;
        scopesPolled: number;
        eventsSeen: number;
        eventsCaptured: number;
        policySnapshots: number;
        gapsDetected: number;
        apiCallCount: number;
        errors: unknown[];
    }
): Promise<void> {
    const client: PoolClient = await getPool().connect();
    try {
        await client.query(
            `UPDATE scaling_audit_runs SET
                status = $3, "accountsScanned" = $4, "scopesPolled" = $5, "eventsSeen" = $6,
                "eventsCaptured" = $7, "policySnapshots" = $8, "gapsDetected" = $9,
                "apiCallCount" = $10, errors = $11::jsonb, "finishedAt" = now()
             WHERE id = $1 AND "tenantId" = $2`,
            [
                runId, tenantId, fields.status, fields.accountsScanned, fields.scopesPolled,
                fields.eventsSeen, fields.eventsCaptured, fields.policySnapshots, fields.gapsDetected,
                fields.apiCallCount, JSON.stringify(fields.errors),
            ]
        );
    } finally {
        client.release();
    }
}

export async function hasActiveRun(tenantId: string): Promise<boolean> {
    const client: PoolClient = await getPool().connect();
    try {
        const r = await client.query(
            `SELECT 1 FROM scaling_audit_runs WHERE "tenantId" = $1 AND status IN ('queued', 'running') LIMIT 1`,
            [tenantId]
        );
        return (r.rowCount ?? 0) > 0;
    } finally {
        client.release();
    }
}

/** Whether this tenant has ever finished a run — used to label the very first
 *  run 'backfill' instead of 'schedule', since it may page back up to
 *  awsRetentionDays worth of history in one go. */
// ── Network link samples (Network Pulse) ───────────────────────────────────────

export interface NetworkLinkSampleInput {
    accountId: string;
    region: string;
    resourceType: 'dx_connection' | 'vpn_tunnel';
    resourceId: string;
    displayName?: string | null;
    installedBandwidthMbps?: number | null;
    bpsAvgIn?: number | null;
    bpsMaxIn?: number | null;
    bpsAvgOut?: number | null;
    bpsMaxOut?: number | null;
    stateUp?: boolean | null;
    bucketStartUtc: Date;
}

/** Idempotent upsert of hourly DX/VPN bandwidth samples — DO UPDATE (not DO
 *  NOTHING like insertEvents), since a later poll's fresher CloudWatch read
 *  for an already-captured hour should overwrite it, same reasoning as
 *  upsertWatermark. Returns the number of rows written. */
export async function upsertNetworkLinkSamples(tenantId: string, samples: NetworkLinkSampleInput[]): Promise<number> {
    if (!samples.length) return 0;
    const client: PoolClient = await getPool().connect();
    let written = 0;
    try {
        for (const s of samples) {
            const result = await client.query(
                `INSERT INTO network_link_samples
                    (id, "tenantId", "accountId", region, "resourceType", "resourceId", "displayName",
                     "installedBandwidthMbps", "bpsAvgIn", "bpsMaxIn", "bpsAvgOut", "bpsMaxOut", "stateUp",
                     "bucketStartUtc")
                 VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                 ON CONFLICT ("tenantId", "resourceType", "resourceId", "bucketStartUtc") DO UPDATE SET
                    "accountId" = EXCLUDED."accountId",
                    region = EXCLUDED.region,
                    "displayName" = EXCLUDED."displayName",
                    "installedBandwidthMbps" = EXCLUDED."installedBandwidthMbps",
                    "bpsAvgIn" = EXCLUDED."bpsAvgIn",
                    "bpsMaxIn" = EXCLUDED."bpsMaxIn",
                    "bpsAvgOut" = EXCLUDED."bpsAvgOut",
                    "bpsMaxOut" = EXCLUDED."bpsMaxOut",
                    "stateUp" = EXCLUDED."stateUp"`,
                [
                    tenantId, s.accountId, s.region, s.resourceType, s.resourceId, s.displayName ?? null,
                    s.installedBandwidthMbps ?? null, s.bpsAvgIn ?? null, s.bpsMaxIn ?? null,
                    s.bpsAvgOut ?? null, s.bpsMaxOut ?? null, s.stateUp ?? null, s.bucketStartUtc,
                ]
            );
            if ((result.rowCount ?? 0) > 0) written += 1;
        }
        return written;
    } catch (err) {
        log.error('Error upserting network link samples', { tenantId, error: err instanceof Error ? err.message : String(err) });
        throw err;
    } finally {
        client.release();
    }
}

export async function hasCompletedRun(tenantId: string): Promise<boolean> {
    const client: PoolClient = await getPool().connect();
    try {
        const r = await client.query(
            `SELECT 1 FROM scaling_audit_runs WHERE "tenantId" = $1 AND status IN ('completed', 'partial') LIMIT 1`,
            [tenantId]
        );
        return (r.rowCount ?? 0) > 0;
    } finally {
        client.release();
    }
}
