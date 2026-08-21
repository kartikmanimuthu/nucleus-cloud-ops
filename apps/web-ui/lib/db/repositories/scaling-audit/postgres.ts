/**
 * ScalingAuditPostgresRepository
 *
 * PostgreSQL implementation of IScalingAuditRepository using Prisma ORM.
 * Reads `scaling_events`, `scaling_audit_runs`, `scaling_audit_watermarks`,
 * `scaling_policy_snapshots`, `scaling_audit_daily_seals`.
 *
 * Multi-tenant safety: every query goes through getTenantClient(tenantId).
 * Read-only by design — no update/delete method exists here or in the interface.
 */
import { getTenantClient } from '@/lib/db/pg-config';
import { istDayRangeFilter } from '@/lib/ist-date-range';
import type {
    IScalingAuditRepository,
    ScalingEvent,
    ScalingEventFilters,
    ScalingEventPage,
    ScalingResourcePage,
    ScalingResourceSummary,
    ScalingAuditSummary,
    ScalingAuditFacets,
    ScalingAuditRun,
    WatermarkGap,
    PolicySnapshot,
    ScalingScope,
    ScalingSource,
    ScalingType,
    RunStatus,
} from './interface';

interface EventRow {
    id: string;
    tenantId: string;
    accountId: string;
    region: string;
    scope: string;
    source: string;
    activityId: string;
    resourceId: string;
    asgName: string | null;
    clusterName: string | null;
    serviceName: string | null;
    scalableDimension: string | null;
    inventoryMatched: boolean;
    scalingType: string;
    policyName: string | null;
    scheduledActionName: string | null;
    alarmName: string | null;
    notScaledCode: string | null;
    cause: string;
    description: string | null;
    statusCode: string | null;
    statusMessage: string | null;
    notScaledReasons: unknown;
    rawPayload: unknown;
    desiredBefore: number | null;
    desiredAfter: number | null;
    minBefore: number | null;
    maxBefore: number | null;
    minAfter: number | null;
    maxAfter: number | null;
    capacityDelta: number | null;
    desiredBeforeSource: string | null;
    peakCpuBeforeScale: number | null;
    peakMemoryBeforeScale: number | null;
    actor: string;
    actorType: string;
    initiatedBy: string | null;
    correlationId: string | null;
    startedAt: Date;
    endedAt: Date | null;
    durationSeconds: number | null;
    reportDateIst: Date;
    capturedByRunId: string;
    capturedAt: Date;
}

function transformEvent(row: EventRow): ScalingEvent {
    return {
        id: row.id,
        tenantId: row.tenantId,
        accountId: row.accountId,
        region: row.region,
        scope: row.scope as ScalingScope,
        source: row.source as ScalingSource,
        activityId: row.activityId,
        resourceId: row.resourceId,
        asgName: row.asgName,
        clusterName: row.clusterName,
        serviceName: row.serviceName,
        scalableDimension: row.scalableDimension,
        inventoryMatched: row.inventoryMatched,
        scalingType: row.scalingType as ScalingType,
        policyName: row.policyName,
        scheduledActionName: row.scheduledActionName,
        alarmName: row.alarmName,
        notScaledCode: row.notScaledCode,
        cause: row.cause,
        description: row.description,
        statusCode: row.statusCode,
        statusMessage: row.statusMessage,
        notScaledReasons: row.notScaledReasons ?? undefined,
        rawPayload: (row.rawPayload as Record<string, unknown>) ?? {},
        desiredBefore: row.desiredBefore,
        desiredAfter: row.desiredAfter,
        minBefore: row.minBefore,
        maxBefore: row.maxBefore,
        minAfter: row.minAfter,
        maxAfter: row.maxAfter,
        capacityDelta: row.capacityDelta,
        desiredBeforeSource: row.desiredBeforeSource as 'activity' | 'cloudwatch' | null,
        peakCpuBeforeScale: row.peakCpuBeforeScale,
        peakMemoryBeforeScale: row.peakMemoryBeforeScale,
        actor: row.actor,
        actorType: row.actorType,
        initiatedBy: row.initiatedBy,
        correlationId: row.correlationId,
        startedAt: row.startedAt.toISOString(),
        endedAt: row.endedAt ? row.endedAt.toISOString() : null,
        durationSeconds: row.durationSeconds,
        reportDateIst: row.reportDateIst.toISOString().slice(0, 10),
        capturedByRunId: row.capturedByRunId,
        capturedAt: row.capturedAt.toISOString(),
    };
}

