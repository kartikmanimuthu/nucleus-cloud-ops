import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next-auth', () => ({ getServerSession: vi.fn() }));
vi.mock('@/app/api/auth/[...nextauth]/route', () => ({ authOptions: {} }));
vi.mock('@/lib/knowledge-base/service', () => ({
    KnowledgeBaseService: {
        getKnowledgeBase: vi.fn(), getDataSource: vi.fn(), updateDataSource: vi.fn(), updateVectorCount: vi.fn(),
        deleteDataSource: vi.fn(), updateDataSourceCount: vi.fn(),
    },
}));
vi.mock('@/lib/knowledge-base/embedder', () => ({ chunkText: vi.fn(), embedAndStoreChunks: vi.fn(), deleteVectors: vi.fn() }));
vi.mock('@/lib/knowledge-base/document-validation', () => ({ validateDocumentInput: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) } }));

import { getServerSession } from 'next-auth';
import { KnowledgeBaseService } from '@/lib/knowledge-base/service';
import { chunkText, embedAndStoreChunks, deleteVectors } from '@/lib/knowledge-base/embedder';
import { validateDocumentInput } from '@/lib/knowledge-base/document-validation';
import { getSessionTenantId } from '@/lib/auth-session';
import { AuditService } from '@/lib/audit-service';
import { GET, PUT, DELETE } from './route';

const makeParams = (kbId: string, dsId: string) => ({ params: Promise.resolve({ kbId, dsId }) });
const makeRequest = (body: unknown) => ({ json: vi.fn().mockResolvedValue(body) }) as any;

describe('GET /api/knowledge-base/[kbId]/sources/[dsId]', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getServerSession).mockResolvedValue({ user: { email: 'a@b.co' } } as any);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(KnowledgeBaseService.getKnowledgeBase).mockResolvedValue({ id: 'kb1' } as any);
    });

    it('returns 401 when there is no session', async () => {
        vi.mocked(getServerSession).mockResolvedValue(null as any);
        const res = await GET({} as any, makeParams('kb1', 'ds1'));
        expect(res.status).toBe(401);
    });

    it('returns 403 when the knowledge base does not belong to this tenant', async () => {
        vi.mocked(KnowledgeBaseService.getKnowledgeBase).mockResolvedValue(null);
        const res = await GET({} as any, makeParams('kb-missing', 'ds1'));
        expect(res.status).toBe(403);
    });

    it('returns 404 when the data source does not exist', async () => {
        vi.mocked(KnowledgeBaseService.getDataSource).mockResolvedValue(null);
        const res = await GET({} as any, makeParams('kb1', 'ds-missing'));
        expect(res.status).toBe(404);
    });

    it('redacts the apiToken for a bitbucket data source', async () => {
        vi.mocked(KnowledgeBaseService.getDataSource).mockResolvedValue({
            id: 'ds1', sourceType: 'bitbucket', config: { apiToken: 'secret-token', repo: 'x' },
        } as any);

        const res = await GET({} as any, makeParams('kb1', 'ds1'));
        const body = await res.json();
        expect(body.dataSource.config.apiToken).toBe('***');
        expect(body.dataSource.config.repo).toBe('x');
    });

    it('returns the data source unmodified for a non-bitbucket source', async () => {
        vi.mocked(KnowledgeBaseService.getDataSource).mockResolvedValue({ id: 'ds1', sourceType: 'document' } as any);
        const res = await GET({} as any, makeParams('kb1', 'ds1'));
        const body = await res.json();
        expect(body.dataSource).toEqual({ id: 'ds1', sourceType: 'document' });
    });
});

