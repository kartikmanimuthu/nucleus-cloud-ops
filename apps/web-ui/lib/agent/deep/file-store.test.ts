import { describe, it, expect, vi, beforeEach } from 'vitest';

const agentFileMock = vi.hoisted(() => ({
    upsert: vi.fn(), deleteMany: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(),
}));
vi.mock('@/lib/db/pg-config', () => ({ getPrismaClient: () => ({ agentFile: agentFileMock }) }));

import { PostgresFileStore } from './file-store';

describe('PostgresFileStore.batch', () => {
    beforeEach(() => vi.clearAllMocks());

    it('upserts a value (put) scoped to the store tenantId', async () => {
        const store = new PostgresFileStore('tenant-1');
        const results = await store.batch([{ namespace: ['files', 'reports'], key: 'q3.md', value: { content: 'hi' } } as any]);

        expect(agentFileMock.upsert).toHaveBeenCalledWith({
            where: { tenantId_namespace_key: { tenantId: 'tenant-1', namespace: 'files/reports', key: 'q3.md' } },
            create: { tenantId: 'tenant-1', namespace: 'files/reports', key: 'q3.md', value: { content: 'hi' } },
            update: { value: { content: 'hi' } },
        });
        expect(results).toEqual([undefined]);
    });

    it('deletes when value is explicitly null', async () => {
        const store = new PostgresFileStore('tenant-1');
        await store.batch([{ namespace: ['files'], key: 'q3.md', value: null } as any]);

        expect(agentFileMock.deleteMany).toHaveBeenCalledWith({ where: { tenantId: 'tenant-1', namespace: 'files', key: 'q3.md' } });
        expect(agentFileMock.upsert).not.toHaveBeenCalled();
    });

    it('gets an existing item and shapes it via toItem', async () => {
        const now = new Date();
        agentFileMock.findUnique.mockResolvedValue({ namespace: 'files/reports', key: 'q3.md', value: { content: 'hi' }, createdAt: now, updatedAt: now });
        const store = new PostgresFileStore('tenant-1');

        const [result] = await store.batch([{ namespace: ['files', 'reports'], key: 'q3.md' } as any]);

        expect(result).toEqual({ namespace: ['files', 'reports'], key: 'q3.md', value: { content: 'hi' }, createdAt: now, updatedAt: now });
    });

    it('returns null for a get on a missing item', async () => {
        agentFileMock.findUnique.mockResolvedValue(null);
        const store = new PostgresFileStore('tenant-1');
        const [result] = await store.batch([{ namespace: ['files'], key: 'missing.md' } as any]);
        expect(result).toBeNull();
    });

    it('searches by namespacePrefix with default limit/offset', async () => {
        agentFileMock.findMany.mockResolvedValue([]);
        const store = new PostgresFileStore('tenant-1');
        await store.batch([{ namespacePrefix: ['files'] } as any]);

        expect(agentFileMock.findMany).toHaveBeenCalledWith({
            where: { tenantId: 'tenant-1', namespace: { startsWith: 'files' } },
            take: 100, skip: 0, orderBy: { updatedAt: 'desc' },
        });
    });

    it('searches with a custom limit and offset', async () => {
        agentFileMock.findMany.mockResolvedValue([]);
        const store = new PostgresFileStore('tenant-1');
        await store.batch([{ namespacePrefix: ['files'], limit: 10, offset: 20 } as any]);

        expect(agentFileMock.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 10, skip: 20 }));
    });

    it('lists distinct namespaces split into segments, for matchConditions/maxDepth ops', async () => {
        agentFileMock.findMany.mockResolvedValue([{ namespace: 'files/reports' }, { namespace: 'files/logs' }]);
        const store = new PostgresFileStore('tenant-1');

        const [result] = await store.batch([{ matchConditions: [] } as any]);

        expect(agentFileMock.findMany).toHaveBeenCalledWith({
            where: { tenantId: 'tenant-1' }, select: { namespace: true }, distinct: ['namespace'],
        });
        expect(result).toEqual([['files', 'reports'], ['files', 'logs']]);
    });

    it('recognizes maxDepth alone as a list-namespaces op', async () => {
        agentFileMock.findMany.mockResolvedValue([]);
        const store = new PostgresFileStore('tenant-1');
        await store.batch([{ maxDepth: 2 } as any]);
        expect(agentFileMock.findMany).toHaveBeenCalledWith(expect.objectContaining({ distinct: ['namespace'] }));
    });

    it('pushes null for an operation that matches none of the known shapes', async () => {
        const store = new PostgresFileStore('tenant-1');
        const [result] = await store.batch([{} as any]);
        expect(result).toBeNull();
    });

    it('processes multiple operations in one batch call', async () => {
        agentFileMock.findMany.mockResolvedValue([]);
        const store = new PostgresFileStore('tenant-1');
        const results = await store.batch([
            { namespace: ['a'], key: 'k1', value: { x: 1 } } as any,
            { namespacePrefix: ['a'] } as any,
        ]);
        expect(results).toHaveLength(2);
    });
});
