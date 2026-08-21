import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MockedFunction } from 'vitest';

vi.mock('@/lib/db/pg-config', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/db/pg-config')>()),
    getTenantClient: vi.fn(),
}));

import { getTenantClient } from '@/lib/db/pg-config';
import { NetworkLinksPostgresRepository } from './postgres';

const makeRow = (overrides: Record<string, unknown> = {}) => ({
    tenantId: 't1',
    accountId: 'acc-1',
    region: 'ap-south-1',
    resourceType: 'dx_connection',
    resourceId: 'dxcon-1',
    displayName: 'Primary DX',
    installedBandwidthMbps: 1000,
    bpsAvgIn: 1_000_000,
    bpsMaxIn: 2_000_000,
    bpsAvgOut: 500_000,
    bpsMaxOut: 900_000,
    stateUp: true,
    bucketStartUtc: new Date('2026-04-13T09:00:00.000Z'),
    ...overrides,
});

describe('NetworkLinksPostgresRepository', () => {
    let mockFindMany: MockedFunction<any>;

    beforeEach(() => {
        mockFindMany = vi.fn();
        vi.mocked(getTenantClient).mockReturnValue({
            networkLinkSample: { findMany: mockFindMany },
        } as never);
    });

    describe('listSamples', () => {
        it('maps rows to the NetworkLinkSample shape', async () => {
            mockFindMany.mockResolvedValueOnce([makeRow()]);
            const repo = new NetworkLinksPostgresRepository();
            const result = await repo.listSamples('t1', {});
            expect(result).toEqual([
                {
                    tenantId: 't1',
                    accountId: 'acc-1',
                    region: 'ap-south-1',
                    resourceType: 'dx_connection',
                    resourceId: 'dxcon-1',
                    displayName: 'Primary DX',
                    installedBandwidthMbps: 1000,
                    bpsAvgIn: 1_000_000,
                    bpsMaxIn: 2_000_000,
                    bpsAvgOut: 500_000,
                    bpsMaxOut: 900_000,
                    stateUp: true,
                    bucketStartUtc: new Date('2026-04-13T09:00:00.000Z'),
                },
            ]);
        });

        it('scopes the query to the given tenantId', async () => {
            mockFindMany.mockResolvedValueOnce([]);
            const repo = new NetworkLinksPostgresRepository();
            await repo.listSamples('t1', {});
            expect(getTenantClient).toHaveBeenCalledWith('t1');
            expect(mockFindMany).toHaveBeenCalledWith(
                expect.objectContaining({ where: { tenantId: 't1' } })
            );
        });

        it('orders by bucketStartUtc ascending', async () => {
            mockFindMany.mockResolvedValueOnce([]);
            const repo = new NetworkLinksPostgresRepository();
            await repo.listSamples('t1', {});
            expect(mockFindMany).toHaveBeenCalledWith(
                expect.objectContaining({ orderBy: { bucketStartUtc: 'asc' } })
            );
        });

        it('adds accountId and region to the where clause when provided', async () => {
            mockFindMany.mockResolvedValueOnce([]);
            const repo = new NetworkLinksPostgresRepository();
            await repo.listSamples('t1', { accountId: 'acc-1', region: 'ap-south-1' });
            expect(mockFindMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { tenantId: 't1', accountId: 'acc-1', region: 'ap-south-1' },
                })
            );
        });

        it('filters bucketStartUtc by dateFrom/dateTo, anchored to IST calendar days', async () => {
            // Not naive UTC midnight (istDayRangeFilter's whole point — see
            // lib/ist-date-range.ts): dateTo's upper bound is exclusive, at the
            // start of the IST day AFTER dateTo, so the entire selected day counts.
            mockFindMany.mockResolvedValueOnce([]);
            const repo = new NetworkLinksPostgresRepository();
            await repo.listSamples('t1', { dateFrom: '2026-04-01', dateTo: '2026-04-30' });
            expect(mockFindMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: {
                        tenantId: 't1',
                        bucketStartUtc: { gte: new Date('2026-03-31T18:30:00.000Z'), lt: new Date('2026-04-30T18:30:00.000Z') },
                    },
                })
            );
        });

        it('omits bucketStartUtc from the where clause when no dates provided', async () => {
            mockFindMany.mockResolvedValueOnce([]);
            const repo = new NetworkLinksPostgresRepository();
            await repo.listSamples('t1', {});
            expect(mockFindMany).toHaveBeenCalledWith(
                expect.objectContaining({ where: { tenantId: 't1' } })
            );
        });
    });
});
