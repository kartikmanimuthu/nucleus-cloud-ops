/**
 * SpotGuardPostgresRepository
 *
 * Prisma-backed persistence for Fargate Spot Guard.
 *
 * Every method goes through getTenantClient(tenantId), which injects tenantId into reads,
 * writes and deletes automatically. The two $queryRaw methods are the exception — raw SQL
 * is NOT intercepted by that extension (documented in lib/db/pg-config.ts), so they bind
 * tenantId explicitly as $1. Both are marked with a comment saying so.
 */
import { andWhere, getTenantClient } from '@/lib/db/pg-config';
import type {
    CapacityProviderStrategyItem,
    CapacityState,
    EligibleFilters,
    EligibleService,
    EventFilters,
    HoursReport,
    HoursReportRow,
    ISpotGuardRepository,
    ManagementState,
    ServiceFilters,
    SpotGuardFacets,
    ServiceUpsert,
    SpotEligibility,
    SpotGuardEvent,
    SpotGuardService,
    SpotGuardSummary,
} from './interface';

const SECONDS_PER_HOUR = 3600;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Prisma returns Json columns as `unknown`; narrow to the strategy array shape. */
function asStrategy(value: unknown): CapacityProviderStrategyItem[] {
    return Array.isArray(value) ? (value as CapacityProviderStrategyItem[]) : [];
}

