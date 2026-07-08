/**
 * RightSizingPostgresRepository
 *
 * PostgreSQL implementation of IRightSizingRepository using Prisma ORM.
 * Reads/writes `right_sizing_recommendations` and `right_sizing_runs`.
 *
 * Multi-tenant safety: every query goes through getTenantClient(tenantId), which
 * injects tenantId into reads/writes. Aggregations use groupBy scoped by tenantId.
 */
import { getTenantClient } from '@/lib/db/pg-config';
import type {
    IRightSizingRepository,
    RightSizingRecommendation,
    RecommendationUpsert,
    RecommendationFilters,
    RecommendationPage,
    RightSizingSummary,
    RightSizingRun,
    RunUpdate,
    RunTrigger,
    RecommendationStatus,
    Finding,
    RiskLevel,
} from './interface';

interface RecRow {
    id: string;
    tenantId: string;
    accountId: string;
    region: string;
    resourceType: string;
    resourceId: string;
    name: string | null;
    finding: string;
    currentConfig: unknown;
    recommendedConfig: unknown;
    metricsSummary: unknown;
    lookbackDays: number;
    currency: string;
    currentMonthlyCost: number | null;
    recommendedMonthlyCost: number | null;
    estimatedMonthlySavings: number;
    confidence: number;
    riskLevel: string;
    rationale: string;
    source: string;
    status: string;
    snoozeUntil: Date | null;
    reviewedBy: string | null;
    reviewedAt: Date | null;
    generatedByRunId: string | null;
    generatedAt: Date;
    updatedAt: Date;
}

function transformRec(row: RecRow): RightSizingRecommendation {
    return {
        id: row.id,
        tenantId: row.tenantId,
        accountId: row.accountId,
        region: row.region,
        resourceType: row.resourceType,
        resourceId: row.resourceId,
        name: row.name ?? undefined,
        finding: row.finding as Finding,
        currentConfig: (row.currentConfig as Record<string, unknown>) || {},
        recommendedConfig: (row.recommendedConfig as Record<string, unknown> | null) ?? null,
        metricsSummary: (row.metricsSummary as Record<string, unknown>) || {},
        lookbackDays: row.lookbackDays,
        currency: row.currency,
        currentMonthlyCost: row.currentMonthlyCost,
        recommendedMonthlyCost: row.recommendedMonthlyCost,
        estimatedMonthlySavings: row.estimatedMonthlySavings,
        confidence: row.confidence,
        riskLevel: row.riskLevel as RiskLevel,
        rationale: row.rationale,
        source: row.source,
        status: row.status as RecommendationStatus,
        snoozeUntil: row.snoozeUntil ? row.snoozeUntil.toISOString() : null,
        reviewedBy: row.reviewedBy,
        reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
        generatedByRunId: row.generatedByRunId,
        generatedAt: row.generatedAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    };
}

interface RunRow {
    id: string;
    tenantId: string;
    status: string;
    trigger: string;
    lookbackDays: number;
    accountsScanned: number;
    resourcesAnalyzed: number;
    recommendationsGenerated: number;
    totalEstimatedSavings: number;
    errors: unknown;
    startedAt: Date;
    finishedAt: Date | null;
    expiresAt: Date | null;
}

function transformRun(row: RunRow): RightSizingRun {
    return {
        id: row.id,
        tenantId: row.tenantId,
        status: row.status as RightSizingRun['status'],
        trigger: row.trigger as RunTrigger,
        lookbackDays: row.lookbackDays,
        accountsScanned: row.accountsScanned,
        resourcesAnalyzed: row.resourcesAnalyzed,
        recommendationsGenerated: row.recommendationsGenerated,
        totalEstimatedSavings: row.totalEstimatedSavings,
        errors: Array.isArray(row.errors) ? (row.errors as unknown[]) : [],
        startedAt: row.startedAt.toISOString(),
        finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
        expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    };
}

export class RightSizingPostgresRepository implements IRightSizingRepository {
    async listRecommendations(filters: RecommendationFilters): Promise<RecommendationPage> {
        const {
            tenantId,
            accountId,
            accountIds,
            region,
            resourceType,
            finding,
            status,
            searchTerm,
            page = 1,
            limit = 50,
            sort = 'savings',
        } = filters;

        const skip = (page - 1) * limit;
        const where: Record<string, unknown> = { tenantId };
        if (accountId) where.accountId = accountId;
        else if (accountIds?.length) where.accountId = { in: accountIds };
        if (region) where.region = region;
        if (resourceType) where.resourceType = resourceType;
        if (finding) where.finding = finding;
        if (status) where.status = status;
        if (searchTerm?.trim()) {
            const term = searchTerm.trim();
            where.OR = [
                { resourceId: { contains: term, mode: 'insensitive' } },
                { name: { contains: term, mode: 'insensitive' } },
            ];
        }

        const orderBy =
            sort === 'confidence'
                ? { confidence: 'desc' as const }
                : sort === 'resource'
                  ? { resourceId: 'asc' as const }
                  : { estimatedMonthlySavings: 'desc' as const };

        const client = getTenantClient(tenantId);
        const [total, rows] = await Promise.all([
            client.rightSizingRecommendation.count({ where }),
            client.rightSizingRecommendation.findMany({ where, skip, take: limit, orderBy }),
        ]);
        return { recommendations: (rows as RecRow[]).map(transformRec), total };
    }

