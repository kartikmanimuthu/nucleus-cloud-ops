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

import { getMemoryService, MemoryService } from './memory-service';
import { getTenantEmbeddings } from '../embeddings-factory';

function mockEmbeddingsRejects() {
    vi.mocked(getTenantEmbeddings).mockResolvedValueOnce({
        embedQuery: vi.fn().mockRejectedValue(new Error('no provider configured')),
    } as never);
}

/** Unlike mockEmbeddingsRejects (embedQuery throws), this rejects getTenantEmbeddings
 *  itself — the only path that trips getEmbeddings()'s cache-eviction .catch(). */
function mockGetTenantEmbeddingsRejects() {
    vi.mocked(getTenantEmbeddings).mockRejectedValueOnce(new Error('no default provider'));
}

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

    it('keeps the old embedding — falls back to the ORM updateMany path — when re-embedding fails', async () => {
        mockExecuteRaw.mockClear();
        mockUpdateMany.mockClear();
        mockEmbeddingsRejects();
        const svc = new MemoryService();

        await svc.update('t-update-fail', 'm-1', { fact: 'refined' });

        expect(mockExecuteRaw).not.toHaveBeenCalled();
        expect(mockUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'm-1', tenantId: 't-update-fail' },
            data: expect.objectContaining({ value: { fact: 'refined' } }),
        }));
    });
});

describe('MemoryService.recall — embedding-failure fallback', () => {
    it('falls back to the recency (non-vector) query when embedding fails', async () => {
        mockQueryRaw.mockClear();
        mockQueryRaw.mockResolvedValueOnce([
            { id: 'm-2', namespace: 'infra/123', key: 'region', value: { fact: 'x' }, kind: 'SEMANTIC', distance: null },
        ]);
        mockEmbeddingsRejects();
        const svc = new MemoryService();

        const hits = await svc.recall({ tenantId: 't-recall-fail', userId: 'u1', query: 'region' });

        expect(hits).toHaveLength(1);
        expect(hits[0]).not.toHaveProperty('distance');
        const sql = mockQueryRaw.mock.calls[0][0] as unknown as { raw: string[] };
        expect(sql.raw.join('')).toContain('ORDER BY "createdAt" DESC');
    });

    it('does not attach a distance field when the row distance is null', async () => {
        mockQueryRaw.mockClear();
        mockQueryRaw.mockResolvedValueOnce([
            { id: 'm-3', namespace: 'ns', key: 'k', value: {}, kind: 'SEMANTIC', distance: null },
        ]);
        const svc = getMemoryService();
        const hits = await svc.recall({ tenantId: 't1', userId: 'u1', query: 'q' });
        expect(hits[0]).not.toHaveProperty('distance');
    });

    it('fires a best-effort reinforcement UPDATE for the recalled ids', async () => {
        mockExecuteRaw.mockClear();
        mockQueryRaw.mockClear();
        mockQueryRaw.mockResolvedValueOnce([{ id: 'm-4', namespace: 'ns', key: 'k', value: {}, kind: 'SEMANTIC', distance: 0.1 }]);
        const svc = getMemoryService();
        await svc.recall({ tenantId: 't1', userId: 'u1', query: 'q' });
        expect(mockExecuteRaw).toHaveBeenCalled();
    });

    it('does not blow up recall when the fire-and-forget reinforcement UPDATE itself rejects', async () => {
        mockExecuteRaw.mockClear();
        mockExecuteRaw.mockRejectedValueOnce(new Error('reinforcement update failed'));
        mockQueryRaw.mockClear();
        mockQueryRaw.mockResolvedValueOnce([{ id: 'm-5', namespace: 'ns', key: 'k', value: {}, kind: 'SEMANTIC', distance: 0.1 }]);
        const svc = getMemoryService();
        await expect(svc.recall({ tenantId: 't1', userId: 'u1', query: 'q' })).resolves.toHaveLength(1);
    });

    it('skips the reinforcement UPDATE entirely when recall returns no rows', async () => {
        mockExecuteRaw.mockClear();
        mockQueryRaw.mockClear();
        mockQueryRaw.mockResolvedValueOnce([]);
        const svc = getMemoryService();
        await svc.recall({ tenantId: 't1', userId: 'u1', query: 'q' });
        expect(mockExecuteRaw).not.toHaveBeenCalled();
    });
});

