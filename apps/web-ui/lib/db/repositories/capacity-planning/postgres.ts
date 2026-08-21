/**
 * CapacityPlanningPostgresRepository
 *
 * PostgreSQL implementation of ICapacityPlanningRepository using Prisma ORM.
 * Reads `capacity_utilization_samples`, `capacity_planning_runs`.
 *
 * Multi-tenant safety: every query goes through getTenantClient(tenantId).
 */
import { Prisma } from '@prisma/client';
import { getTenantClient } from '@/lib/db/pg-config';
import type {
    ICapacityPlanningRepository,
    CapacityPlanningFilters,
    CapacityUtilizationSummaryPage,
    CapacityUtilizationSummaryRow,
    CapacityBreachPage,
    CapacityBreachInstance,
    CapacityPlanningRun,
    CapacityResourceDetail,
    CapacityResourceType,
} from './interface';
import type { SignalSummary } from '@/lib/right-sizing/types';

function buildWhere(filters: Omit<CapacityPlanningFilters, 'page' | 'limit'>): Record<string, unknown> {
    const { tenantId, accountId, region, resourceType, searchTerm, dateFrom, dateTo } = filters;
    const where: Record<string, unknown> = { tenantId };
    if (accountId) where.accountId = accountId;
    if (region) where.region = region;
    if (resourceType) where.resourceType = Array.isArray(resourceType) ? { in: resourceType } : resourceType;
    if (dateFrom || dateTo) {
        where.bucketStartUtc = {
            ...(dateFrom ? { gte: new Date(dateFrom) } : {}),
            ...(dateTo ? { lte: new Date(dateTo) } : {}),
        };
    }
    if (searchTerm?.trim()) {
        const term = searchTerm.trim();
        where.OR = [
            { resourceId: { contains: term, mode: 'insensitive' } },
            { asgName: { contains: term, mode: 'insensitive' } },
            { serviceName: { contains: term, mode: 'insensitive' } },
            { clusterName: { contains: term, mode: 'insensitive' } },
        ];
    }
    return where;
}

function displayName(scope: CapacityResourceType, asgName: string | null, serviceName: string | null, resourceId: string): string {
    return (scope === 'asg' ? asgName : serviceName) ?? resourceId;
}

const GROUP_KEYS = ['resourceType', 'resourceId', 'accountId', 'region', 'asgName', 'clusterName', 'serviceName'] as const;

interface GroupResult {
    resourceType: string;
    resourceId: string;
    accountId: string;
    region: string;
    asgName: string | null;
    clusterName: string | null;
    serviceName: string | null;
    _avg: { cpuAvg: number | null; memAvg: number | null };
    _max: {
        cpuMax: number | null; memMax: number | null; installedVcpu: number | null; installedMemGiB: number | null; bucketStartUtc: Date;
    };
    _min: { bucketStartUtc: Date };
    _count: { _all: number };
}

export class CapacityPlanningPostgresRepository implements ICapacityPlanningRepository {
    /**
     * Resource-centric roll-up, mirroring scaling-audit's listResources: grouped
     * in SQL (via Prisma groupBy) rather than loaded and reduced in JS, since a
     * single resource can carry hundreds of hourly buckets.
     *
     * Two groupBy calls, not one: Prisma has no filtered-aggregate (a "COUNT
     * WHERE" alongside a plain AVG/MAX in the same groupBy), so breachCount
     * comes from a second groupBy with the threshold predicate in `where` and
     * its own _count._all — cheaper than loading raw rows to count in JS.
     */
    async getUtilizationSummary(filters: CapacityPlanningFilters, thresholdPercent = 70): Promise<CapacityUtilizationSummaryPage> {
        const { tenantId, page = 1, limit = 25 } = filters;
        const where = buildWhere(filters);
        const client = getTenantClient(tenantId);

        const [groups, breachGroups] = await Promise.all([
            client.capacityUtilizationSample.groupBy({
                by: [...GROUP_KEYS],
                where,
                _avg: { cpuAvg: true, memAvg: true },
                // ponytail: "installed capacity" uses MAX(installedVcpu/MemGiB)
                // rather than the most-recently-sampled row's value — correct
                // unless a resource is downsized mid-window, in which case
                // this over-reports. Upgrade path: a window function or a
                // second per-resource query for the row at MAX(bucketStartUtc)
                // if that ever matters more than the extra query cost.
                _max: { cpuMax: true, memMax: true, installedVcpu: true, installedMemGiB: true, bucketStartUtc: true },
                _min: { bucketStartUtc: true },
                _count: { _all: true },
            }) as unknown as Promise<GroupResult[]>,
            client.capacityUtilizationSample.groupBy({
                by: [...GROUP_KEYS],
                where: { ...where, OR: [{ cpuMax: { gt: thresholdPercent } }, { memMax: { gt: thresholdPercent } }] },
                _count: { _all: true },
            }) as unknown as Promise<Array<Pick<GroupResult, (typeof GROUP_KEYS)[number]> & { _count: { _all: number } }>>,
        ]);

        const breachByKey = new Map(breachGroups.map((g) => [`${g.resourceType}|${g.resourceId}`, g._count._all]));

        const sorted = groups.sort((a, b) => b._max.bucketStartUtc.getTime() - a._max.bucketStartUtc.getTime());
        const skip = (page - 1) * limit;
        const resources: CapacityUtilizationSummaryRow[] = sorted.slice(skip, skip + limit).map((g) => {
            const scope = g.resourceType as CapacityResourceType;
            return {
                resourceType: scope,
                resourceId: g.resourceId,
                accountId: g.accountId,
                region: g.region,
                clusterName: g.clusterName,
                serviceName: g.serviceName,
                asgName: g.asgName,
                displayName: displayName(scope, g.asgName, g.serviceName, g.resourceId),
                installedVcpu: g._max.installedVcpu,
                installedMemGiB: g._max.installedMemGiB,
                cpuAvg: g._avg.cpuAvg,
                cpuMax: g._max.cpuMax,
                memAvg: g._avg.memAvg,
                memMax: g._max.memMax,
                breachCount: breachByKey.get(`${g.resourceType}|${g.resourceId}`) ?? 0,
                firstSampleAt: g._min.bucketStartUtc.toISOString(),
                lastSampleAt: g._max.bucketStartUtc.toISOString(),
            };
        });

        return { resources, total: sorted.length };
    }