    async getRecommendation(id: string, tenantId: string): Promise<RightSizingRecommendation | null> {
        const client = getTenantClient(tenantId);
        const row = await client.rightSizingRecommendation.findFirst({ where: { id, tenantId } });
        return row ? transformRec(row as RecRow) : null;
    }

    async upsertRecommendations(items: RecommendationUpsert[], tenantId: string): Promise<number> {
        if (!items.length) return 0;
        const client = getTenantClient(tenantId);
        await client.$transaction(
            items.map((rec) =>
                client.rightSizingRecommendation.upsert({
                    where: {
                        tenantId_accountId_resourceType_resourceId: {
                            tenantId,
                            accountId: rec.accountId,
                            resourceType: rec.resourceType,
                            resourceId: rec.resourceId,
                        },
                    },
                    create: {
                        tenantId,
                        accountId: rec.accountId,
                        region: rec.region,
                        resourceType: rec.resourceType,
                        resourceId: rec.resourceId,
                        name: rec.name ?? null,
                        finding: rec.finding,
                        currentConfig: (rec.currentConfig ?? {}) as object,
                        recommendedConfig: (rec.recommendedConfig ?? undefined) as object | undefined,
                        metricsSummary: (rec.metricsSummary ?? {}) as object,
                        lookbackDays: rec.lookbackDays,
                        currency: rec.currency,
                        currentMonthlyCost: rec.currentMonthlyCost ?? null,
                        recommendedMonthlyCost: rec.recommendedMonthlyCost ?? null,
                        estimatedMonthlySavings: rec.estimatedMonthlySavings,
                        confidence: rec.confidence,
                        riskLevel: rec.riskLevel,
                        rationale: rec.rationale,
                        source: rec.source,
                        status: rec.status ?? 'open',
                        generatedByRunId: rec.generatedByRunId ?? null,
                    },
                    // On re-scan, refresh the computed fields but DO NOT clobber a
                    // reviewer's status decision (open stays the only auto-managed state
                    // by leaving status untouched here).
                    update: {
                        region: rec.region,
                        name: rec.name ?? null,
                        finding: rec.finding,
                        currentConfig: (rec.currentConfig ?? {}) as object,
                        recommendedConfig: (rec.recommendedConfig ?? undefined) as object | undefined,
                        metricsSummary: (rec.metricsSummary ?? {}) as object,
                        lookbackDays: rec.lookbackDays,
                        currency: rec.currency,
                        currentMonthlyCost: rec.currentMonthlyCost ?? null,
                        recommendedMonthlyCost: rec.recommendedMonthlyCost ?? null,
                        estimatedMonthlySavings: rec.estimatedMonthlySavings,
                        confidence: rec.confidence,
                        riskLevel: rec.riskLevel,
                        rationale: rec.rationale,
                        generatedByRunId: rec.generatedByRunId ?? null,
                    },
                })
            )
        );
        return items.length;
    }

    async updateStatus(
        id: string,
        tenantId: string,
        status: RecommendationStatus,
        reviewedBy: string,
        snoozeUntil?: Date | null
    ): Promise<RightSizingRecommendation> {
        const client = getTenantClient(tenantId);
        const row = await client.rightSizingRecommendation.update({
            where: { id },
            data: {
                status,
                reviewedBy,
                reviewedAt: new Date(),
                snoozeUntil: status === 'snoozed' ? (snoozeUntil ?? null) : null,
            },
        });
        return transformRec(row as RecRow);
    }