/**
 * Status codes meaning "the action was recorded but capacity never moved".
 * 'Unfulfilled' is Application Auto Scaling's terminal state for a desired-count
 * change that ECS could not place; ASG uses 'Failed' (e.g. a Spot launch that
 * could not be satisfied) and 'Cancelled'.
 */
const NON_EFFECTIVE_STATUS_CODES = ['Failed', 'Cancelled', 'Unfulfilled'];

/**
 * Application Auto Scaling's description prefix for a guardrail-only change —
 * the min/max bounds moved but desired count was untouched, so nothing scaled.
 * Matched on the description prefix rather than a substring so it cannot
 * accidentally catch an ASG row whose failure text happens to contain the word
 * "capacity" (e.g. "UnfulfillableCapacity - Unable to fulfill capacity ...").
 */
const BOUNDS_ONLY_DESCRIPTION_PREFIXES = ['Setting min capacity', 'Setting max capacity'];

/**
 * Restrict to rows where capacity genuinely moved.
 *
 * Derived at QUERY time and deliberately never stored: `scaling_events` is
 * append-only (REVOKE UPDATE + a BEFORE UPDATE/DELETE trigger — see the
 * migration), so a stored column could never be backfilled onto rows already
 * captured. Deriving from the raw AWS fields keeps a single definition that
 * behaves identically on historical and freshly-captured rows, which is the same
 * reason `derivationVersion` exists on the table.
 */
function capacityChangePredicates(): Array<Record<string, unknown>> {
    return [
        // AWS evaluated the policy and chose not to act. Both columns are written
        // together by applyNotScaledOverride(), but a NotScaledReasons entry with
        // no Code would leave notScaledCode null — so exclude on both.
        { notScaledCode: null },
        { scalingType: { not: 'not_scaled' } },
        // Attempted but never took effect. statusCode is null for source='platform'
        // rows (our own scheduler's scale actions, which are real capacity changes),
        // so null must pass — a bare notIn would drop them, since SQL NOT IN is
        // null-valued for NULL input.
        { OR: [{ statusCode: null }, { statusCode: { notIn: NON_EFFECTIVE_STATUS_CODES } }] },
        // Guardrail-only bound changes.
        {
            NOT: {
                OR: BOUNDS_ONLY_DESCRIPTION_PREFIXES.map((prefix) => ({
                    description: { startsWith: prefix },
                })),
            },
        },
    ];
}

function buildEventWhere(filters: Omit<ScalingEventFilters, 'page' | 'limit'>): Record<string, unknown> {
    const { tenantId, accountId, region, scope, source, scalingType, excludeScalingTypes, resourceId, searchTerm, dateFrom, dateTo, effect } = filters;
    const where: Record<string, unknown> = { tenantId };
    // Composed into AND so it can never clobber the caller's own scalingType /
    // OR (search) clauses, and so 'all' stays a byte-for-byte unfiltered read.
    if (effect !== 'all') {
        where.AND = capacityChangePredicates();
    }
    if (accountId) where.accountId = accountId;
    if (region) where.region = region;
    if (scope) where.scope = scope;
    if (source) where.source = source;
    if (scalingType) where.scalingType = scalingType;
    else if (excludeScalingTypes?.length) where.scalingType = { notIn: excludeScalingTypes };
    if (resourceId) where.resourceId = resourceId;
    const dayRange = istDayRangeFilter(dateFrom, dateTo);
    if (dayRange) where.startedAt = dayRange;
    if (searchTerm?.trim()) {
        const term = searchTerm.trim();
        where.OR = [
            { resourceId: { contains: term, mode: 'insensitive' } },
            { asgName: { contains: term, mode: 'insensitive' } },
            { serviceName: { contains: term, mode: 'insensitive' } },
            { clusterName: { contains: term, mode: 'insensitive' } },
            { cause: { contains: term, mode: 'insensitive' } },
        ];
    }
    return where;
}

export class ScalingAuditPostgresRepository implements IScalingAuditRepository {
    async listEvents(filters: ScalingEventFilters): Promise<ScalingEventPage> {
        const { tenantId, page = 1, limit = 25 } = filters;
        const skip = (page - 1) * limit;
        const where = buildEventWhere(filters);

        const client = getTenantClient(tenantId);
        const [total, rows] = await Promise.all([
            client.scalingEvent.count({ where }),
            client.scalingEvent.findMany({ where, skip, take: limit, orderBy: { startedAt: 'desc' } }),
        ]);
        return { events: (rows as EventRow[]).map(transformEvent), total };
    }