    /** Flat rows, one per (resource, metric, hour) that crossed the threshold —
     *  the exact shape of the reference workbook's Breach Instances sheet. */
    async listBreachInstances(filters: CapacityPlanningFilters, thresholdPercent = 70): Promise<CapacityBreachPage> {
        const { tenantId, page = 1, limit = 100 } = filters;
        const where = {
            ...buildWhere(filters),
            OR: [{ cpuMax: { gt: thresholdPercent } }, { memMax: { gt: thresholdPercent } }],
        };
        const client = getTenantClient(tenantId);

        const rows = await client.capacityUtilizationSample.findMany({
            where,
            orderBy: { bucketStartUtc: 'desc' },
            select: {
                resourceType: true, resourceId: true, accountId: true, region: true,
                asgName: true, serviceName: true, cpuMax: true, memMax: true, bucketStartUtc: true,
            },
        });

        const breaches: CapacityBreachInstance[] = [];
        for (const r of rows) {
            const scope = r.resourceType as CapacityResourceType;
            const name = displayName(scope, r.asgName, r.serviceName, r.resourceId);
            if (r.cpuMax != null && r.cpuMax > thresholdPercent) {
                breaches.push({ resourceType: scope, resourceId: r.resourceId, accountId: r.accountId, region: r.region, displayName: name, metric: 'cpu', utilizationPercent: r.cpuMax, bucketStartUtc: r.bucketStartUtc.toISOString() });
            }
            if (r.memMax != null && r.memMax > thresholdPercent) {
                breaches.push({ resourceType: scope, resourceId: r.resourceId, accountId: r.accountId, region: r.region, displayName: name, metric: 'mem', utilizationPercent: r.memMax, bucketStartUtc: r.bucketStartUtc.toISOString() });
            }
        }
        breaches.sort((a, b) => b.bucketStartUtc.localeCompare(a.bucketStartUtc));

        const skip = (page - 1) * limit;
        return { breaches: breaches.slice(skip, skip + limit), total: breaches.length };
    }

