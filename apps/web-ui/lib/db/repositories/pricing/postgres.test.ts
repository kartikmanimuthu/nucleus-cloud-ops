import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFindUnique, mockFindMany, mockUpsert, mockTransaction } = vi.hoisted(() => ({
    mockFindUnique: vi.fn(), mockFindMany: vi.fn(), mockUpsert: vi.fn(), mockTransaction: vi.fn(),
}));

vi.mock('@/lib/db/pg-config', () => ({
    getPrismaClient: () => ({
        pricingCatalogEntry: { findUnique: mockFindUnique, findMany: mockFindMany, upsert: mockUpsert },
        $transaction: mockTransaction,
    }),
}));

import { PricingCatalogPostgresRepository } from './postgres';

const repo = new PricingCatalogPostgresRepository();

const ROW = {
    region: 'us-east-1', serviceCode: 'ec2', resourceClass: 'm5.large', attributes: { vcpu: 2 },
    pricePerHour: 0.096, pricePerGiBMonth: null, pricePerIopsMonth: null, currency: 'USD',
};

beforeEach(() => {
    vi.clearAllMocks();
    mockTransaction.mockImplementation((ops: unknown[]) => Promise.all(ops as Promise<unknown>[]));
});

describe('getPrice', () => {
    it('looks up the composite key and returns the transformed entry', async () => {
        mockFindUnique.mockResolvedValue(ROW);
        const result = await repo.getPrice('us-east-1', 'ec2', 'm5.large');
        expect(mockFindUnique).toHaveBeenCalledWith({
            where: { region_serviceCode_resourceClass: { region: 'us-east-1', serviceCode: 'ec2', resourceClass: 'm5.large' } },
        });
        expect(result).toEqual({
            region: 'us-east-1', serviceCode: 'ec2', resourceClass: 'm5.large', attributes: { vcpu: 2 },
            pricePerHour: 0.096, pricePerGiBMonth: null, pricePerIopsMonth: null, currency: 'USD',
        });
    });

    it('returns null when no price is catalogued', async () => {
        mockFindUnique.mockResolvedValue(null);
        expect(await repo.getPrice('us-east-1', 'ec2', 'unknown')).toBeNull();
    });

    it('defaults a null attributes column to {}', async () => {
        mockFindUnique.mockResolvedValue({ ...ROW, attributes: null });
        const result = await repo.getPrice('us-east-1', 'ec2', 'm5.large');
        expect(result?.attributes).toEqual({});
    });
});

describe('listByService', () => {
    it('filters by serviceCode alone when no region is given', async () => {
        mockFindMany.mockResolvedValue([ROW]);
        await repo.listByService('ec2');
        expect(mockFindMany).toHaveBeenCalledWith({ where: { serviceCode: 'ec2' } });
    });

    it('adds a region filter when one is given', async () => {
        mockFindMany.mockResolvedValue([]);
        await repo.listByService('ec2', 'us-east-1');
        expect(mockFindMany).toHaveBeenCalledWith({ where: { serviceCode: 'ec2', region: 'us-east-1' } });
    });

    it('returns every row transformed', async () => {
        mockFindMany.mockResolvedValue([ROW, { ...ROW, resourceClass: 'm5.xlarge' }]);
        const result = await repo.listByService('ec2');
        expect(result).toHaveLength(2);
        expect(result[1].resourceClass).toBe('m5.xlarge');
    });
});

describe('upsertEntries', () => {
    it('short-circuits on an empty list without opening a transaction', async () => {
        expect(await repo.upsertEntries([])).toBe(0);
        expect(mockTransaction).not.toHaveBeenCalled();
    });

    it('upserts every entry inside one transaction and returns the count', async () => {
        mockUpsert.mockResolvedValue({});
        const count = await repo.upsertEntries([ROW, { ...ROW, resourceClass: 'm5.xlarge' }]);
        expect(count).toBe(2);
        expect(mockTransaction).toHaveBeenCalledOnce();
        expect(mockUpsert).toHaveBeenCalledTimes(2);
    });

    it('chunks more than 200 entries into multiple transactions', async () => {
        mockUpsert.mockResolvedValue({});
        const entries = Array.from({ length: 250 }, (_, i) => ({ ...ROW, resourceClass: `m5.${i}` }));
        await repo.upsertEntries(entries);
        expect(mockTransaction).toHaveBeenCalledTimes(2);
        expect(mockUpsert).toHaveBeenCalledTimes(250);
    });

    it('defaults null price fields and currency, and stamps refreshedAt on update', async () => {
        mockUpsert.mockResolvedValue({});
        await repo.upsertEntries([{
            region: 'us-east-1', serviceCode: 'rds', resourceClass: 'db.t3.micro', attributes: undefined,
            pricePerHour: null, pricePerGiBMonth: null, pricePerIopsMonth: null, currency: undefined as any,
        }]);
        const call = mockUpsert.mock.calls[0][0];
        expect(call.create).toEqual({
            region: 'us-east-1', serviceCode: 'rds', resourceClass: 'db.t3.micro', attributes: {},
            pricePerHour: null, pricePerGiBMonth: null, pricePerIopsMonth: null, currency: 'USD',
        });
        expect(call.update.currency).toBe('USD');
        expect(call.update.refreshedAt).toBeInstanceOf(Date);
    });

    it('passes through explicit attributes, prices, and currency unchanged', async () => {
        mockUpsert.mockResolvedValue({});
        await repo.upsertEntries([ROW]);
        const call = mockUpsert.mock.calls[0][0];
        expect(call.create.attributes).toEqual({ vcpu: 2 });
        expect(call.create.pricePerHour).toBe(0.096);
        expect(call.create.currency).toBe('USD');
    });
});
