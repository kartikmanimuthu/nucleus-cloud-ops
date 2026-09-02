import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MockedFunction } from 'vitest';

// Partial mock: only the client factories are stubbed. andWhere() is the real
// implementation — it is pure, and a stub of it would hide the row-filter
// composition this repository depends on.
vi.mock('@/lib/db/pg-config', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/db/pg-config')>()),
    getTenantClient: vi.fn(),
}));

import { getTenantClient } from '@/lib/db/pg-config';
import { RightSizingPostgresRepository } from './postgres';

const makeRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'rec-1',
    tenantId: 'tenant-a',
    accountId: 'acc-1',
    region: 'us-east-1',
    resourceType: 'ec2_instances',
    resourceId: 'i-1',
    name: 'web',
    finding: 'over_provisioned',
    currentConfig: { instanceType: 'm5.2xlarge' },
    recommendedConfig: { instanceType: 'm5.large' },
    metricsSummary: {},
    lookbackDays: 14,
    currency: 'USD',
    currentMonthlyCost: 280,
    recommendedMonthlyCost: 70,
    estimatedMonthlySavings: 210,
    confidence: 0.9,
    riskLevel: 'medium',
    rationale: 'low cpu',
    source: 'cloudwatch',
    status: 'open',
    snoozeUntil: null,
    reviewedBy: null,
    reviewedAt: null,
    generatedByRunId: 'run-1',
    generatedAt: new Date('2026-06-23T00:00:00Z'),
    updatedAt: new Date('2026-06-23T00:00:00Z'),
    ...overrides,
});

const makeRunRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'run-1', tenantId: 'tenant-a', status: 'running', trigger: 'manual', lookbackDays: 14,
    accountsScanned: 0, resourcesAnalyzed: 0, recommendationsGenerated: 0, totalEstimatedSavings: 0,
    errors: [], startedAt: new Date('2026-06-23T00:00:00Z'), finishedAt: null, expiresAt: null,
    ...overrides,
});

