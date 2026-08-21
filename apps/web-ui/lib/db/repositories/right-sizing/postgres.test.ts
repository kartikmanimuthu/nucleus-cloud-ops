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

describe('RightSizingPostgresRepository — tenant isolation', () => {
    let mockClient: {
        rightSizingRecommendation: {
            findMany: MockedFunction<any>;
            count: MockedFunction<any>;
            findFirst: MockedFunction<any>;
            update: MockedFunction<any>;
        };
    };
    const getTenantClientMock = getTenantClient as unknown as MockedFunction<any>;

    beforeEach(() => {
        mockClient = {
            rightSizingRecommendation: {
                findMany: vi.fn().mockResolvedValue([makeRow()]),
                count: vi.fn().mockResolvedValue(1),
                findFirst: vi.fn().mockResolvedValue(makeRow()),
                update: vi.fn().mockResolvedValue(makeRow({ status: 'approved' })),
            },
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
});
