// Raw-pg persistence for right-sizing (RS-015). No tenant extension intercepts these
// queries, so every test here asserts an explicit tenantId predicate/param — a test that
// doesn't check this is a filler test per this project's standard.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { connect, query, release } = vi.hoisted(() => ({
    connect: vi.fn(),
    query: vi.fn(),
    release: vi.fn(),
}));

vi.mock('../../discovery/services/db.js', () => ({ getPool: () => ({ connect }) }));

import {
    getAnalyzableResources,
    loadCatalog,
    upsertRecommendations,
    createRun,
    finishRun,
    getTenantPeriodConfig,
    updateLastRun,
    hasActiveRun,
} from './db-writer.js';
import type { RecommendationOutput } from '../types.js';

beforeEach(() => {
    vi.clearAllMocks();
    connect.mockResolvedValue({ query, release });
    query.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('getAnalyzableResources', () => {
    it('scopes the query by tenantId and maps rows to AnalyzableResource', async () => {
        query.mockResolvedValueOnce({
            rows: [{ accountId: 'a1', region: 'us-east-1', resourceType: 'ec2_instances', resourceId: 'i-1', name: 'web', status: 'running', metadata: { instanceType: 'm5.large' } }],
        });

        const result = await getAnalyzableResources('tenant-1');

        expect(result).toEqual([{ accountId: 'a1', region: 'us-east-1', resourceType: 'ec2_instances', resourceId: 'i-1', name: 'web', status: 'running', metadata: { instanceType: 'm5.large' } }]);
        const [sql, params] = query.mock.calls[0];
        expect(sql).toContain('"tenantId" = $1');
        expect(params[0]).toBe('tenant-1');
        expect(release).toHaveBeenCalled();
    });

    it('defaults metadata to {} when the column is null', async () => {
        query.mockResolvedValueOnce({ rows: [{ accountId: 'a1', region: 'us-east-1', resourceType: 'ec2_instances', resourceId: 'i-1', name: null, status: null, metadata: null }] });
        const result = await getAnalyzableResources('tenant-1');
        expect(result[0].metadata).toEqual({});
    });

    it('releases the client even when the query throws', async () => {
        query.mockRejectedValueOnce(new Error('timeout'));
        await expect(getAnalyzableResources('tenant-1')).rejects.toThrow('timeout');
        expect(release).toHaveBeenCalled();
    });
});

describe('loadCatalog', () => {
    it('builds a CatalogApi keyed by service/region/class', async () => {
        query.mockResolvedValueOnce({
            rows: [
                { region: 'us-east-1', serviceCode: 'AmazonEC2', resourceClass: 'm5.large', attributes: { vcpu: 2 }, pricePerHour: 0.096, pricePerGiBMonth: null, pricePerIopsMonth: null },
                { region: 'us-east-1', serviceCode: 'AmazonEC2', resourceClass: 'm5.xlarge', attributes: { vcpu: 4 }, pricePerHour: 0.192, pricePerGiBMonth: null, pricePerIopsMonth: null },
            ],
        });

        const catalog = await loadCatalog(['us-east-1']);

        expect(catalog.getPrice('AmazonEC2', 'us-east-1', 'm5.large')?.pricePerHour).toBe(0.096);
        expect(catalog.getPrice('AmazonEC2', 'us-east-1', 'nope')).toBeNull();
        expect(catalog.listClasses('AmazonEC2', 'us-east-1')).toHaveLength(2);
        expect(catalog.listClasses('AmazonRDS', 'us-east-1')).toEqual([]);
    });

    it('queries a sentinel region instead of an empty ANY() array when given no regions', async () => {
        await loadCatalog([]);
        const [, params] = query.mock.calls[0];
        expect(params[0]).toEqual(['__none__']);
    });

    it('defaults missing attributes to {}', async () => {
        query.mockResolvedValueOnce({ rows: [{ region: 'us-east-1', serviceCode: 'AmazonEBS', resourceClass: 'gp3', attributes: null, pricePerHour: null, pricePerGiBMonth: 0.08, pricePerIopsMonth: null }] });
        const catalog = await loadCatalog(['us-east-1']);
        expect(catalog.getPrice('AmazonEBS', 'us-east-1', 'gp3')?.attributes).toEqual({});
    });
});

function output(overrides: Partial<RecommendationOutput> = {}): RecommendationOutput {
    return {
        accountId: 'a1', region: 'us-east-1', resourceType: 'ec2_instances', resourceId: 'i-1', name: 'web',
        finding: 'optimized', currentConfig: { instanceType: 'm5.large' }, recommendedConfig: null,
        metricsSummary: { coverageDays: 14, datapointDensity: 0.9 }, lookbackDays: 14, currency: 'USD',
        currentMonthlyCost: 70, recommendedMonthlyCost: 70, estimatedMonthlySavings: 0, confidence: 0.9,
        riskLevel: 'low', rationale: 'ok', source: 'cloudwatch', ...overrides,
    };
}

describe('upsertRecommendations', () => {
    it('returns 0 and never connects when there is nothing to write', async () => {
        expect(await upsertRecommendations('tenant-1', [], 'run-1')).toBe(0);
        expect(connect).not.toHaveBeenCalled();
    });

    it('writes one row per output, scoped by tenantId, and returns the written count', async () => {
        const outputs = [output({ resourceId: 'i-1' }), output({ resourceId: 'i-2' })];
        const written = await upsertRecommendations('tenant-1', outputs, 'run-1');

        expect(written).toBe(2);
        expect(query).toHaveBeenCalledTimes(2);
        for (const call of query.mock.calls) {
            const [sql, params] = call;
            expect(sql).toContain('"tenantId"');
            expect(params[0]).toBe('tenant-1');
        }
        expect(release).toHaveBeenCalled();
    });

    it('re-throws and releases the client when an insert fails partway through', async () => {
        query.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('constraint violation'));
        await expect(upsertRecommendations('tenant-1', [output(), output()], 'run-1')).rejects.toThrow('constraint violation');
        expect(release).toHaveBeenCalled();
    });
});

describe('createRun', () => {
    it('inserts a running run scoped to the tenant and returns its id', async () => {
        query.mockResolvedValueOnce({ rows: [{ id: 'run-123' }] });
        const id = await createRun('tenant-1', 'manual', 14);
        expect(id).toBe('run-123');
        const [sql, params] = query.mock.calls[0];
        expect(sql).toContain('"tenantId"');
        expect(params).toEqual(['tenant-1', 'manual', 14]);
    });
});

describe('finishRun', () => {
    it('updates the run scoped by BOTH id and tenantId', async () => {
        await finishRun('run-123', 'tenant-1', {
            status: 'completed', accountsScanned: 3, resourcesAnalyzed: 10,
            recommendationsGenerated: 4, totalEstimatedSavings: 120.5, errors: [],
        });
        const [sql, params] = query.mock.calls[0];
        expect(sql).toContain('WHERE id = $1 AND "tenantId" = $2');
        expect(params[0]).toBe('run-123');
        expect(params[1]).toBe('tenant-1');
    });
});

describe('getTenantPeriodConfig', () => {
    it('scopes the read by tenantId and returns the stored period/lastRunAt', async () => {
        query.mockResolvedValueOnce({ rows: [{ data: { period: 'daily', lastRunAt: '2026-08-01T00:00:00Z' } }] });
        const result = await getTenantPeriodConfig('tenant-1');
        expect(result).toEqual({ period: 'daily', lastRunAt: '2026-08-01T00:00:00Z' });
        const [, params] = query.mock.calls[0];
        expect(params[0]).toBe('tenant-1');
    });

    it('defaults to weekly with no lastRunAt when no config row exists', async () => {
        query.mockResolvedValueOnce({ rows: [] });
        expect(await getTenantPeriodConfig('tenant-1')).toEqual({ period: 'weekly', lastRunAt: null });
    });

    it('falls back to weekly when the stored period is not a recognized value', async () => {
        query.mockResolvedValueOnce({ rows: [{ data: { period: 'hourly' } }] });
        const result = await getTenantPeriodConfig('tenant-1');
        expect(result.period).toBe('weekly');
    });
});

describe('updateLastRun', () => {
    it('upserts scoped by tenantId, merging into existing config data', async () => {
        await updateLastRun('tenant-1', '2026-08-24T00:00:00Z');
        const [sql, params] = query.mock.calls[0];
        expect(sql).toContain('ON CONFLICT ("tenantId","configKey")');
        expect(sql).toContain('tenant_configs.data ||');
        expect(params[0]).toBe('tenant-1');
        expect(JSON.parse(params[2] as string)).toEqual({ lastRunAt: '2026-08-24T00:00:00Z' });
    });
});

describe('hasActiveRun', () => {
    it('scopes the check by tenantId and returns true when a queued/running row exists', async () => {
        query.mockResolvedValueOnce({ rows: [{}], rowCount: 1 });
        expect(await hasActiveRun('tenant-1')).toBe(true);
        const [sql, params] = query.mock.calls[0];
        expect(sql).toContain('"tenantId" = $1');
        expect(params[0]).toBe('tenant-1');
    });

    it('returns false when no active run exists', async () => {
        query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
        expect(await hasActiveRun('tenant-1')).toBe(false);
    });
});