    /**
     * One resource's full detail. RAW SQL — NOT intercepted by the tenant
     * extension, so tenantId is bound explicitly (same as spot-guard's own
     * $queryRaw methods). Percentiles via Postgres PERCENTILE_CONT rather
     * than a persisted summary — see the interface doc comment for why this
     * module (unlike Right Sizing) computes them at read time.
     *
     * "Latest" values (clusterName/serviceName/asgName) use
     * `(ARRAY_AGG(x ORDER BY "bucketStartUtc" DESC))[1]` — the plain-aggregate
     * way to get "the value from the most recent row" in one query, no
     * window function or second round trip needed.
     */
    async getResourceDetail(filters: CapacityPlanningFilters, resourceId: string): Promise<CapacityResourceDetail | null> {
        const { tenantId, accountId, region, dateFrom, dateTo } = filters;
        const threshold = 70;

        const conditions = [Prisma.sql`"tenantId" = ${tenantId}`, Prisma.sql`"resourceId" = ${resourceId}`];
        if (filters.resourceType) {
            const types = Array.isArray(filters.resourceType) ? filters.resourceType : [filters.resourceType];
            conditions.push(Prisma.sql`"resourceType" IN (${Prisma.join(types)})`);
        }
        if (accountId) conditions.push(Prisma.sql`"accountId" = ${accountId}`);
        if (region) conditions.push(Prisma.sql`"region" = ${region}`);
        if (dateFrom) conditions.push(Prisma.sql`"bucketStartUtc" >= ${new Date(dateFrom)}`);
        if (dateTo) conditions.push(Prisma.sql`"bucketStartUtc" <= ${new Date(dateTo)}`);

        const client = getTenantClient(tenantId);
        const rows = await client.$queryRaw<
            Array<{
                resourceType: string; resourceId: string; accountId: string; region: string;
                clusterName: string | null; serviceName: string | null; asgName: string | null;
                installedVcpu: number | null; installedMemGiB: number | null;
                firstSampleAt: Date; lastSampleAt: Date; sampleCount: bigint; breachCount: bigint;
                cpuAvg: number | null; cpuP95: number | null; cpuP99: number | null; cpuMax: number | null; cpuCount: bigint;
                memAvg: number | null; memP95: number | null; memP99: number | null; memMax: number | null; memCount: bigint;
            }>
        >`
            SELECT
                "resourceType", "resourceId", "accountId", "region",
                (ARRAY_AGG("clusterName" ORDER BY "bucketStartUtc" DESC))[1] AS "clusterName",
                (ARRAY_AGG("serviceName" ORDER BY "bucketStartUtc" DESC))[1] AS "serviceName",
                (ARRAY_AGG("asgName" ORDER BY "bucketStartUtc" DESC))[1] AS "asgName",
                MAX("installedVcpu") AS "installedVcpu",
                MAX("installedMemGiB") AS "installedMemGiB",
                MIN("bucketStartUtc") AS "firstSampleAt",
                MAX("bucketStartUtc") AS "lastSampleAt",
                COUNT(*) AS "sampleCount",
                COUNT(*) FILTER (WHERE "cpuMax" > ${threshold} OR "memMax" > ${threshold}) AS "breachCount",
                AVG("cpuAvg") AS "cpuAvg", PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY "cpuAvg") AS "cpuP95",
                PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY "cpuAvg") AS "cpuP99", MAX("cpuAvg") AS "cpuMax", COUNT("cpuAvg") AS "cpuCount",
                AVG("memAvg") AS "memAvg", PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY "memAvg") AS "memP95",
                PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY "memAvg") AS "memP99", MAX("memAvg") AS "memMax", COUNT("memAvg") AS "memCount"
            FROM capacity_utilization_samples
            WHERE ${Prisma.join(conditions, ' AND ')}
            GROUP BY "resourceType", "resourceId", "accountId", "region"
        `;

        const r = rows[0];
        if (!r) return null;

        const signal = (avg: number | null, p95: number | null, p99: number | null, max: number | null, count: bigint): SignalSummary | null =>
            Number(count) === 0 ? null : { avg: avg ?? 0, p95: p95 ?? 0, p99: p99 ?? 0, max: max ?? 0, count: Number(count) };

        const scope = r.resourceType as CapacityResourceType;
        return {
            resourceType: scope,
            resourceId: r.resourceId,
            accountId: r.accountId,
            region: r.region,
            displayName: displayName(scope, r.asgName, r.serviceName, r.resourceId),
            clusterName: r.clusterName,
            serviceName: r.serviceName,
            asgName: r.asgName,
            installedVcpu: r.installedVcpu,
            installedMemGiB: r.installedMemGiB,
            firstSampleAt: r.firstSampleAt.toISOString(),
            lastSampleAt: r.lastSampleAt.toISOString(),
            sampleCount: Number(r.sampleCount),
            breachCount: Number(r.breachCount),
            metrics: {
                cpu: signal(r.cpuAvg, r.cpuP95, r.cpuP99, r.cpuMax, r.cpuCount),
                memory: signal(r.memAvg, r.memP95, r.memP99, r.memMax, r.memCount),
            },
        };
    }

    async listRuns(tenantId: string, page = 1, limit = 20): Promise<{ runs: CapacityPlanningRun[]; total: number }> {
        const client = getTenantClient(tenantId);
        const skip = (page - 1) * limit;
        const [total, rows] = await Promise.all([
            client.capacityPlanningRun.count({ where: { tenantId } }),
            client.capacityPlanningRun.findMany({ where: { tenantId }, orderBy: { startedAt: 'desc' }, skip, take: limit }),
        ]);
        return { runs: rows.map(transformRun), total };
    }

    async getActiveRun(tenantId: string): Promise<CapacityPlanningRun | null> {
        const client = getTenantClient(tenantId);
        const row = await client.capacityPlanningRun.findFirst({
            where: { tenantId, status: { in: ['queued', 'running'] } },
            orderBy: { startedAt: 'desc' },
        });
        return row ? transformRun(row) : null;
    }
}

interface RunRow {
    id: string;
    tenantId: string;
    status: string;
    trigger: string;
    accountsScanned: number;
    resourcesScanned: number;
    samplesWritten: number;
    errors: unknown;
    startedAt: Date;
    finishedAt: Date | null;
}

function transformRun(row: RunRow): CapacityPlanningRun {
    return {
        id: row.id,
        tenantId: row.tenantId,
        status: row.status as CapacityPlanningRun['status'],
        trigger: row.trigger as CapacityPlanningRun['trigger'],
        accountsScanned: row.accountsScanned,
        resourcesScanned: row.resourcesScanned,
        samplesWritten: row.samplesWritten,
        errors: Array.isArray(row.errors) ? row.errors : [],
        startedAt: row.startedAt.toISOString(),
        finishedAt: row.finishedAt?.toISOString() ?? null,
    };
}
