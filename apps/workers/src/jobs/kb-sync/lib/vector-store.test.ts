import { describe, it, expect, vi, beforeEach } from 'vitest';

const { connect, query, release } = vi.hoisted(() => ({
    connect: vi.fn(),
    query: vi.fn(),
    release: vi.fn(),
}));

vi.mock('../../../env.js', () => ({ env: { DATABASE_URL: 'postgres://test', DEFAULT_TENANT_ID: undefined } }));
vi.mock('pg', () => ({
    Pool: vi.fn().mockImplementation(function (this: any) { this.connect = connect; }),
}));

import { getDataSource, updateDS, updateKBVectorCount, recomputeKBVectorCount, DEFAULT_TENANT } from './vector-store.js';

beforeEach(() => {
    vi.clearAllMocks();
    connect.mockResolvedValue({ query, release });
    query.mockResolvedValue({ rows: [] });
});

describe('DEFAULT_TENANT', () => {
    it('falls back to org-default when DEFAULT_TENANT_ID is unset', () => {
        expect(DEFAULT_TENANT).toBe('org-default');
    });
});

describe('getDataSource', () => {
    it('returns null when the data source does not exist', async () => {
        query.mockResolvedValueOnce({ rows: [] });
        expect(await getDataSource('kb1', 'ds1')).toBeNull();
        const [sql, params] = query.mock.calls[0];
        expect(sql).toContain('WHERE id = $1 AND "knowledgeBaseId" = $2');
        expect(params).toEqual(['ds1', 'kb1']);
        expect(release).toHaveBeenCalled();
    });

    it('maps the row and defaults config to {} when null', async () => {
        query.mockResolvedValueOnce({ rows: [{ vectorCount: 5, vectorKeys: ['k1'], status: 'active', config: null, sourceType: 's3' }] });
        const result = await getDataSource('kb1', 'ds1');
        expect(result).toEqual({ vectorCount: 5, vectorKeys: ['k1'], status: 'active', config: {}, sourceType: 's3' });
    });

    it('releases the client even when the query throws', async () => {
        query.mockRejectedValueOnce(new Error('timeout'));
        await expect(getDataSource('kb1', 'ds1')).rejects.toThrow('timeout');
        expect(release).toHaveBeenCalled();
    });
});

describe('updateDS', () => {
    it('builds a SET clause only for the fields provided', async () => {
        await updateDS('kb1', 'ds1', { status: 'active' });
        const [sql, params] = query.mock.calls[0];
        expect(sql).toContain('status = $1');
        expect(sql).not.toContain('"vectorCount" = $');
        expect(sql).toContain('WHERE id = $2 AND "knowledgeBaseId" = $3');
        expect(params).toEqual(['active', 'ds1', 'kb1']);
    });

    it('converts lastSyncAt to a Date', async () => {
        await updateDS('kb1', 'ds1', { lastSyncAt: '2026-08-01T00:00:00Z' });
        const [, params] = query.mock.calls[0];
        expect(params[0]).toBeInstanceOf(Date);
    });

    it('skips the Date conversion when lastSyncAt is falsy (clearing it)', async () => {
        await updateDS('kb1', 'ds1', { lastSyncAt: null });
        const [, params] = query.mock.calls[0];
        expect(params[0]).toBeNull();
    });

    it('includes vectorKeys as a dedicated array param when provided', async () => {
        await updateDS('kb1', 'ds1', { status: 'active', vectorKeys: ['a', 'b'] });
        const [sql, params] = query.mock.calls[0];
        expect(sql).toContain('"vectorKeys" = $2');
        expect(params).toEqual(['active', ['a', 'b'], 'ds1', 'kb1']);
    });

    it('always stamps updatedAt even with no other fields', async () => {
        await updateDS('kb1', 'ds1', {});
        const [sql, params] = query.mock.calls[0];
        expect(sql).toContain('"updatedAt" = NOW()');
        expect(params).toEqual(['ds1', 'kb1']);
    });
});

describe('updateKBVectorCount', () => {
    it('does nothing when delta is 0', async () => {
        await updateKBVectorCount('kb1', 0);
        expect(connect).not.toHaveBeenCalled();
    });

    it('increments the KB vectorCount by delta', async () => {
        await updateKBVectorCount('kb1', 5);
        const [sql, params] = query.mock.calls[0];
        expect(sql).toContain('COALESCE("vectorCount", 0) + $1');
        expect(params).toEqual([5, 'kb1']);
    });

    it('accepts a negative delta to decrement', async () => {
        await updateKBVectorCount('kb1', -3);
        const [, params] = query.mock.calls[0];
        expect(params[0]).toBe(-3);
    });
});

describe('recomputeKBVectorCount', () => {
    it('recomputes the KB vectorCount from the sum of its data sources', async () => {
        await recomputeKBVectorCount('kb1');
        const [sql, params] = query.mock.calls[0];
        expect(sql).toContain('SUM(ds."vectorCount")');
        expect(params).toEqual(['kb1']);
        expect(release).toHaveBeenCalled();
    });
});