    /**
     * Resource-centric roll-up: one row per (resource, account, region) with its
     * event count and time span. Honours the same filters as listEvents, so the
     * counts shown always match what a click-through will display — including the
     * capacity-changes-only default.
     *
     * Grouped in SQL rather than by loading events and reducing in JS: a busy
     * tenant has thousands of events and only a handful of resources.
     */
    async listResources(filters: ScalingEventFilters): Promise<ScalingResourcePage> {
        const { tenantId, page = 1, limit = 25 } = filters;
        const where = buildEventWhere(filters);
        const client = getTenantClient(tenantId);

        const groups = await client.scalingEvent.groupBy({
            by: ['resourceId', 'scope', 'accountId', 'region', 'asgName', 'clusterName', 'serviceName'],
            where,
            _count: { _all: true },
            _min: { startedAt: true },
            _max: { startedAt: true },
        });

        // Most-recently-active first — the resource someone is investigating is
        // almost always the one that just changed.
        const sorted = (groups as Array<Record<string, unknown>>).sort((a, b) => {
            const am = (a._max as { startedAt: Date | null })?.startedAt?.getTime() ?? 0;
            const bm = (b._max as { startedAt: Date | null })?.startedAt?.getTime() ?? 0;
            return bm - am;
        });

        const skip = (page - 1) * limit;
        const resources: ScalingResourceSummary[] = sorted.slice(skip, skip + limit).map((g) => {
            const scope = g.scope as ScalingScope;
            const asgName = (g.asgName as string | null) ?? null;
            const serviceName = (g.serviceName as string | null) ?? null;
            return {
                resourceId: g.resourceId as string,
                scope,
                accountId: g.accountId as string,
                region: g.region as string,
                asgName,
                clusterName: (g.clusterName as string | null) ?? null,
                serviceName,
                eventCount: (g._count as { _all: number })._all,
                firstEventAt: ((g._min as { startedAt: Date }).startedAt).toISOString(),
                lastEventAt: ((g._max as { startedAt: Date }).startedAt).toISOString(),
                // Falls back to resourceId so a row is never unlabelled, even if a
                // source omitted the friendly name.
                displayName: (scope === 'asg' ? asgName : serviceName) ?? (g.resourceId as string),
            };
        });

        return { resources, total: sorted.length };
    }

    async getEvent(id: string, tenantId: string): Promise<ScalingEvent | null> {
        const client = getTenantClient(tenantId);
        const row = await client.scalingEvent.findFirst({ where: { id, tenantId } });
        return row ? transformEvent(row as EventRow) : null;
    }

    async listAllEvents(filters: Omit<ScalingEventFilters, 'page' | 'limit'>, maxRows: number): Promise<ScalingEvent[]> {
        const where = buildEventWhere(filters);
        const client = getTenantClient(filters.tenantId);
        const rows = await client.scalingEvent.findMany({ where, take: maxRows, orderBy: { startedAt: 'desc' } });
        return (rows as EventRow[]).map(transformEvent);
    }

    async getSummary(tenantId: string): Promise<ScalingAuditSummary> {
        const client = getTenantClient(tenantId);
        const [total, byScalingType, byScope, bySource, openGaps, lastRun] = await Promise.all([
            client.scalingEvent.count({ where: { tenantId } }),
            client.scalingEvent.groupBy({ by: ['scalingType'], where: { tenantId }, _count: { _all: true } }),
            client.scalingEvent.groupBy({ by: ['scope'], where: { tenantId }, _count: { _all: true } }),
            client.scalingEvent.groupBy({ by: ['source'], where: { tenantId }, _count: { _all: true } }),
            client.scalingAuditWatermark.count({ where: { tenantId, gapDetected: true } }),
            client.scalingAuditRun.findFirst({ where: { tenantId }, orderBy: { startedAt: 'desc' } }),
        ]);

        const toCountMap = (g: Array<Record<string, unknown>>, key: string) =>
            g.reduce((acc: Record<string, number>, r) => {
                acc[String(r[key])] = (r._count as { _all: number })._all;
                return acc;
            }, {});

        return {
            totalEvents: total,
            byScalingType: toCountMap(byScalingType as never, 'scalingType'),
            byScope: toCountMap(byScope as never, 'scope'),
            bySource: toCountMap(bySource as never, 'source'),
            openGaps,
            lastRunAt: lastRun ? lastRun.startedAt.toISOString() : null,
            lastRunStatus: lastRun ? (lastRun.status as RunStatus) : null,
        };
    }