describe('RightSizingPostgresRepository — tenant isolation', () => {
    let mockClient: {
        rightSizingRecommendation: {
            findMany: MockedFunction<any>;
            count: MockedFunction<any>;
            findFirst: MockedFunction<any>;
            update: MockedFunction<any>;
            upsert: MockedFunction<any>;
            groupBy: MockedFunction<any>;
            aggregate: MockedFunction<any>;
        };
        rightSizingRun: {
            findFirst: MockedFunction<any>;
            create: MockedFunction<any>;
            update: MockedFunction<any>;
            count: MockedFunction<any>;
            findMany: MockedFunction<any>;
        };
        $transaction: MockedFunction<any>;
    };
    const getTenantClientMock = getTenantClient as unknown as MockedFunction<any>;

    beforeEach(() => {
        mockClient = {
            rightSizingRecommendation: {
                findMany: vi.fn().mockResolvedValue([makeRow()]),
                count: vi.fn().mockResolvedValue(1),
                findFirst: vi.fn().mockResolvedValue(makeRow()),
                update: vi.fn().mockResolvedValue(makeRow({ status: 'approved' })),
                upsert: vi.fn().mockResolvedValue(makeRow()),
                groupBy: vi.fn().mockResolvedValue([]),
                aggregate: vi.fn().mockResolvedValue({ _sum: { estimatedMonthlySavings: null } }),
            },
            rightSizingRun: {
                findFirst: vi.fn().mockResolvedValue(null),
                create: vi.fn().mockResolvedValue(makeRunRow()),
                update: vi.fn().mockResolvedValue(makeRunRow()),
                count: vi.fn().mockResolvedValue(0),
                findMany: vi.fn().mockResolvedValue([]),
            },
            $transaction: vi.fn().mockResolvedValue([]),
        };
        getTenantClientMock.mockReturnValue(mockClient);
        getTenantClientMock.mockClear();
    });

    it('scopes listRecommendations to the caller tenant', async () => {
        const repo = new RightSizingPostgresRepository();
        await repo.listRecommendations({ tenantId: 'tenant-a', page: 1, limit: 10 });
        expect(getTenantClientMock).toHaveBeenCalledWith('tenant-a');
        const whereArg = mockClient.rightSizingRecommendation.findMany.mock.calls[0][0].where;
        expect(whereArg.tenantId).toBe('tenant-a');
    });

    it('uses a different scoped client per tenant (no cross-tenant bleed)', async () => {
        const repo = new RightSizingPostgresRepository();
        await repo.listRecommendations({ tenantId: 'tenant-a', page: 1, limit: 10 });
        await repo.listRecommendations({ tenantId: 'tenant-b', page: 1, limit: 10 });
        expect(getTenantClientMock).toHaveBeenNthCalledWith(1, 'tenant-a');
        expect(getTenantClientMock).toHaveBeenNthCalledWith(2, 'tenant-b');
    });

    it('getRecommendation filters by both id and tenantId', async () => {
        const repo = new RightSizingPostgresRepository();
        await repo.getRecommendation('rec-1', 'tenant-a');
        const whereArg = mockClient.rightSizingRecommendation.findFirst.mock.calls[0][0].where;
        expect(whereArg).toMatchObject({ id: 'rec-1', tenantId: 'tenant-a' });
    });

    it('updateStatus goes through the tenant-scoped client', async () => {
        const repo = new RightSizingPostgresRepository();
        await repo.updateStatus('rec-1', 'tenant-a', 'approved', 'user-1');
        expect(getTenantClientMock).toHaveBeenCalledWith('tenant-a');
        expect(mockClient.rightSizingRecommendation.update).toHaveBeenCalled();
    });

    describe('listRecommendations filters', () => {
        it('filters by a single accountId, ignoring accountIds when both are given', async () => {
            const repo = new RightSizingPostgresRepository();
            await repo.listRecommendations({ tenantId: 'tenant-a', accountId: 'acc-1', accountIds: ['acc-2'] });
            expect(mockClient.rightSizingRecommendation.findMany.mock.calls[0][0].where.accountId).toBe('acc-1');
        });

        it('filters by a set of accountIds when accountId is absent', async () => {
            const repo = new RightSizingPostgresRepository();
            await repo.listRecommendations({ tenantId: 'tenant-a', accountIds: ['acc-1', 'acc-2'] });
            expect(mockClient.rightSizingRecommendation.findMany.mock.calls[0][0].where.accountId).toEqual({ in: ['acc-1', 'acc-2'] });
        });

        it.each(['region', 'resourceType', 'finding', 'status'])('applies the %s filter', async (field) => {
            const repo = new RightSizingPostgresRepository();
            await repo.listRecommendations({ tenantId: 'tenant-a', [field]: 'x' } as any);
            expect(mockClient.rightSizingRecommendation.findMany.mock.calls[0][0].where[field]).toBe('x');
        });

        it('searches resourceId/name case-insensitively with a trimmed term', async () => {
            const repo = new RightSizingPostgresRepository();
            await repo.listRecommendations({ tenantId: 'tenant-a', searchTerm: '  i-1  ' });
            expect(mockClient.rightSizingRecommendation.findMany.mock.calls[0][0].where.OR).toEqual([
                { resourceId: { contains: 'i-1', mode: 'insensitive' } },
                { name: { contains: 'i-1', mode: 'insensitive' } },
            ]);
        });

        it('ignores a whitespace-only searchTerm', async () => {
            const repo = new RightSizingPostgresRepository();
            await repo.listRecommendations({ tenantId: 'tenant-a', searchTerm: '   ' });
            expect(mockClient.rightSizingRecommendation.findMany.mock.calls[0][0].where.OR).toBeUndefined();
        });

        it.each([
            ['confidence', { confidence: 'desc' }],
            ['resource', { resourceId: 'asc' }],
            ['savings', { estimatedMonthlySavings: 'desc' }],
            [undefined, { estimatedMonthlySavings: 'desc' }],
        ])('orders by %s', async (sort, expected) => {
            const repo = new RightSizingPostgresRepository();
            await repo.listRecommendations({ tenantId: 'tenant-a', sort: sort as any });
            expect(mockClient.rightSizingRecommendation.findMany.mock.calls[0][0].orderBy).toEqual(expected);
        });

        it('intersects a Gate-3 row filter under AND without discarding the search OR clause', async () => {
            const repo = new RightSizingPostgresRepository();
            await repo.listRecommendations({ tenantId: 'tenant-a', searchTerm: 'x', rowFilter: { accountId: { in: ['acc-1'] } } });
            const where = mockClient.rightSizingRecommendation.findMany.mock.calls[0][0].where;
            expect(where.OR).toBeDefined();
            expect(where.AND).toEqual([{ accountId: { in: ['acc-1'] } }]);
        });

        it('defaults page/limit to 1/50 and computes skip from page', async () => {
            const repo = new RightSizingPostgresRepository();
            await repo.listRecommendations({ tenantId: 'tenant-a', page: 3, limit: 10 });
            expect(mockClient.rightSizingRecommendation.findMany.mock.calls[0][0].skip).toBe(20);
            expect(mockClient.rightSizingRecommendation.findMany.mock.calls[0][0].take).toBe(10);
        });

        it('returns the transformed page and total', async () => {
            const repo = new RightSizingPostgresRepository();
            const result = await repo.listRecommendations({ tenantId: 'tenant-a' });
            expect(result).toEqual({ recommendations: [expect.objectContaining({ id: 'rec-1' })], total: 1 });
        });
    });

    describe('getRecommendation', () => {
        it('returns null when not found', async () => {
            mockClient.rightSizingRecommendation.findFirst.mockResolvedValue(null);
            const repo = new RightSizingPostgresRepository();
            expect(await repo.getRecommendation('rec-x', 'tenant-a')).toBeNull();
        });

        it('formats a null recommendedConfig, snoozeUntil, reviewedAt, and generatedByRunId', async () => {
            mockClient.rightSizingRecommendation.findFirst.mockResolvedValue(makeRow({
                recommendedConfig: null, snoozeUntil: null, reviewedAt: null, reviewedBy: null, generatedByRunId: null, name: null,
            }));
            const repo = new RightSizingPostgresRepository();
            const rec = await repo.getRecommendation('rec-1', 'tenant-a');
            expect(rec?.recommendedConfig).toBeNull();
            expect(rec?.snoozeUntil).toBeNull();
            expect(rec?.reviewedAt).toBeNull();
            expect(rec?.name).toBeUndefined();
        });

        it('defaults a null currentConfig/metricsSummary to {} rather than propagating null', async () => {
            mockClient.rightSizingRecommendation.findFirst.mockResolvedValue(makeRow({
                currentConfig: null, metricsSummary: null,
            }));
            const repo = new RightSizingPostgresRepository();
            const rec = await repo.getRecommendation('rec-1', 'tenant-a');
            expect(rec?.currentConfig).toEqual({});
            expect(rec?.metricsSummary).toEqual({});
        });

        it('converts a populated snoozeUntil/reviewedAt to ISO strings', async () => {
            mockClient.rightSizingRecommendation.findFirst.mockResolvedValue(makeRow({
                snoozeUntil: new Date('2026-07-01T00:00:00Z'), reviewedAt: new Date('2026-06-25T00:00:00Z'),
            }));
            const repo = new RightSizingPostgresRepository();
            const rec = await repo.getRecommendation('rec-1', 'tenant-a');
            expect(rec?.snoozeUntil).toBe('2026-07-01T00:00:00.000Z');
            expect(rec?.reviewedAt).toBe('2026-06-25T00:00:00.000Z');
        });
    });

    describe('upsertRecommendations', () => {
        const UPSERT_INPUT = {
            accountId: 'acc-1', region: 'us-east-1', resourceType: 'ec2_instances', resourceId: 'i-1',
            finding: 'over_provisioned', lookbackDays: 14, currency: 'USD', estimatedMonthlySavings: 210,
            confidence: 0.9, riskLevel: 'medium', rationale: 'low cpu', source: 'cloudwatch',
        };

        it('short-circuits on an empty list without opening a transaction', async () => {
            const repo = new RightSizingPostgresRepository();
            expect(await repo.upsertRecommendations([], 'tenant-a')).toBe(0);
            expect(mockClient.$transaction).not.toHaveBeenCalled();
        });

        it('upserts every item inside one transaction and returns the count', async () => {
            const repo = new RightSizingPostgresRepository();
            const count = await repo.upsertRecommendations([UPSERT_INPUT, { ...UPSERT_INPUT, resourceId: 'i-2' }] as any, 'tenant-a');
            expect(count).toBe(2);
            expect(mockClient.$transaction).toHaveBeenCalledOnce();
            expect(mockClient.rightSizingRecommendation.upsert).toHaveBeenCalledTimes(2);
        });

        it('keys the upsert on the tenant+account+type+resource composite', async () => {
            const repo = new RightSizingPostgresRepository();
            await repo.upsertRecommendations([UPSERT_INPUT] as any, 'tenant-a');
            const call = mockClient.rightSizingRecommendation.upsert.mock.calls[0][0];
            expect(call.where.tenantId_accountId_resourceType_resourceId).toEqual({
                tenantId: 'tenant-a', accountId: 'acc-1', resourceType: 'ec2_instances', resourceId: 'i-1',
            });
        });

        it('defaults status to "open" on create when not supplied', async () => {
            const repo = new RightSizingPostgresRepository();
            await repo.upsertRecommendations([UPSERT_INPUT] as any, 'tenant-a');
            expect(mockClient.rightSizingRecommendation.upsert.mock.calls[0][0].create.status).toBe('open');
        });

        it('does not touch status on update — a reviewer decision must survive a re-scan', async () => {
            const repo = new RightSizingPostgresRepository();
            await repo.upsertRecommendations([{ ...UPSERT_INPUT, status: 'approved' }] as any, 'tenant-a');
            expect(mockClient.rightSizingRecommendation.upsert.mock.calls[0][0].update).not.toHaveProperty('status');
        });

        it('defaults currentConfig/metricsSummary to {} and recommendedConfig to undefined when omitted', async () => {
            const repo = new RightSizingPostgresRepository();
            await repo.upsertRecommendations([UPSERT_INPUT] as any, 'tenant-a');
            const { create } = mockClient.rightSizingRecommendation.upsert.mock.calls[0][0];
            expect(create.currentConfig).toEqual({});
            expect(create.metricsSummary).toEqual({});
            expect(create.recommendedConfig).toBeUndefined();
        });
    });

    describe('updateStatus', () => {
        it('sets snoozeUntil when status is "snoozed"', async () => {
            const until = new Date('2026-07-01T00:00:00Z');
            const repo = new RightSizingPostgresRepository();
            await repo.updateStatus('rec-1', 'tenant-a', 'snoozed', 'user-1', until);
            expect(mockClient.rightSizingRecommendation.update.mock.calls[0][0].data.snoozeUntil).toBe(until);
        });

        it('nulls snoozeUntil when snoozed with no date given', async () => {
            const repo = new RightSizingPostgresRepository();
            await repo.updateStatus('rec-1', 'tenant-a', 'snoozed', 'user-1');
            expect(mockClient.rightSizingRecommendation.update.mock.calls[0][0].data.snoozeUntil).toBeNull();
        });

        it('nulls snoozeUntil for a non-snoozed status even if a date was passed', async () => {
            const repo = new RightSizingPostgresRepository();
            await repo.updateStatus('rec-1', 'tenant-a', 'approved', 'user-1', new Date());
            expect(mockClient.rightSizingRecommendation.update.mock.calls[0][0].data.snoozeUntil).toBeNull();
        });

        it('does not scope the update by id+tenantId in the where (relies on the tenant client)', async () => {
            const repo = new RightSizingPostgresRepository();
            await repo.updateStatus('rec-1', 'tenant-a', 'approved', 'user-1');
            expect(mockClient.rightSizingRecommendation.update.mock.calls[0][0].where).toEqual({ id: 'rec-1' });
        });
    });

    describe('getSummary', () => {
        it('aggregates counts, sums, distinct accounts, and the last completed run', async () => {
            mockClient.rightSizingRecommendation.groupBy
                .mockResolvedValueOnce([{ finding: 'over_provisioned', _count: { _all: 3 } }]) // byFinding
                .mockResolvedValueOnce([{ status: 'open', _count: { _all: 2 } }]) // byStatus
                .mockResolvedValueOnce([{ resourceType: 'ec2_instances', _sum: { estimatedMonthlySavings: 100 } }]) // byType
                .mockResolvedValueOnce([{ accountId: 'acc-1', _sum: { estimatedMonthlySavings: 100 } }]) // byAccount
                .mockResolvedValueOnce([{ accountId: 'acc-1' }, { accountId: 'acc-2' }]); // distinctAccounts
            mockClient.rightSizingRun.findFirst.mockResolvedValue(makeRunRow({ startedAt: new Date('2026-06-20T00:00:00Z') }));
            mockClient.rightSizingRecommendation.aggregate.mockResolvedValue({ _sum: { estimatedMonthlySavings: 350 } });

            const repo = new RightSizingPostgresRepository();
            const summary = await repo.getSummary('tenant-a');

            expect(summary.totalPotentialMonthlySavings).toBe(350);
            expect(summary.byFinding).toEqual({ over_provisioned: 3 });
            expect(summary.byStatus).toEqual({ open: 2 });
            expect(summary.savingsByResourceType).toEqual({ ec2_instances: 100 });
            expect(summary.savingsByAccount).toEqual({ 'acc-1': 100 });
            expect(summary.accountIds).toEqual(['acc-1', 'acc-2']);
            expect(summary.lastRunAt).toBe('2026-06-20T00:00:00.000Z');
        });

        it('defaults totalPotentialMonthlySavings to 0 and lastRunAt to null when there is no data yet', async () => {
            mockClient.rightSizingRun.findFirst.mockResolvedValue(null);
            mockClient.rightSizingRecommendation.aggregate.mockResolvedValue({ _sum: { estimatedMonthlySavings: null } });
            const repo = new RightSizingPostgresRepository();
            const summary = await repo.getSummary('tenant-a');
            expect(summary.totalPotentialMonthlySavings).toBe(0);
            expect(summary.lastRunAt).toBeNull();
        });

        it('defaults a null per-group sum to 0 rather than propagating null', async () => {
            mockClient.rightSizingRecommendation.groupBy
                .mockResolvedValueOnce([]) // byFinding
                .mockResolvedValueOnce([]) // byStatus
                .mockResolvedValueOnce([{ resourceType: 'rds_instances', _sum: { estimatedMonthlySavings: null } }]) // byType
                .mockResolvedValueOnce([]) // byAccount
                .mockResolvedValueOnce([]); // distinctAccounts
            const repo = new RightSizingPostgresRepository();
            const summary = await repo.getSummary('tenant-a');
            expect(summary.savingsByResourceType).toEqual({ rds_instances: 0 });
        });

        it('scopes every aggregate query to the caller tenant', async () => {
            const repo = new RightSizingPostgresRepository();
            await repo.getSummary('tenant-a');
            for (const call of mockClient.rightSizingRecommendation.groupBy.mock.calls) {
                expect(call[0].where.tenantId).toBe('tenant-a');
            }
            expect(mockClient.rightSizingRecommendation.aggregate.mock.calls[0][0].where.tenantId).toBe('tenant-a');
            expect(mockClient.rightSizingRun.findFirst.mock.calls[0][0].where.tenantId).toBe('tenant-a');
        });
    });

    describe('createRun', () => {
        it('creates a running run with the given trigger and lookback', async () => {
            const repo = new RightSizingPostgresRepository();
            await repo.createRun('tenant-a', 'manual', 30);
            expect(mockClient.rightSizingRun.create).toHaveBeenCalledWith({
                data: { tenantId: 'tenant-a', status: 'running', trigger: 'manual', lookbackDays: 30 },
            });
        });

        it('returns the transformed run, defaulting a non-array errors field to []', async () => {
            mockClient.rightSizingRun.create.mockResolvedValue(makeRunRow({ errors: null }));
            const repo = new RightSizingPostgresRepository();
            const run = await repo.createRun('tenant-a', 'scheduled', 14);
            expect(run.errors).toEqual([]);
        });

        it('converts a populated finishedAt/expiresAt to ISO strings', async () => {
            mockClient.rightSizingRun.create.mockResolvedValue(makeRunRow({
                finishedAt: new Date('2026-06-23T02:00:00Z'), expiresAt: new Date('2026-09-23T00:00:00Z'),
            }));
            const repo = new RightSizingPostgresRepository();
            const run = await repo.createRun('tenant-a', 'manual', 14);
            expect(run.finishedAt).toBe('2026-06-23T02:00:00.000Z');
            expect(run.expiresAt).toBe('2026-09-23T00:00:00.000Z');
        });
    });

    describe('updateRun', () => {
        it('applies only the fields explicitly present in the update', async () => {
            const repo = new RightSizingPostgresRepository();
            await repo.updateRun('run-1', 'tenant-a', { status: 'completed', accountsScanned: 5 });
            const data = mockClient.rightSizingRun.update.mock.calls[0][0].data;
            expect(data).toEqual({ status: 'completed', accountsScanned: 5 });
        });

        it('applies an empty update as a no-op data object', async () => {
            const repo = new RightSizingPostgresRepository();
            await repo.updateRun('run-1', 'tenant-a', {});
            expect(mockClient.rightSizingRun.update.mock.calls[0][0].data).toEqual({});
        });

        it('applies every optional field when all are present', async () => {
            const repo = new RightSizingPostgresRepository();
            const finishedAt = new Date('2026-06-23T01:00:00Z');
            await repo.updateRun('run-1', 'tenant-a', {
                status: 'completed', accountsScanned: 5, resourcesAnalyzed: 100, recommendationsGenerated: 10,
                totalEstimatedSavings: 500, errors: [{ msg: 'x' }], finishedAt,
            } as any);
            const data = mockClient.rightSizingRun.update.mock.calls[0][0].data;
            expect(data).toEqual({
                status: 'completed', accountsScanned: 5, resourcesAnalyzed: 100, recommendationsGenerated: 10,
                totalEstimatedSavings: 500, errors: [{ msg: 'x' }], finishedAt,
            });
        });

        it('scopes the update by id only, relying on the tenant client for isolation', async () => {
            const repo = new RightSizingPostgresRepository();
            await repo.updateRun('run-1', 'tenant-a', {});
            expect(mockClient.rightSizingRun.update.mock.calls[0][0].where).toEqual({ id: 'run-1' });
        });
    });

    describe('listRuns', () => {
        it('paginates with defaults of page 1, limit 20', async () => {
            const repo = new RightSizingPostgresRepository();
            await repo.listRuns('tenant-a');
            expect(mockClient.rightSizingRun.findMany.mock.calls[0][0]).toMatchObject({ skip: 0, take: 20 });
        });

        it('computes skip from an explicit page/limit', async () => {
            const repo = new RightSizingPostgresRepository();
            await repo.listRuns('tenant-a', 3, 10);
            expect(mockClient.rightSizingRun.findMany.mock.calls[0][0]).toMatchObject({ skip: 20, take: 10 });
        });

        it('returns the transformed runs and total', async () => {
            mockClient.rightSizingRun.findMany.mockResolvedValue([makeRunRow()]);
            mockClient.rightSizingRun.count.mockResolvedValue(1);
            const repo = new RightSizingPostgresRepository();
            const result = await repo.listRuns('tenant-a');
            expect(result).toEqual({ runs: [expect.objectContaining({ id: 'run-1' })], total: 1 });
        });
    });

    describe('getActiveRun', () => {
        it('returns null when there is no active run', async () => {
            mockClient.rightSizingRun.findFirst.mockResolvedValue(null);
            const repo = new RightSizingPostgresRepository();
            expect(await repo.getActiveRun('tenant-a')).toBeNull();
        });

        it('filters to queued/running status and excludes stale (>2h) rows', async () => {
            const repo = new RightSizingPostgresRepository();
            await repo.getActiveRun('tenant-a');
            const where = mockClient.rightSizingRun.findFirst.mock.calls[0][0].where;
            expect(where.status).toEqual({ in: ['queued', 'running'] });
            expect(where.startedAt.gt).toBeInstanceOf(Date);
        });

        it('returns the transformed run when one is active', async () => {
            mockClient.rightSizingRun.findFirst.mockResolvedValue(makeRunRow({ status: 'running' }));
            const repo = new RightSizingPostgresRepository();
            const run = await repo.getActiveRun('tenant-a');
            expect(run?.status).toBe('running');
        });
    });
});