describe('MemoryService.remember — embedding-failure ORM fallback', () => {
    beforeEach(() => {
        mockFindUnique.mockReset();
        mockUpdateMany.mockClear();
        mockUpsert.mockClear();
    });

    it('updates the existing live row when one is found (no embedding)', async () => {
        mockEmbeddingsRejects();
        mockFindUnique.mockResolvedValueOnce({ id: 'existing-1' });
        const svc = new MemoryService();

        const id = await svc.remember({
            tenantId: 't-remember-1', userId: 'u1', kind: 'SEMANTIC', namespace: ['infra'], key: 'region', value: { fact: 'x' },
        });

        expect(id).toBe('existing-1');
        expect(mockUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'existing-1', tenantId: 't-remember-1' } }));
    });

    it('creates a new row when no live row exists (no embedding)', async () => {
        mockEmbeddingsRejects();
        mockFindUnique.mockResolvedValueOnce(null);
        mockUpsert.mockResolvedValueOnce({ id: 'created-1' });
        const svc = new MemoryService();

        const id = await svc.remember({
            tenantId: 't-remember-2', userId: 'u1', kind: 'SEMANTIC', namespace: ['infra'], key: 'region', value: { fact: 'x' },
        });

        expect(id).toBe('created-1');
    });

    it('resolves a P2002 create race by updating the winner row', async () => {
        mockEmbeddingsRejects();
        mockFindUnique.mockResolvedValueOnce(null); // no live row initially
        mockUpsert.mockRejectedValueOnce(Object.assign(new Error('unique violation'), { code: 'P2002' }));
        mockFindUnique.mockResolvedValueOnce({ id: 'winner-1' }); // re-check after conflict
        const svc = new MemoryService();

        const id = await svc.remember({
            tenantId: 't-remember-3', userId: 'u1', kind: 'SEMANTIC', namespace: ['infra'], key: 'region', value: { fact: 'x' },
        });

        expect(id).toBe('winner-1');
        expect(mockUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'winner-1', tenantId: 't-remember-3' } }));
    });

    it('rethrows a P2002 conflict when no winner row can be found', async () => {
        mockEmbeddingsRejects();
        mockFindUnique.mockResolvedValueOnce(null);
        mockUpsert.mockRejectedValueOnce(Object.assign(new Error('unique violation'), { code: 'P2002' }));
        mockFindUnique.mockResolvedValueOnce(null);
        const svc = new MemoryService();

        await expect(svc.remember({
            tenantId: 't-remember-4', userId: 'u1', kind: 'SEMANTIC', namespace: ['infra'], key: 'region', value: { fact: 'x' },
        })).rejects.toMatchObject({ code: 'P2002' });
    });

    it('rethrows a non-P2002 create error', async () => {
        mockEmbeddingsRejects();
        mockFindUnique.mockResolvedValueOnce(null);
        mockUpsert.mockRejectedValueOnce(new Error('connection reset'));
        const svc = new MemoryService();

        await expect(svc.remember({
            tenantId: 't-remember-5', userId: 'u1', kind: 'SEMANTIC', namespace: ['infra'], key: 'region', value: { fact: 'x' },
        })).rejects.toThrow('connection reset');
    });
});

describe('MemoryService working memory', () => {
    it('getWorkingMemory returns null when no row exists', async () => {
        mockFindUnique.mockReset().mockResolvedValueOnce(null);
        const svc = getMemoryService();
        expect(await svc.getWorkingMemory('t1', 'thread-1')).toBeNull();
    });

    it('getWorkingMemory shapes the row into a WorkingMemory object, defaulting a missing scratchpad', async () => {
        mockFindUnique.mockReset().mockResolvedValueOnce({
            runningSummary: 'summary text', scratchpad: null, tokenCount: 100, turnCount: 3,
        });
        const svc = getMemoryService();

        const wm = await svc.getWorkingMemory('t1', 'thread-1');

        expect(wm).toEqual({ runningSummary: 'summary text', scratchpad: {}, tokenCount: 100, turnCount: 3 });
    });

    it('putWorkingMemory upserts scoped to (tenantId, threadId)', async () => {
        mockUpsert.mockClear();
        const svc = getMemoryService();

        await svc.putWorkingMemory({
            tenantId: 't1', threadId: 'thread-1',
            wm: { runningSummary: 's', scratchpad: { openGoals: [], keyFindings: [], resourceIds: [], pendingSteps: [] }, tokenCount: 10, turnCount: 1 },
        });

        expect(mockUpsert).toHaveBeenCalledWith(expect.objectContaining({
            where: { tenantId_threadId: { tenantId: 't1', threadId: 'thread-1' } },
        }));
    });
});

describe('MemoryService.getEmbeddings caching', () => {
    it('reuses the cached embeddings promise for the same tenant across calls', async () => {
        vi.mocked(getTenantEmbeddings).mockClear();
        const svc = new MemoryService();
        mockQueryRaw.mockResolvedValue([]);

        await svc.recall({ tenantId: 't-cache-1', userId: 'u1', query: 'a' });
        await svc.recall({ tenantId: 't-cache-1', userId: 'u1', query: 'b' });

        expect(vi.mocked(getTenantEmbeddings)).toHaveBeenCalledTimes(1);
    });

    it('evicts the cache entry on failure so a later call retries', async () => {
        vi.mocked(getTenantEmbeddings).mockClear();
        mockGetTenantEmbeddingsRejects();
        const svc = new MemoryService();
        mockQueryRaw.mockResolvedValue([]);

        await svc.recall({ tenantId: 't-cache-2', userId: 'u1', query: 'a' });
        await svc.recall({ tenantId: 't-cache-2', userId: 'u1', query: 'b' });

        expect(vi.mocked(getTenantEmbeddings)).toHaveBeenCalledTimes(2);
    });
});

describe('getMemoryService', () => {
    it('returns the same singleton instance across calls', () => {
        expect(getMemoryService()).toBe(getMemoryService());
    });
});