describe('PUT /api/knowledge-base/[kbId]/sources/[dsId]', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getServerSession).mockResolvedValue({ user: { email: 'a@b.co' } } as any);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(KnowledgeBaseService.getKnowledgeBase).mockResolvedValue({ id: 'kb1' } as any);
    });

    it('returns 401 when there is no session', async () => {
        vi.mocked(getServerSession).mockResolvedValue(null as any);
        const res = await PUT(makeRequest({}), makeParams('kb1', 'ds1'));
        expect(res.status).toBe(401);
    });

    it('returns 403 when the knowledge base does not belong to this tenant', async () => {
        vi.mocked(KnowledgeBaseService.getKnowledgeBase).mockResolvedValue(null);
        const res = await PUT(makeRequest({}), makeParams('kb-missing', 'ds1'));
        expect(res.status).toBe(403);
    });

    it('returns 404 when the data source does not exist', async () => {
        vi.mocked(KnowledgeBaseService.getDataSource).mockResolvedValue(null);
        const res = await PUT(makeRequest({}), makeParams('kb1', 'ds-missing'));
        expect(res.status).toBe(404);
    });

    it('re-embeds a document data source on content edit, dropping stale vector keys', async () => {
        vi.mocked(KnowledgeBaseService.getDataSource)
            .mockResolvedValueOnce({ id: 'ds1', sourceType: 'document', name: 'Doc', vectorKeys: ['old1', 'old2'], vectorCount: 2 } as any)
            .mockResolvedValueOnce({ id: 'ds1', name: 'Doc', status: 'synced' } as any);
        vi.mocked(validateDocumentInput).mockReturnValue({ ok: true, name: 'Doc', content: 'New content' } as any);
        vi.mocked(chunkText).mockReturnValue(['New content'] as any);
        vi.mocked(embedAndStoreChunks).mockResolvedValue(['old1', 'new1']);

        const res = await PUT(makeRequest({ content: 'New content' }), makeParams('kb1', 'ds1'));
        const body = await res.json();

        expect(deleteVectors).toHaveBeenCalledWith(['old2']);
        expect(KnowledgeBaseService.updateDataSource).toHaveBeenCalledWith('kb1', 'ds1', expect.objectContaining({
            vectorKeys: ['old1', 'new1'], vectorCount: 2, status: 'synced',
        }), 'tenant-1');
        expect(KnowledgeBaseService.updateVectorCount).toHaveBeenCalledWith('kb1', 0, 'tenant-1');
        expect(res.status).toBe(200);
        expect(body.dataSource.status).toBe('synced');
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'kb.datasource.updated', status: 'success' })
        );
    });

    it('returns 400 when the content edit fails document validation', async () => {
        vi.mocked(KnowledgeBaseService.getDataSource).mockResolvedValue({
            id: 'ds1', sourceType: 'document', name: 'Doc', vectorKeys: [], vectorCount: 0,
        } as any);
        vi.mocked(validateDocumentInput).mockReturnValue({ ok: false, error: 'content too short' } as any);

        const res = await PUT(makeRequest({ content: 'x' }), makeParams('kb1', 'ds1'));
        const body = await res.json();
        expect(res.status).toBe(400);
        expect(body.error).toBe('content too short');
    });

    it('returns 400 and marks the source errored on a provider config error during re-embed', async () => {
        vi.mocked(KnowledgeBaseService.getDataSource).mockResolvedValue({
            id: 'ds1', sourceType: 'document', name: 'Doc', vectorKeys: [], vectorCount: 0,
        } as any);
        vi.mocked(validateDocumentInput).mockReturnValue({ ok: true, name: 'Doc', content: 'New content' } as any);
        const err = new Error('No provider configured');
        err.name = 'ProviderConfigError';
        vi.mocked(embedAndStoreChunks).mockRejectedValue(err);

        const res = await PUT(makeRequest({ content: 'New content' }), makeParams('kb1', 'ds1'));
        const body = await res.json();
        expect(res.status).toBe(400);
        expect(body.error).toBe('No provider configured');
    });

    it('merges config updates for a non-document (or non-content-edit) source', async () => {
        vi.mocked(KnowledgeBaseService.getDataSource)
            .mockResolvedValueOnce({ id: 'ds1', sourceType: 's3', name: 'Bucket', config: { bucket: 'b1', prefix: 'p1' } } as any)
            .mockResolvedValueOnce({ id: 'ds1', name: 'Bucket', config: { bucket: 'b1', prefix: 'p2' } } as any);

        await PUT(makeRequest({ config: { prefix: 'p2' } }), makeParams('kb1', 'ds1'));
        expect(KnowledgeBaseService.updateDataSource).toHaveBeenCalledWith(
            'kb1', 'ds1', { config: { bucket: 'b1', prefix: 'p2' } }, 'tenant-1',
        );
    });
});

describe('DELETE /api/knowledge-base/[kbId]/sources/[dsId]', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getServerSession).mockResolvedValue({ user: { email: 'a@b.co' } } as any);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(KnowledgeBaseService.getKnowledgeBase).mockResolvedValue({ id: 'kb1' } as any);
    });

    it('returns 401 when there is no session', async () => {
        vi.mocked(getServerSession).mockResolvedValue(null as any);
        const res = await DELETE({} as any, makeParams('kb1', 'ds1'));
        expect(res.status).toBe(401);
    });

    it('returns 403 when the knowledge base does not belong to this tenant', async () => {
        vi.mocked(KnowledgeBaseService.getKnowledgeBase).mockResolvedValue(null);
        const res = await DELETE({} as any, makeParams('kb-missing', 'ds1'));
        expect(res.status).toBe(403);
    });

    it('returns 404 when the data source does not exist', async () => {
        vi.mocked(KnowledgeBaseService.getDataSource).mockResolvedValue(null);
        const res = await DELETE({} as any, makeParams('kb1', 'ds-missing'));
        expect(res.status).toBe(404);
    });

    it('deletes vectors and the data source, decrements counts, and logs a high-severity audit event', async () => {
        vi.mocked(KnowledgeBaseService.getDataSource).mockResolvedValue({
            id: 'ds1', name: 'Doc', vectorKeys: ['v1', 'v2'], vectorCount: 2,
        } as any);

        const res = await DELETE({} as any, makeParams('kb1', 'ds1'));
        const body = await res.json();

        expect(deleteVectors).toHaveBeenCalledWith(['v1', 'v2']);
        expect(KnowledgeBaseService.deleteDataSource).toHaveBeenCalledWith('kb1', 'ds1', 'tenant-1');
        expect(KnowledgeBaseService.updateDataSourceCount).toHaveBeenCalledWith('kb1', -1, 'tenant-1');
        expect(KnowledgeBaseService.updateVectorCount).toHaveBeenCalledWith('kb1', -2, 'tenant-1');
        expect(res.status).toBe(200);
        expect(body).toEqual({ success: true });
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'kb.datasource.deleted', severity: 'high', status: 'success' })
        );
    });

    it('skips vector deletion when the data source has no vector keys', async () => {
        vi.mocked(KnowledgeBaseService.getDataSource).mockResolvedValue({
            id: 'ds1', name: 'Doc', vectorKeys: [], vectorCount: 0,
        } as any);

        await DELETE({} as any, makeParams('kb1', 'ds1'));
        expect(deleteVectors).not.toHaveBeenCalled();
    });
});
