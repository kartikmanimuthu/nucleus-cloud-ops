// pricing_catalog is global reference data, NOT tenant-scoped (unlike db-writer.ts's
// right_sizing_recommendations) — so these tests assert the upsert conflict key
// (region/serviceCode/resourceClass) instead of a tenantId predicate.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { connect, query, release } = vi.hoisted(() => ({
    connect: vi.fn(),
    query: vi.fn(),
    release: vi.fn(),
}));

vi.mock('../../discovery/services/db.js', () => ({ getPool: () => ({ connect }) }));

import { getDistinctAccountRegions, upsertPricingEntries } from './pricing-writer.js';
import type { PricingEntry } from './pricing-client.js';

beforeEach(() => {
    vi.clearAllMocks();
    connect.mockResolvedValue({ query, release });
    query.mockResolvedValue({ rows: [] });
});

describe('getDistinctAccountRegions', () => {
    it('returns the distinct regions from active accounts', async () => {
        query.mockResolvedValueOnce({ rows: [{ region: 'us-east-1' }, { region: 'ap-south-1' }] });
        const regions = await getDistinctAccountRegions();
        expect(regions).toEqual(['us-east-1', 'ap-south-1']);
        expect(query.mock.calls[0][0]).toContain('WHERE active = true');
        expect(release).toHaveBeenCalled();
    });

    it('filters out falsy region values', async () => {
        query.mockResolvedValueOnce({ rows: [{ region: 'us-east-1' }, { region: null }, { region: '' }] });
        expect(await getDistinctAccountRegions()).toEqual(['us-east-1']);
    });

    it('releases the client even when the query throws', async () => {
        query.mockRejectedValueOnce(new Error('timeout'));
        await expect(getDistinctAccountRegions()).rejects.toThrow('timeout');
        expect(release).toHaveBeenCalled();
    });
});

function pricingEntry(overrides: Partial<PricingEntry> = {}): PricingEntry {
    return { region: 'us-east-1', serviceCode: 'AmazonEC2', resourceClass: 'm5.large', attributes: { vcpu: 2 }, pricePerHour: 0.096, ...overrides };
}

describe('upsertPricingEntries', () => {
    it('returns 0 and never connects for an empty entry list', async () => {
        expect(await upsertPricingEntries([])).toBe(0);
        expect(connect).not.toHaveBeenCalled();
    });

    it('upserts one row per entry keyed by region/serviceCode/resourceClass', async () => {
        const entries = [pricingEntry({ resourceClass: 'm5.large' }), pricingEntry({ resourceClass: 'm5.xlarge' })];
        const written = await upsertPricingEntries(entries);

        expect(written).toBe(2);
        expect(query).toHaveBeenCalledTimes(2);
        const [sql, params] = query.mock.calls[0];
        expect(sql).toContain('ON CONFLICT (region, "serviceCode", "resourceClass")');
        expect(params[0]).toBe('us-east-1');
        expect(params[1]).toBe('AmazonEC2');
        expect(params[2]).toBe('m5.large');
        expect(release).toHaveBeenCalled();
    });

    it('defaults currency to USD and nulls missing price fields', async () => {
        await upsertPricingEntries([pricingEntry({ pricePerHour: undefined, pricePerGiBMonth: undefined, pricePerIopsMonth: undefined, currency: undefined })]);
        const [, params] = query.mock.calls[0];
        expect(params[4]).toBeNull(); // pricePerHour
        expect(params[5]).toBeNull(); // pricePerGiBMonth
        expect(params[6]).toBeNull(); // pricePerIopsMonth
        expect(params[7]).toBe('USD');
    });

    it('re-throws and releases the client when an insert fails partway through', async () => {
        query.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('constraint violation'));
        await expect(upsertPricingEntries([pricingEntry(), pricingEntry({ resourceClass: 'm5.xlarge' })])).rejects.toThrow('constraint violation');
        expect(release).toHaveBeenCalled();
    });
});
