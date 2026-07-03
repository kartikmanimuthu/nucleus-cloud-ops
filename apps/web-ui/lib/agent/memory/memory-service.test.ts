import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the prisma client + embeddings BEFORE importing the service.
const mockExecuteRaw = vi.fn().mockResolvedValue(1);
const mockQueryRaw = vi.fn().mockResolvedValue([]);
const mockUpsert = vi.fn().mockResolvedValue({});
const mockFindUnique = vi.fn().mockResolvedValue(null);
const mockUpdateMany = vi.fn().mockResolvedValue({ count: 1 });

vi.mock('@/lib/db/pg-config', () => ({
    getPrismaClient: () => ({
        $executeRaw: mockExecuteRaw,
        $queryRaw: mockQueryRaw,
        agentMemory: { upsert: mockUpsert, findFirst: mockFindUnique, create: mockUpsert, updateMany: mockUpdateMany },
        agentWorkingMemory: { upsert: mockUpsert, findUnique: mockFindUnique },
    }),
}));

vi.mock('../embeddings-factory', () => ({
    getTenantEmbeddings: vi.fn().mockResolvedValue({
        embedQuery: vi.fn().mockResolvedValue(new Array(1024).fill(0.1)),
    }),
}));

import { getMemoryService } from './memory-service';

describe('MemoryService.recall', () => {
    beforeEach(() => {
        mockQueryRaw.mockClear();
        mockQueryRaw.mockResolvedValue([
            { namespace: 'infra/123', key: 'region', value: { fact: 'us-east-1' }, kind: 'SEMANTIC' },
        ]);
    });

    it('returns typed MemoryHit[] and filters by kind', async () => {
        const svc = getMemoryService();
        const hits = await svc.recall({
            tenantId: 't1', userId: 'u1', query: 'where is prod', kinds: ['SEMANTIC'], limit: 5,
        });
        expect(hits).toHaveLength(1);
        expect(hits[0]).toMatchObject({ namespace: 'infra/123', key: 'region', kind: 'SEMANTIC' });
        // vector search path was used (embedding available)
        expect(mockQueryRaw).toHaveBeenCalled();
    });
});

describe('MemoryService.remember', () => {
    it('upserts with an embedding vector and returns the row id', async () => {
        mockQueryRaw.mockClear();
        mockQueryRaw.mockResolvedValueOnce([{ id: 'row-1' }]);
        const svc = getMemoryService();
        const id = await svc.remember({
            tenantId: 't1', userId: 'u1', kind: 'SEMANTIC',
            namespace: ['infra', '123'], key: 'region',
            value: { fact: 'us-east-1', source: 'cli', confidence: 'high' },
        });
        expect(id).toBe('row-1');
        expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    });
});

describe('MemoryService.recall hit shape', () => {
    it('returns id and distance on vector hits', async () => {
        mockQueryRaw.mockClear();
        mockQueryRaw.mockResolvedValueOnce([
            { id: 'm-1', namespace: 'infra/123', key: 'region', value: { fact: 'us-east-1' }, kind: 'SEMANTIC', distance: 0.12 },
        ]);
        const svc = getMemoryService();
        const hits = await svc.recall({ tenantId: 't1', userId: 'u1', query: 'region', limit: 5 });
        expect(hits[0]).toMatchObject({ id: 'm-1', kind: 'SEMANTIC', distance: 0.12 });
    });
});

describe('MemoryService.supersede', () => {
    it('marks the old row tenant-scoped', async () => {
        const svc = getMemoryService();
        await svc.supersede('t1', 'old-1', 'new-1');
        expect(mockUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'old-1', tenantId: 't1' },
            data: expect.objectContaining({ supersededById: 'new-1' }),
        }));
    });
});

describe('MemoryService.reinforce', () => {
    it('refreshes TTL and bumps accessCount tenant-scoped', async () => {
        const svc = getMemoryService();
        await svc.reinforce('t1', 'm-1');
        const arg = mockUpdateMany.mock.calls.at(-1)![0];
        expect(arg.where).toEqual({ id: 'm-1', tenantId: 't1' });
        expect(arg.data.accessCount).toEqual({ increment: 1 });
        expect(arg.data.expiresAt).toBeInstanceOf(Date);
    });
});

describe('MemoryService.update', () => {
    it('updates value + embedding via raw SQL when embedding succeeds', async () => {
        mockExecuteRaw.mockClear();
        const svc = getMemoryService();
        await svc.update('t1', 'm-1', { fact: 'refined' });
        expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
    });
});