    async getSummary(tenantId: string): Promise<RightSizingSummary> {
        const client = getTenantClient(tenantId);
        const [byFinding, byStatus, byType, byAccount, distinctAccounts, lastRun, savingsAgg] = await Promise.all([
            client.rightSizingRecommendation.groupBy({ by: ['finding'], where: { tenantId }, _count: { _all: true } }),
            client.rightSizingRecommendation.groupBy({ by: ['status'], where: { tenantId }, _count: { _all: true } }),
            client.rightSizingRecommendation.groupBy({
                by: ['resourceType'],
                where: { tenantId, status: { in: ['open', 'approved'] } },
                _sum: { estimatedMonthlySavings: true },
            }),
            client.rightSizingRecommendation.groupBy({
                by: ['accountId'],
                where: { tenantId, status: { in: ['open', 'approved'] } },
                _sum: { estimatedMonthlySavings: true },
            }),
            client.rightSizingRecommendation.groupBy({
                by: ['accountId'],
                where: { tenantId },
                orderBy: { accountId: 'asc' },
            }),
            client.rightSizingRun.findFirst({
                where: { tenantId, status: 'completed' },
                orderBy: { startedAt: 'desc' },
            }),
            client.rightSizingRecommendation.aggregate({
                where: { tenantId, status: { in: ['open', 'approved'] } },
                _sum: { estimatedMonthlySavings: true },
            }),
        ]);

        const toCountMap = (g: Array<{ _count: { _all: number } }>, key: string) =>
            g.reduce((acc: Record<string, number>, r: Record<string, unknown>) => {
                acc[String(r[key])] = (r._count as { _all: number })._all;
                return acc;
            }, {});
        const toSumMap = (g: Array<Record<string, unknown>>, key: string) =>
            g.reduce((acc: Record<string, number>, r: Record<string, unknown>) => {
                acc[String(r[key])] = (r._sum as { estimatedMonthlySavings: number | null }).estimatedMonthlySavings ?? 0;
                return acc;
            }, {});

        return {
            totalPotentialMonthlySavings: savingsAgg._sum.estimatedMonthlySavings ?? 0,
            byFinding: toCountMap(byFinding as never, 'finding'),
            byStatus: toCountMap(byStatus as never, 'status'),
            savingsByResourceType: toSumMap(byType as never, 'resourceType'),
            savingsByAccount: toSumMap(byAccount as never, 'accountId'),
            accountIds: (distinctAccounts as Array<{ accountId: string }>).map((r) => r.accountId),
            lastRunAt: lastRun ? (lastRun as RunRow).startedAt.toISOString() : null,
        };
    }

    async createRun(tenantId: string, trigger: RunTrigger, lookbackDays: number): Promise<RightSizingRun> {
        const client = getTenantClient(tenantId);
        const row = await client.rightSizingRun.create({
            data: { tenantId, status: 'running', trigger, lookbackDays },
        });
        return transformRun(row as RunRow);
    }

    async updateRun(id: string, tenantId: string, updates: RunUpdate): Promise<RightSizingRun> {
        const client = getTenantClient(tenantId);
        const row = await client.rightSizingRun.update({
            where: { id },
            data: {
                ...(updates.status !== undefined ? { status: updates.status } : {}),
                ...(updates.accountsScanned !== undefined ? { accountsScanned: updates.accountsScanned } : {}),
                ...(updates.resourcesAnalyzed !== undefined ? { resourcesAnalyzed: updates.resourcesAnalyzed } : {}),
                ...(updates.recommendationsGenerated !== undefined
                    ? { recommendationsGenerated: updates.recommendationsGenerated }
                    : {}),
                ...(updates.totalEstimatedSavings !== undefined
                    ? { totalEstimatedSavings: updates.totalEstimatedSavings }
                    : {}),
                ...(updates.errors !== undefined ? { errors: updates.errors as object } : {}),
                ...(updates.finishedAt !== undefined ? { finishedAt: updates.finishedAt } : {}),
            },
        });
        return transformRun(row as RunRow);
    }

    async listRuns(
        tenantId: string,
        page = 1,
        limit = 20
    ): Promise<{ runs: RightSizingRun[]; total: number }> {
        const client = getTenantClient(tenantId);
        const skip = (page - 1) * limit;
        const [total, rows] = await Promise.all([
            client.rightSizingRun.count({ where: { tenantId } }),
            client.rightSizingRun.findMany({ where: { tenantId }, skip, take: limit, orderBy: { startedAt: 'desc' } }),
        ]);
        return { runs: (rows as RunRow[]).map(transformRun), total };
    }

    async getActiveRun(tenantId: string): Promise<RightSizingRun | null> {
        const client = getTenantClient(tenantId);
        // Ignore stale runs (> 2h): a crashed worker must not leave a `running` row that
        // permanently reports an active scan. pg-boss singletonKey is the real concurrency gate.
        const staleCutoff = new Date(Date.now() - 2 * 60 * 60 * 1000);
        const row = await client.rightSizingRun.findFirst({
            where: { tenantId, status: { in: ['queued', 'running'] }, startedAt: { gt: staleCutoff } },
            orderBy: { startedAt: 'desc' },
        });
        return row ? transformRun(row as RunRow) : null;
    }
}
