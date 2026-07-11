import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/knowledge-base/embedder', () => ({ getEmbedding: vi.fn().mockResolvedValue([0.1, 0.2]) }));
vi.mock('@/lib/db/pg-config', () => ({ getPrismaClient: vi.fn() }));

import { getEmbedding } from '@/lib/knowledge-base/embedder';
import { getPrismaClient } from '@/lib/db/pg-config';
import { searchKbChunks } from './retrieval';

const rows = [
    { vectorKey: 'k1', documentName: 'Doc', sourceType: 'document', chunkIndex: 0, totalChunks: 1, knowledgeBaseId: 'kb1', dataSourceId: 'ds1', textContent: 'hello', score: 0.9 },
    { vectorKey: 'k2', documentName: 'Doc', sourceType: 'document', chunkIndex: 1, totalChunks: 2, knowledgeBaseId: 'kb1', dataSourceId: 'ds1', textContent: 'low', score: 0.2 },
];

describe('searchKbChunks', () => {
    let q: ReturnType<typeof vi.fn>;
    beforeEach(() => {
        q = vi.fn().mockResolvedValue(rows);
        vi.mocked(getPrismaClient).mockReturnValue({ $queryRawUnsafe: q } as any);
        vi.mocked(getEmbedding).mockClear();
    });

    it('embeds the query with the tenant id', async () => {
        await searchKbChunks({ tenantId: 't1', query: 'q' });
        expect(getEmbedding).toHaveBeenCalledWith('q', 't1');
    });

    it('tenant-only scope when no kb ids', async () => {
        await searchKbChunks({ tenantId: 't1', query: 'q' });
        const sql = q.mock.calls[0][0] as string;
        expect(sql).not.toContain('ANY(');
        expect(sql).toContain('"tenantId" = $2');
        expect(sql).toContain("status = 'active'");
        expect(q.mock.calls[0].slice(1)).toEqual(['[0.1,0.2]', 't1']);
    });

    it('scopes to multiple kb ids via ANY($3::text[])', async () => {
        await searchKbChunks({ tenantId: 't1', query: 'q', knowledgeBaseIds: ['kb1', 'kb2'] });
        const sql = q.mock.calls[0][0] as string;
        expect(sql).toContain('"knowledgeBaseId" = ANY($3::text[])');
        expect(sql).toContain("status = 'active'");
        expect(q.mock.calls[0][3]).toEqual(['kb1', 'kb2']);
    });

    it('always restricts to active knowledge bases via a tenant-scoped subquery', async () => {
        await searchKbChunks({ tenantId: 't1', query: 'q' });
        const sql = q.mock.calls[0][0] as string;
        expect(sql).toContain('FROM knowledge_bases');
        expect(sql).toContain('"tenantId" = $2');
        expect(sql).toContain("status = 'active'");
    });

    it('applies minScore filtering in JS', async () => {
        const hits = await searchKbChunks({ tenantId: 't1', query: 'q', minScore: 0.5 });
        expect(hits.map((h) => h.vectorKey)).toEqual(['k1']);
    });
});
