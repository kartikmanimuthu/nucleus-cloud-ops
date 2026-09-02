import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next-auth', () => ({ getServerSession: vi.fn() }));
vi.mock('@/app/api/auth/[...nextauth]/route', () => ({ authOptions: {} }));
vi.mock('@/lib/knowledge-base/service', () => ({
    KnowledgeBaseService: {
        getKnowledgeBase: vi.fn(), createDataSource: vi.fn(), updateDataSourceCount: vi.fn(),
        updateDataSource: vi.fn(), updateVectorCount: vi.fn(), getDataSource: vi.fn(),
    },
}));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('@/lib/knowledge-base/document-validation', () => ({ validateDocumentInput: vi.fn() }));
vi.mock('@/lib/knowledge-base/embedder', () => ({ chunkText: vi.fn(), embedAndStoreChunks: vi.fn() }));

import { getServerSession } from 'next-auth';
import { KnowledgeBaseService } from '@/lib/knowledge-base/service';
import { getSessionTenantId } from '@/lib/auth-session';
import { AuditService } from '@/lib/audit-service';
import { validateDocumentInput } from '@/lib/knowledge-base/document-validation';
import { chunkText, embedAndStoreChunks } from '@/lib/knowledge-base/embedder';
import { POST } from './route';

const makeParams = (kbId: string) => ({ params: Promise.resolve({ kbId }) });
const makeRequest = (body: unknown) => ({ json: vi.fn().mockResolvedValue(body) }) as any;

describe('POST /api/knowledge-base/[kbId]/documents', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getServerSession).mockResolvedValue({ user: { email: 'a@b.co' } } as any);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(KnowledgeBaseService.getKnowledgeBase).mockResolvedValue({ id: 'kb1' } as any);
        vi.mocked(validateDocumentInput).mockReturnValue({ ok: true, name: 'Doc', content: 'Hello world' } as any);
        vi.mocked(chunkText).mockReturnValue(['Hello world'] as any);
        vi.mocked(KnowledgeBaseService.createDataSource).mockResolvedValue({ id: 'ds1' } as any);
    });

    it('returns 401 when there is no session', async () => {
        vi.mocked(getServerSession).mockResolvedValue(null as any);
        const res = await POST(makeRequest({}), makeParams('kb1'));
        expect(res.status).toBe(401);
    });

    it('returns 403 when the knowledge base does not belong to this tenant', async () => {
        vi.mocked(KnowledgeBaseService.getKnowledgeBase).mockResolvedValue(null);
        const res = await POST(makeRequest({}), makeParams('kb-missing'));
        expect(res.status).toBe(403);
    });

    it('returns 400 when document validation fails', async () => {
        vi.mocked(validateDocumentInput).mockReturnValue({ ok: false, error: 'content is required' } as any);
        const res = await POST(makeRequest({ name: 'Doc' }), makeParams('kb1'));
        const body = await res.json();
        expect(res.status).toBe(400);
        expect(body.error).toBe('content is required');
    });

    it('creates, embeds, and persists the document, then logs an audit event', async () => {
        vi.mocked(embedAndStoreChunks).mockResolvedValue(['vec1', 'vec2']);
        vi.mocked(KnowledgeBaseService.getDataSource).mockResolvedValue({ id: 'ds1', status: 'synced' } as any);

        const res = await POST(makeRequest({ name: 'Doc', content: 'Hello world' }), makeParams('kb1'));
        const body = await res.json();

        expect(KnowledgeBaseService.updateDataSourceCount).toHaveBeenCalledWith('kb1', 1, 'tenant-1');
        expect(KnowledgeBaseService.updateDataSource).toHaveBeenCalledWith('kb1', 'ds1', expect.objectContaining({
            status: 'synced', vectorKeys: ['vec1', 'vec2'], vectorCount: 2,
        }), 'tenant-1');
        expect(KnowledgeBaseService.updateVectorCount).toHaveBeenCalledWith('kb1', 2, 'tenant-1');
        expect(res.status).toBe(201);
        expect(body.dataSource).toEqual({ id: 'ds1', status: 'synced' });
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'kb.document.created', status: 'success' })
        );
    });

    it('returns 400 and marks the data source errored when embedding fails with a provider config error', async () => {
        const err = new Error('No provider configured');
        err.name = 'ProviderConfigError';
        vi.mocked(embedAndStoreChunks).mockRejectedValue(err);

        const res = await POST(makeRequest({ name: 'Doc', content: 'Hello world' }), makeParams('kb1'));
        const body = await res.json();

        expect(KnowledgeBaseService.updateDataSource).toHaveBeenCalledWith('kb1', 'ds1', expect.objectContaining({
            status: 'error', lastErrorMessage: 'No embedding provider configured',
        }), 'tenant-1');
        expect(res.status).toBe(400);
        expect(body.error).toBe('No provider configured');
    });

    it('returns 500 for a non-provider embedding failure', async () => {
        vi.mocked(embedAndStoreChunks).mockRejectedValue(new Error('Bedrock timeout'));
        const res = await POST(makeRequest({ name: 'Doc', content: 'Hello world' }), makeParams('kb1'));
        expect(res.status).toBe(500);
    });

    it('still returns the embedding error even when the best-effort error-status write itself fails', async () => {
        vi.mocked(embedAndStoreChunks).mockRejectedValue(new Error('Bedrock timeout'));
        vi.mocked(KnowledgeBaseService.updateDataSource).mockRejectedValue(new Error('DB down'));

        const res = await POST(makeRequest({ name: 'Doc', content: 'Hello world' }), makeParams('kb1'));
        const body = await res.json();
        expect(res.status).toBe(500);
        expect(body.error).toBe('Bedrock timeout');
    });
});
