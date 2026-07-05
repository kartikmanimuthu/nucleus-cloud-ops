import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn().mockResolvedValue('tenant-a') }));
vi.mock('next-auth', () => ({ getServerSession: vi.fn().mockResolvedValue({ user: { email: 'u@e.com' } }) }));
vi.mock('@/app/api/auth/[...nextauth]/route', () => ({ authOptions: {} }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('@/lib/knowledge-base/service', () => ({
    KnowledgeBaseService: {
        getKnowledgeBase: vi.fn().mockResolvedValue({ id: 'kb-1' }),
        getDataSource: vi.fn(),
        updateDataSource: vi.fn(),
        updateVectorCount: vi.fn(),
    },
}));
vi.mock('@/lib/knowledge-base/embedder', () => ({
    chunkText: vi.fn(() => [{ text: 'a', index: 0, total: 1, contentHash: 'h' }, { text: 'b', index: 1, total: 2, contentHash: 'h2' }]),
    embedAndStoreChunks: vi.fn().mockResolvedValue(['k1', 'k2']),
    deleteVectors: vi.fn().mockResolvedValue(undefined),
}));

import { KnowledgeBaseService } from '@/lib/knowledge-base/service';
import { deleteVectors, embedAndStoreChunks } from '@/lib/knowledge-base/embedder';
import { PUT } from '@/app/api/knowledge-base/[kbId]/sources/[dsId]/route';

const params = Promise.resolve({ kbId: 'kb-1', dsId: 'ds-1' });
function req(body: unknown) {
    return new Request('http://t', { method: 'PUT', body: JSON.stringify(body) }) as unknown as import('next/server').NextRequest;
}

describe('PUT sources/[dsId] — document re-embed', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(KnowledgeBaseService.getDataSource)
            .mockResolvedValue({ id: 'ds-1', knowledgeBaseId: 'kb-1', name: 'Doc', sourceType: 'document', status: 'synced', config: {}, vectorCount: 1, vectorKeys: ['old1'], createdAt: '', updatedAt: '' } as any);
    });

    it('deletes old vectors, re-embeds, and reconciles the KB count by delta', async () => {
        await PUT(req({ content: '# New body' }), { params });
        expect(deleteVectors).toHaveBeenCalledWith(['old1']);
        expect(embedAndStoreChunks).toHaveBeenCalledWith(expect.objectContaining({ sourceType: 'document', dataSourceId: 'ds-1' }));
        expect(KnowledgeBaseService.updateDataSource).toHaveBeenCalledWith(
            'kb-1', 'ds-1',
            expect.objectContaining({ content: '# New body', vectorKeys: ['k1', 'k2'], vectorCount: 2, status: 'synced' }),
            'tenant-a',
        );
        // old count 1 → new count 2, delta +1
        expect(KnowledgeBaseService.updateVectorCount).toHaveBeenCalledWith('kb-1', 1, 'tenant-a');
    });

    it('does not re-embed when content is absent (name-only edit)', async () => {
        await PUT(req({ name: 'Renamed' }), { params });
        expect(deleteVectors).not.toHaveBeenCalled();
        expect(embedAndStoreChunks).not.toHaveBeenCalled();
    });

    it('leaves old vectors intact and does not touch vector count when embedding fails (embed-before-delete)', async () => {
        vi.mocked(embedAndStoreChunks).mockRejectedValueOnce(new Error('provider blip'));

        const res = await PUT(req({ content: '# New body' }), { params });

        expect(deleteVectors).not.toHaveBeenCalled();
        expect(KnowledgeBaseService.updateDataSource).toHaveBeenCalledWith(
            'kb-1', 'ds-1',
            expect.objectContaining({ content: '# New body', status: 'error' }),
            'tenant-a',
        );
        expect(KnowledgeBaseService.updateVectorCount).not.toHaveBeenCalled();
        expect(res.status).toBe(500);
    });
});