function asMetadata(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

const iso = (d: Date | null | undefined): string | null | undefined =>
    d === null ? null : d === undefined ? undefined : d.toISOString();

/**
 * Fill in observedStrategy for rows that have none, from the discovery inventory.
 *
 * Why any row lacks one: the task-state event handler is the highest-volume path in the feature
 * and deliberately makes no DescribeServices call, deriving capacity from the event's
 * capacityProviderName alone. A registry row it creates therefore has an empty strategy, and the
 * Strategy column rendered "—" until some slower, mutating path happened to look — which meant
 * most managed services showed nothing at all.
 *
 * Discovery already captures capacityProviderStrategy on every ecs_services row, so this borrows
 * it: no extra AWS calls, and the hot event path stays untouched. Rows filled this way are
 * flagged, because the value is only as fresh as the last discovery scan.
 *
 * Returns the same array when nothing needs filling, so the common case costs no query.
 */
async function backfillStrategyFromInventory(
    tenantId: string,
    services: SpotGuardService[],
): Promise<SpotGuardService[]> {
    const gaps = services.filter((s) => s.observedStrategy.length === 0);
    if (gaps.length === 0) return services;

    const accountIds = [...new Set(gaps.map((s) => s.accountId))];
    const names = [...new Set(gaps.map((s) => s.serviceName))];

    // Raw because the value lives in JSONB that discovery writes. Scoped by tenant AND by the
    // accounts/names actually on this page, so it never scans a whole tenant's inventory.
    const rows = await getTenantClient(tenantId).$queryRawUnsafe<
        Array<{ accountId: string; region: string; name: string; strategy: unknown }>
    >(
        `SELECT i."accountId", i.region, i.name, i.metadata -> 'capacityProviderStrategy' AS strategy
           FROM inventory_resources i
          WHERE i."tenantId" = $1
            AND i."resourceType" = 'ecs_services'
            AND i."isCurrent" = true
            AND i."accountId" = ANY($2)
            AND i.name = ANY($3)`,
        tenantId,
        accountIds,
        names,
    );

    const byKey = new Map(rows.map((r) => [`${r.accountId}|${r.region}|${r.name}`, asStrategy(r.strategy)]));
    return services.map((s) => {
        if (s.observedStrategy.length > 0) return s;
        const found = byKey.get(`${s.accountId}|${s.region}|${s.serviceName}`);
        if (!found || found.length === 0) return s;
        return { ...s, observedStrategy: found, strategyFromInventory: true };
    });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function transformService(r: any): SpotGuardService {
    return {
        id: r.id,
        tenantId: r.tenantId,
        accountId: r.accountId,
        region: r.region,
        clusterName: r.clusterName,
        serviceName: r.serviceName,
        clusterArn: r.clusterArn,
        serviceArn: r.serviceArn,
        desiredStrategy: asStrategy(r.desiredStrategy),
        observedStrategy: asStrategy(r.observedStrategy),
        observedAt: iso(r.observedAt),
        capacityState: r.capacityState as CapacityState,
        managementState: r.managementState as ManagementState,
        restorePending: r.restorePending,
        lastFallbackAt: iso(r.lastFallbackAt),
        lastRestoreAt: iso(r.lastRestoreAt),
        lastRestoreAttemptAt: iso(r.lastRestoreAttemptAt),
        lastFailedAt: iso(r.lastFailedAt),
        consecutiveFailures: r.consecutiveFailures,
        backoffUntil: iso(r.backoffUntil),
        desiredCount: r.desiredCount,
        runningCount: r.runningCount,
        serviceStatus: r.serviceStatus,
        albTargetGroupArns: r.albTargetGroupArns ?? [],
        interruptionCount: r.interruptionCount,
        placementFailureCount: r.placementFailureCount,
        fallbackCount: r.fallbackCount,
        restoreCount: r.restoreCount,
        enabledBy: r.enabledBy,
        enabledAt: iso(r.enabledAt),
        disabledBy: r.disabledBy,
        disabledAt: iso(r.disabledAt),
        lastEventAt: iso(r.lastEventAt),
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
        createdBy: r.createdBy ?? 'system',
        updatedBy: r.updatedBy ?? 'system',
    };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function transformEvent(r: any): SpotGuardEvent {
    return {
        id: r.id,
        tenantId: r.tenantId,
        spotServiceId: r.spotServiceId,
        accountId: r.accountId,
        region: r.region,
        clusterName: r.clusterName,
        serviceName: r.serviceName,
        eventType: r.eventType,
        severity: r.severity,
        taskArn: r.taskArn,
        capacityProvider: r.capacityProvider,
        fromCapacity: r.fromCapacity,
        toCapacity: r.toCapacity,
        stopCode: r.stopCode,
        stoppedReason: r.stoppedReason,
        strategyBefore: r.strategyBefore ? asStrategy(r.strategyBefore) : null,
        strategyAfter: r.strategyAfter ? asStrategy(r.strategyAfter) : null,
        message: r.message,
        metadata: asMetadata(r.metadata),
        notifiedSlack: r.notifiedSlack,
        slackError: r.slackError,
        actor: r.actor,
        occurredAt: r.occurredAt.toISOString(),
    };
}

/** Classify a service's Spot eligibility for the UI. See SpotEligibility. */
export function classifyEligibility(
    strategy: CapacityProviderStrategyItem[],
    clusterCapacityProviders: string[],
): SpotEligibility {
    if (strategy.length === 0) return 'needs_capacity_providers';
    if (strategy.some((cp) => /spot/i.test(cp.capacityProvider))) return 'spot_capable';
    // Has a strategy but no Spot provider. Addable only if the cluster actually offers one;
    // otherwise the customer must register FARGATE_SPOT on the cluster first. When
    // discovery has not captured the cluster's providers we optimistically allow it — the
    // enable mutation re-verifies against live AWS and returns 409 if not.
    if (clusterCapacityProviders.length === 0) return 'spot_addable';
    return clusterCapacityProviders.some((cp) => /spot/i.test(cp)) ? 'spot_addable' : 'needs_capacity_providers';
}

export class SpotGuardPostgresRepository implements ISpotGuardRepository {
    /**
     * Distinct regions and cluster names across the tenant's managed services.
     *
     * Drives the region/cluster filter dropdowns. Deliberately NOT derived from the current page
     * of results: filtering to a cluster that happens to be absent from page 1 would remove its
     * own option, which is the bug the account filter avoids the same way.
     *
     * groupBy rather than findMany+dedupe so the work happens in Postgres and the payload is a
     * handful of strings regardless of estate size.
     */
    async getFacets(tenantId: string): Promise<SpotGuardFacets> {
        const db = getTenantClient(tenantId);
        const [regions, clusters] = await Promise.all([
            db.spotGuardService.groupBy({ by: ['region'], orderBy: { region: 'asc' } }),
            db.spotGuardService.groupBy({ by: ['clusterName'], orderBy: { clusterName: 'asc' } }),
        ]);
        return {
            regions: regions.map((r: { region: string }) => r.region),
            clusters: clusters.map((c: { clusterName: string }) => c.clusterName),
        };
    }

    async listServices(filters: ServiceFilters): Promise<{ services: SpotGuardService[]; total: number }> {
        const db = getTenantClient(filters.tenantId);
        const page = Math.max(1, filters.page ?? 1);
        const limit = Math.min(200, Math.max(1, filters.limit ?? 25));

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const where: any = {};
        if (filters.accountId) where.accountId = filters.accountId;
        if (filters.region) where.region = filters.region;
        if (filters.clusterName) where.clusterName = filters.clusterName;
        if (filters.capacityState) where.capacityState = filters.capacityState;
        if (filters.managementState) where.managementState = filters.managementState;
        if (filters.searchTerm) {
            where.OR = [
                { serviceName: { contains: filters.searchTerm, mode: 'insensitive' } },
                { clusterName: { contains: filters.searchTerm, mode: 'insensitive' } },
            ];
        }

        // Gate 3: intersect the caller's readable rows. andWhere() nests under
        // AND so the `OR` search clause above survives, and tenantId is still
        // injected on top by the tenant client.
        const scoped = andWhere(where, filters.rowFilter);

        const [records, total] = await Promise.all([
            db.spotGuardService.findMany({
                where: scoped,
                orderBy: [{ capacityState: 'asc' }, { serviceName: 'asc' }],
                skip: (page - 1) * limit,
                take: limit,
            }),
            db.spotGuardService.count({ where: scoped }),
        ]);
        const services = await backfillStrategyFromInventory(filters.tenantId, records.map(transformService));
        return { services, total };
    }

    async getService(id: string, tenantId: string): Promise<SpotGuardService | null> {
        const record = await getTenantClient(tenantId).spotGuardService.findFirst({ where: { id } });
        return record ? transformService(record) : null;
    }

    async findServiceByTarget(
        tenantId: string,
        target: { accountId: string; region: string; clusterName: string; serviceName: string },
    ): Promise<SpotGuardService | null> {
        // Destructure the four key fields explicitly — do NOT spread `target`.
        //
        // Callers pass a WIDER object than this signature declares: enableSpot's target is a
        // discriminated union whose `discovered` member carries a `kind: 'discovered'` tag.
        // TypeScript only applies excess-property checks to fresh object literals, so passing
        // a variable compiles cleanly and `{ ...target }` leaked `kind` straight into the
        // Prisma `where`, failing at runtime with:
        //     Unknown argument `kind`. Did you mean `id`?
        // Typechecking cannot catch this, so the defence has to live here: name the columns.
        const { accountId, region, clusterName, serviceName } = target;
        const record = await getTenantClient(tenantId).spotGuardService.findFirst({
            where: { accountId, region, clusterName, serviceName },
        });
        return record ? transformService(record) : null;
    }

    async upsertService(tenantId: string, input: ServiceUpsert): Promise<SpotGuardService> {
        const db = getTenantClient(tenantId);
        const existing = await db.spotGuardService.findFirst({
            where: {
                accountId: input.accountId,
                region: input.region,
                clusterName: input.clusterName,
                serviceName: input.serviceName,
            },
        });

        const data = {
            clusterArn: input.clusterArn ?? undefined,
            serviceArn: input.serviceArn ?? undefined,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            desiredStrategy: input.desiredStrategy as any,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            observedStrategy: (input.observedStrategy ?? input.desiredStrategy) as any,
            capacityState: input.capacityState,
            managementState: input.managementState,
            // Task counts were previously written by nothing on this path, so the detail view
            // rendered "? running" indefinitely. Only set when supplied, so a caller without a
            // live describe does not blank a good value.
            ...(input.desiredCount !== undefined ? { desiredCount: input.desiredCount } : {}),
            ...(input.runningCount !== undefined ? { runningCount: input.runningCount } : {}),
            ...(input.enabledBy ? { enabledBy: input.enabledBy, enabledAt: new Date() } : {}),
            ...(input.disabledBy ? { disabledBy: input.disabledBy, disabledAt: new Date() } : {}),
            // Every write records who made it. Left unset for machine-driven upserts so the
            // column default ("system") stands rather than a person being blamed for it.
            ...(input.actor ? { updatedBy: input.actor } : {}),
            ...(input.resetRestoreState ? { restorePending: false, backoffUntil: null } : {}),
        };

        const record = existing
            ? await db.spotGuardService.update({ where: { id: existing.id }, data })
            : await db.spotGuardService.create({
                  // tenantId is passed explicitly even though getTenantClient's extension
                  // injects it at runtime — Prisma's generated types still require it, and
                  // the existing repositories (e.g. right-sizing createRun) do the same.
                  data: {
                      tenantId,
                      accountId: input.accountId,
                      region: input.region,
                      clusterName: input.clusterName,
                      serviceName: input.serviceName,
                      // Insert only — createdBy must never be rewritten by a later update, which
                      // is the whole distinction between it and updatedBy.
                      ...(input.actor ? { createdBy: input.actor } : {}),
                      ...data,
                  },
              });
        return transformService(record);
    }

    async setManagementState(
        id: string,
        tenantId: string,
        state: ManagementState,
        actor: string,
    ): Promise<SpotGuardService> {
        const db = getTenantClient(tenantId);
        // findFirst + update rather than a bare update: the tenant extension scopes the
        // findFirst, so a cross-tenant id yields NOT_FOUND (404) instead of leaking
        // existence via a 403. Same convention as the right-sizing repository.
        const existing = await db.spotGuardService.findFirst({ where: { id } });
        if (!existing) throw new Error('NOT_FOUND');

        const record = await db.spotGuardService.update({
            where: { id },
            data: {
                managementState: state,
                // Leaving management stops future automation; a pending restore must not
                // survive it and fire later.
                ...(state === 'managed' ? {} : { restorePending: false, backoffUntil: null }),
                ...(state === 'opted_out' ? { disabledBy: actor, disabledAt: new Date() } : {}),
                ...(state === 'managed' ? { enabledBy: actor, enabledAt: new Date() } : {}),
                updatedBy: actor,
            },
        });
        return transformService(record);
    }

    async deleteService(id: string, tenantId: string): Promise<void> {
        const db = getTenantClient(tenantId);
        const existing = await db.spotGuardService.findFirst({ where: { id } });
        if (!existing) throw new Error('NOT_FOUND');
        await db.spotGuardService.delete({ where: { id } });
    }

    async listEvents(filters: EventFilters): Promise<{ events: SpotGuardEvent[]; total: number }> {
        const db = getTenantClient(filters.tenantId);
        const page = Math.max(1, filters.page ?? 1);
        const limit = Math.min(200, Math.max(1, filters.limit ?? 50));

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const where: any = {};
        if (filters.spotServiceId) where.spotServiceId = filters.spotServiceId;
        if (filters.accountId) where.accountId = filters.accountId;
        if (filters.serviceName) where.serviceName = filters.serviceName;
        if (filters.eventType) where.eventType = filters.eventType;
        // Multi-type takes precedence: a capacity transition is expressed by several event types,
        // so the capacity view cannot be served by the single-type filter.
        if (filters.eventTypes?.length) where.eventType = { in: filters.eventTypes };
        if (filters.severity) where.severity = filters.severity;
        if (filters.since) where.occurredAt = { gte: new Date(filters.since) };

        const [records, total] = await Promise.all([
            db.spotGuardEvent.findMany({
                where,
                orderBy: { occurredAt: 'desc' },
                skip: (page - 1) * limit,
                take: limit,
            }),
            db.spotGuardEvent.count({ where }),
        ]);
        return { events: records.map(transformEvent), total };
    }

    async recordEvent(
        tenantId: string,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        input: any,
    ): Promise<SpotGuardEvent> {
        const db = getTenantClient(tenantId);
        const record = await db.spotGuardEvent.create({
            // tenantId explicit — see the note in upsertService.
            data: {
                tenantId,
                spotServiceId: input.spotServiceId ?? null,
                accountId: input.accountId,
                region: input.region,
                clusterName: input.clusterName,
                serviceName: input.serviceName,
                eventType: input.eventType,
                severity: input.severity ?? 'info',
                taskArn: input.taskArn ?? null,
                fromCapacity: input.fromCapacity ?? null,
                toCapacity: input.toCapacity ?? null,
                strategyBefore: input.strategyBefore ?? undefined,
                strategyAfter: input.strategyAfter ?? undefined,
                message: input.message ?? '',
                metadata: input.metadata ?? {},
                actor: input.actor ?? 'system',
                // 90-day retention, matching SPOT_GUARD_CONFIG.eventTtlDays and reaped by
                // scripts/cleanup-expired.ts.
                expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
            },
        });
        return transformEvent(record);
    }

    async getSummary(tenantId: string): Promise<SpotGuardSummary> {
        const db = getTenantClient(tenantId);
        const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

        const [managed, onSpot, inFallback, unmanaged, interruptions, placementFailures, latest] = await Promise.all([
            db.spotGuardService.count({ where: { managementState: 'managed' } }),
            db.spotGuardService.count({ where: { managementState: 'managed', capacityState: 'spot' } }),
            db.spotGuardService.count({ where: { managementState: 'managed', capacityState: 'on_demand' } }),
            db.spotGuardService.count({ where: { managementState: { not: 'managed' } } }),
            db.spotGuardEvent.count({ where: { eventType: 'interruption', occurredAt: { gte: since24h } } }),
            db.spotGuardEvent.count({ where: { eventType: 'placement_failure', occurredAt: { gte: since24h } } }),
            db.spotGuardService.findFirst({ orderBy: { lastEventAt: 'desc' }, select: { lastEventAt: true } }),
        ]);

        const hours = await this.getHoursReport(tenantId, { from: since7d, to: new Date() });

        return {
            managedServices: managed,
            servicesOnSpot: onSpot,
            servicesInFallback: inFallback,
            servicesUnmanaged: unmanaged,
            interruptions24h: interruptions,
            placementFailures24h: placementFailures,
            spotHours7d: hours.totals.spotHours,
            onDemandHours7d: hours.totals.onDemandHours,
            spotShare7d: hours.totals.spotShare,
            lastEventAt: latest?.lastEventAt ? latest.lastEventAt.toISOString() : null,
        };
    }

    async getHoursReport(tenantId: string, range: { from: Date; to: Date }): Promise<HoursReport> {
        const db = getTenantClient(tenantId);
        const now = new Date();

        // RAW SQL — NOT intercepted by the tenant extension, so tenantId is bound as $1.
        //
        // Time-weighted interval clipping, mirroring
        // apps/workers/src/jobs/spot-guard/report/query.ts. Grouping by a stored date
        // instead would reintroduce the reference implementation's midnight bug (a task
        // spanning midnight landing wholly on one day), and clipping to LEAST(to, now)
        // stops an in-flight task inventing future hours.
        const rows = await db.$queryRaw<
            Array<{
                accountId: string;
                accountName: string | null;
                region: string;
                clusterName: string;
                serviceName: string;
                capacityType: string;
                seconds: number | string;
                sessions: number | string;
                inFlightSessions: number | string;
                interruptions: number | string;
            }>
        >`
            WITH bounds AS (
                SELECT ${range.from}::timestamptz AS win_start,
                       LEAST(${range.to}::timestamptz, ${now}::timestamptz) AS win_end
            )
            SELECT s."accountId",
                   a.name AS "accountName",
                   s.region,
                   s."clusterName",
                   s."serviceName",
                   s."capacityType",
                   SUM(EXTRACT(EPOCH FROM (
                         LEAST(COALESCE(s."stoppedAt", b.win_end), b.win_end)
                       - GREATEST(s."startedAt", b.win_start)
                   )))                                           AS seconds,
                   COUNT(*)                                      AS sessions,
                   COUNT(*) FILTER (WHERE s."stoppedAt" IS NULL)  AS "inFlightSessions",
                   COUNT(*) FILTER (WHERE s.interrupted)          AS interruptions
              FROM spot_guard_task_sessions s
             CROSS JOIN bounds b
             LEFT JOIN accounts a
                    ON a."tenantId" = s."tenantId" AND a."accountId" = s."accountId"
             WHERE s."tenantId" = ${tenantId}
               AND s.orphaned = false
               AND s."startedAt" < b.win_end
               AND (s."stoppedAt" IS NULL OR s."stoppedAt" > b.win_start)
               AND LEAST(COALESCE(s."stoppedAt", b.win_end), b.win_end) > GREATEST(s."startedAt", b.win_start)
             GROUP BY 1, 2, 3, 4, 5, 6
             ORDER BY 1, 3, 4, 5
        `;

        // RAW SQL — tenantId bound explicitly, same reason as above.
        const quality = await db.$queryRaw<Array<{ orphaned: number | string; staleOpen: number | string }>>`
            SELECT COUNT(*) FILTER (WHERE orphaned) AS orphaned,
                   COUNT(*) FILTER (WHERE "isOpen" AND "startedAt" < ${now}::timestamptz - interval '7 days') AS "staleOpen"
              FROM spot_guard_task_sessions
             WHERE "tenantId" = ${tenantId}
               AND "startedAt" >= ${range.from}::timestamptz
        `;

        // Fold the per-capacityType rows into one row per service.
        const byService = new Map<string, HoursReportRow>();
        for (const r of rows) {
            const key = `${r.accountId}|${r.region}|${r.clusterName}|${r.serviceName}`;
            const row =
                byService.get(key) ??
                ({
                    accountId: r.accountId,
                    accountName: r.accountName ?? undefined,
                    region: r.region,
                    clusterName: r.clusterName,
                    serviceName: r.serviceName,
                    spotSeconds: 0,
                    onDemandSeconds: 0,
                    spotHours: 0,
                    onDemandHours: 0,
                    spotShare: 0,
                    sessions: 0,
                    inFlightSessions: 0,
                    interruptions: 0,
                } satisfies HoursReportRow);
            byService.set(key, row);

            const seconds = Number(r.seconds ?? 0);
            if (r.capacityType === 'spot') row.spotSeconds += seconds;
            else row.onDemandSeconds += seconds;
            row.sessions += Number(r.sessions ?? 0);
            row.inFlightSessions += Number(r.inFlightSessions ?? 0);
            row.interruptions += Number(r.interruptions ?? 0);
        }

        let spotSeconds = 0;
        let onDemandSeconds = 0;
        let interruptions = 0;
        let inFlightSessions = 0;
        for (const row of byService.values()) {
            row.spotHours = round2(row.spotSeconds / SECONDS_PER_HOUR);
            row.onDemandHours = round2(row.onDemandSeconds / SECONDS_PER_HOUR);
            const total = row.spotSeconds + row.onDemandSeconds;
            row.spotShare = total > 0 ? Math.round((row.spotSeconds / total) * 10000) / 10000 : 0;
            spotSeconds += row.spotSeconds;
            onDemandSeconds += row.onDemandSeconds;
            interruptions += row.interruptions;
            inFlightSessions += row.inFlightSessions;
        }
        const grandTotal = spotSeconds + onDemandSeconds;

        return {
            from: range.from.toISOString(),
            to: range.to.toISOString(),
            rows: [...byService.values()],
            totals: {
                spotHours: round2(spotSeconds / SECONDS_PER_HOUR),
                onDemandHours: round2(onDemandSeconds / SECONDS_PER_HOUR),
                spotShare: grandTotal > 0 ? Math.round((spotSeconds / grandTotal) * 10000) / 10000 : 0,
                interruptions,
                inFlightSessions,
            },
            dataQuality: {
                orphaned: Number(quality[0]?.orphaned ?? 0),
                staleOpen: Number(quality[0]?.staleOpen ?? 0),
            },
        };
    }

    async listEligibleServices(filters: EligibleFilters): Promise<{ services: EligibleService[]; total: number }> {
        const db = getTenantClient(filters.tenantId);
        const page = Math.max(1, filters.page ?? 1);
        const limit = Math.min(200, Math.max(1, filters.limit ?? 25));

        /**
         * Optional predicates, bound as parameters and paired with an `IS NULL` escape hatch so
         * one statement serves the filtered and unfiltered cases. Interpolating them into the SQL
         * string instead would be an injection hole in a raw query.
         */
        const account = filters.accountId ?? null;
        const region = filters.region ?? null;
        const term = filters.searchTerm?.trim() ? `%${filters.searchTerm.trim()}%` : null;

        // RAW SQL — NOT intercepted by the tenant extension, so tenantId is bound as $1.
        // Raw because the predicates read JSONB metadata that discovery writes, which the
        // Prisma query API cannot express.
        const rows = await db.$queryRaw<
            Array<{
                accountId: string;
                region: string;
                name: string;
                resourceId: string;
                metadata: Record<string, unknown>;
                clusterProviders: unknown;
                spotServiceId: string | null;
                managementState: string | null;
                registryStrategy: unknown;
            }>
        >`
            SELECT i."accountId",
                   i.region,
                   i.name,
                   i."resourceId",
                   i.metadata,
                   c.metadata -> 'capacityProviders' AS "clusterProviders",
                   sg.id                             AS "spotServiceId",
                   sg."managementState"              AS "managementState",
                   sg."observedStrategy"             AS "registryStrategy"
              FROM inventory_resources i
              LEFT JOIN spot_guard_services sg
                     ON sg."tenantId" = i."tenantId"
                    AND sg."accountId" = i."accountId"
                    AND sg.region = i.region
                    AND sg."serviceName" = i.name
              LEFT JOIN inventory_resources c
                     ON c."tenantId" = i."tenantId"
                    AND c."resourceType" = 'ecs_clusters'
                    AND c."isCurrent" = true
                    AND c."resourceId" = i.metadata ->> 'ecsClusterArn'
             WHERE i."tenantId" = ${filters.tenantId}
               AND i."resourceType" = 'ecs_services'
               AND i."isCurrent" = true
               -- "Eligible" means NOT currently managed, which is the exact complement of the
               -- Managed tab. Anything else double-lists a service the user has already opted in.
               -- Deliberately <> 'managed' rather than = 'unmanaged': a service with no registry
               -- row at all (managementState IS NULL) is the commonest candidate, and an
               -- 'opted_out' one is still a service you can choose to re-enable. Both must stay
               -- here, or they are reachable from neither tab.
               AND (sg."managementState" IS NULL OR sg."managementState" <> 'managed')
               AND (${account}::text IS NULL OR i."accountId" = ${account})
               AND (${region}::text IS NULL OR i.region = ${region})
               AND (
                     ${term}::text IS NULL
                     OR i.name ILIKE ${term}
                     OR split_part(i.metadata ->> 'ecsClusterArn', '/', 2) ILIKE ${term}
                   )
             ORDER BY i."accountId", i.region, i.name
             LIMIT ${limit} OFFSET ${(page - 1) * limit}
        `;

        const services: EligibleService[] = rows.map((r) => {
            const strategy = asStrategy(r.metadata?.capacityProviderStrategy);
            const clusterProviders = Array.isArray(r.clusterProviders) ? (r.clusterProviders as string[]) : [];
            const clusterArn = (r.metadata?.ecsClusterArn as string | undefined) ?? null;
            return {
                accountId: r.accountId,
                region: r.region,
                clusterArn,
                clusterName: clusterArn ? (clusterArn.split('/').pop() ?? null) : null,
                serviceName: r.name,
                serviceArn: (r.metadata?.serviceArn as string | undefined) ?? r.resourceId,
                launchType: (r.metadata?.launchType as string | undefined) ?? null,
                desiredCount:
                    r.metadata?.desiredCount !== undefined ? Number(r.metadata.desiredCount) : null,
                capacityProviderStrategy: strategy,
                clusterCapacityProviders: clusterProviders,
                eligibility: classifyEligibility(strategy, clusterProviders),
                spotServiceId: r.spotServiceId,
                managementState: (r.managementState as ManagementState | null) ?? null,
                // Live registry value, so callers needing the CURRENT split do not read stale
                // inventory. Null for a service Nucleus does not manage.
                registryStrategy: r.spotServiceId ? asStrategy(r.registryStrategy) : null,
            };
        });

        // Counted over the same predicates, WITHOUT the LIMIT. The previous `filtered.length`
        // measured the current page, so the pagination bar always claimed the visible rows were
        // the whole set and page 2 was unreachable.
        const [{ total }] = await db.$queryRaw<[{ total: bigint }]>`
            SELECT COUNT(*)::bigint AS total
              FROM inventory_resources i
              LEFT JOIN spot_guard_services sg
                     ON sg."tenantId" = i."tenantId"
                    AND sg."accountId" = i."accountId"
                    AND sg.region = i.region
                    AND sg."serviceName" = i.name
             WHERE i."tenantId" = ${filters.tenantId}
               AND i."resourceType" = 'ecs_services'
               AND i."isCurrent" = true
               AND (sg."managementState" IS NULL OR sg."managementState" <> 'managed')
               AND (${account}::text IS NULL OR i."accountId" = ${account})
               AND (${region}::text IS NULL OR i.region = ${region})
               AND (
                     ${term}::text IS NULL
                     OR i.name ILIKE ${term}
                     OR split_part(i.metadata ->> 'ecsClusterArn', '/', 2) ILIKE ${term}
                   )
        `;

        // `eligibility` is classified in TypeScript from JSONB the count cannot cheaply
        // reproduce, so it narrows the page but not the total. No caller sets it — the UI
        // exposes no such control — and the alternative is duplicating classifyEligibility in SQL.
        const filtered = filters.eligibility
            ? services.filter((s) => s.eligibility === filters.eligibility)
            : services;

        return { services: filtered, total: Number(total) };
    }
}
