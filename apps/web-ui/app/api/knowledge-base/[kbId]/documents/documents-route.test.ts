import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth-session', () => ({
    getSessionTenantId: vi.fn().mockResolvedValue('tenant-a'),
    getSessionUserId: vi.fn(),
}));
vi.mock('next-auth', () => ({
    getServerSession: vi.fn().mockResolvedValue({ user: { email: 'test@example.com' } }),
}));
vi.mock('@/app/api/auth/[...nextauth]/route', () => ({ authOptions: {} }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) } }));

vi.mock('@/lib/knowledge-base/service', () => ({
    KnowledgeBaseService: {
        getKnowledgeBase: vi.fn(),
        getDataSource: vi.fn(),
        createDataSource: vi.fn(),
        updateDataSource: vi.fn(),
        updateDataSourceCount: vi.fn(),
        updateVectorCount: vi.fn(),
    },
}));
vi.mock('@/lib/knowledge-base/embedder', () => ({
    chunkText: vi.fn(() => [{ text: 'c1', index: 0, total: 1, contentHash: 'h1' }]),
    embedAndStoreChunks: vi.fn().mockResolvedValue(['kb_kb-1_ds-1_0_h1']),
    deleteVectors: vi.fn().mockResolvedValue(undefined),
}));

import { KnowledgeBaseService } from '@/lib/knowledge-base/service';
import { chunkText, embedAndStoreChunks } from '@/lib/knowledge-base/embedder';
import { POST } from '@/app/api/knowledge-base/[kbId]/documents/route';

const params = Promise.resolve({ kbId: 'kb-1' });

function req(body: unknown) {
    return new Request('http://t/api/knowledge-base/kb-1/documents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }) as unknown as import('next/server').NextRequest;
}

describe('POST /api/knowledge-base/[kbId]/documents', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(KnowledgeBaseService.getKnowledgeBase).mockResolvedValue({ id: 'kb-1' } as any);
        vi.mocked(KnowledgeBaseService.createDataSource).mockResolvedValue({ id: 'ds-1', knowledgeBaseId: 'kb-1', name: 'Doc', sourceType: 'document', status: 'pending', config: {}, vectorCount: 0, vectorKeys: [], createdAt: '', updatedAt: '' } as any);
        vi.mocked(KnowledgeBaseService.getDataSource).mockResolvedValue({ id: 'ds-1', knowledgeBaseId: 'kb-1', name: 'Doc', sourceType: 'document', status: 'synced', config: {}, vectorCount: 1, vectorKeys: ['kb_kb-1_ds-1_0_h1'], createdAt: '', updatedAt: '' } as any);
    });

    it('creates a document, embeds it, and returns 201', async () => {
        const res = await POST(req({ name: 'Doc', content: '# Body' }), { params });
        expect(res.status).toBe(201);
        expect(chunkText).toHaveBeenCalledWith('# Body', 'Doc');
        expect(embedAndStoreChunks).toHaveBeenCalledWith(
            expect.objectContaining({ sourceType: 'document', knowledgeBaseId: 'kb-1', dataSourceId: 'ds-1', tenantId: 'tenant-a' })
        );
        // marks synced with the returned vector keys
        expect(KnowledgeBaseService.updateDataSource).toHaveBeenCalledWith(
            'kb-1', 'ds-1',
            expect.objectContaining({ status: 'synced', vectorKeys: ['kb_kb-1_ds-1_0_h1'], vectorCount: 1, content: '# Body' }),
            'tenant-a',
        );
        expect(KnowledgeBaseService.updateVectorCount).toHaveBeenCalledWith('kb-1', 1, 'tenant-a');
    });

    it('rejects empty content with 400', async () => {
        const res = await POST(req({ name: 'Doc', content: '' }), { params });
        expect(res.status).toBe(400);
        expect(embedAndStoreChunks).not.toHaveBeenCalled();
    });

    it('returns 403 when the KB is not owned by the tenant', async () => {
        vi.mocked(KnowledgeBaseService.getKnowledgeBase).mockResolvedValue(null);
        const res = await POST(req({ name: 'Doc', content: '# Body' }), { params });
        expect(res.status).toBe(403);
    });

    it('sets status=error but preserves content when embedding fails', async () => {
        vi.mocked(embedAndStoreChunks).mockRejectedValueOnce(new Error('bedrock down'));
        const res = await POST(req({ name: 'Doc', content: '# Body' }), { params });
        expect(res.status).toBe(500);
        expect(KnowledgeBaseService.updateDataSource).toHaveBeenCalledWith(
            'kb-1', 'ds-1',
            expect.objectContaining({ status: 'error', content: '# Body' }),
            'tenant-a',
        );
    });
});
