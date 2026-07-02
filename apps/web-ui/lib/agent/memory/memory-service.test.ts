import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the prisma client + embeddings BEFORE importing the service.
const mockExecuteRaw = vi.fn().mockResolvedValue(1);
const mockQueryRaw = vi.fn().mockResolvedValue([]);
const mockUpsert = vi.fn().mockResolvedValue({});
const mockFindUnique = vi.fn().mockResolvedValue(null);

vi.mock('@/lib/db/pg-config', () => ({
    getPrismaClient: () => ({
        $executeRaw: mockExecuteRaw,
        $queryRaw: mockQueryRaw,
        agentMemory: { upsert: mockUpsert },
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