    async getFacets(tenantId: string): Promise<ScalingAuditFacets> {
        const client = getTenantClient(tenantId);
        const [accounts, regions, scalingTypes] = await Promise.all([
            client.scalingEvent.groupBy({ by: ['accountId'], where: { tenantId }, orderBy: { accountId: 'asc' } }),
            client.scalingEvent.groupBy({ by: ['region'], where: { tenantId }, orderBy: { region: 'asc' } }),
            client.scalingEvent.groupBy({ by: ['scalingType'], where: { tenantId }, orderBy: { scalingType: 'asc' } }),
        ]);
        return {
            accountIds: (accounts as Array<{ accountId: string }>).map((r) => r.accountId),
            regions: (regions as Array<{ region: string }>).map((r) => r.region),
            scalingTypes: (scalingTypes as Array<{ scalingType: string }>).map((r) => r.scalingType as ScalingType),
        };
    }

    async listRuns(tenantId: string, page = 1, limit = 25): Promise<{ runs: ScalingAuditRun[]; total: number }> {
        const skip = (page - 1) * limit;
        const client = getTenantClient(tenantId);
        const [total, rows] = await Promise.all([
            client.scalingAuditRun.count({ where: { tenantId } }),
            client.scalingAuditRun.findMany({ where: { tenantId }, skip, take: limit, orderBy: { startedAt: 'desc' } }),
        ]);
        const runs: ScalingAuditRun[] = rows.map((row) => ({
            id: row.id,
            tenantId: row.tenantId,
            status: row.status as RunStatus,
            trigger: row.trigger as ScalingAuditRun['trigger'],
            accountsScanned: row.accountsScanned,
            scopesPolled: row.scopesPolled,
            eventsSeen: row.eventsSeen,
            eventsCaptured: row.eventsCaptured,
            policySnapshots: row.policySnapshots,
            gapsDetected: row.gapsDetected,
            apiCallCount: row.apiCallCount,
            errors: Array.isArray(row.errors) ? (row.errors as unknown[]) : [],
            startedAt: row.startedAt.toISOString(),
            finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
        }));
        return { runs, total };
    }

    async getWatermarkGaps(tenantId: string): Promise<WatermarkGap[]> {
        const client = getTenantClient(tenantId);
        const rows = await client.scalingAuditWatermark.findMany({
            where: { tenantId, gapDetected: true },
            orderBy: { updatedAt: 'desc' },
        });
        return rows.map((row) => ({
            accountId: row.accountId,
            region: row.region,
            scope: row.scope as ScalingScope,
            source: row.source,
            gapFromAt: row.gapFromAt ? row.gapFromAt.toISOString() : null,
            gapToAt: row.gapToAt ? row.gapToAt.toISOString() : null,
            gapReason: row.gapReason,
            lastPolledAt: row.lastPolledAt ? row.lastPolledAt.toISOString() : null,
        }));
    }

    async listPolicySnapshots(tenantId: string, accountId: string, region: string, resourceId: string): Promise<PolicySnapshot[]> {
        const client = getTenantClient(tenantId);
        const rows = await client.scalingPolicySnapshot.findMany({
            where: { tenantId, accountId, region, resourceId },
            orderBy: { lastSeenAt: 'desc' },
        });
        return rows.map((row) => ({
            id: row.id,
            accountId: row.accountId,
            region: row.region,
            scope: row.scope as ScalingScope,
            resourceId: row.resourceId,
            configHash: row.configHash,
            policies: Array.isArray(row.policies) ? (row.policies as unknown[]) : [],
            scheduledActions: Array.isArray(row.scheduledActions) ? (row.scheduledActions as unknown[]) : [],
            minCapacity: row.minCapacity,
            maxCapacity: row.maxCapacity,
            firstSeenAt: row.firstSeenAt.toISOString(),
            lastSeenAt: row.lastSeenAt.toISOString(),
        }));
    }

    async getLatestSeal(tenantId: string): Promise<{ day: string; seal: string; rowCount: number } | null> {
        const client = getTenantClient(tenantId);
        const row = await client.scalingAuditDailySeal.findFirst({ where: { tenantId }, orderBy: { day: 'desc' } });
        if (!row) return null;
        return { day: row.day.toISOString().slice(0, 10), seal: row.seal, rowCount: row.rowCount };
    }
}
