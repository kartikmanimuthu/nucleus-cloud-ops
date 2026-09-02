import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next-auth', () => ({ getServerSession: vi.fn() }));
vi.mock('@/app/api/auth/[...nextauth]/route', () => ({ authOptions: {} }));
vi.mock('@/lib/knowledge-base/service', () => ({
    KnowledgeBaseService: {
        getKnowledgeBase: vi.fn(), listDataSources: vi.fn(), setKnowledgeBaseStatus: vi.fn(),
        updateKnowledgeBase: vi.fn(), deleteDataSource: vi.fn(), deleteKnowledgeBase: vi.fn(),
    },
}));
vi.mock('@/lib/knowledge-base/embedder', () => ({ deleteVectors: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) } }));

import { getServerSession } from 'next-auth';
import { KnowledgeBaseService } from '@/lib/knowledge-base/service';
import { deleteVectors } from '@/lib/knowledge-base/embedder';
import { getSessionTenantId } from '@/lib/auth-session';
import { AuditService } from '@/lib/audit-service';
import { GET, PUT, DELETE } from './route';

const makeParams = (kbId: string) => ({ params: Promise.resolve({ kbId }) });
const makeRequest = (body: unknown) => ({ json: vi.fn().mockResolvedValue(body) }) as any;

describe('GET /api/knowledge-base/[kbId]', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getServerSession).mockResolvedValue({ user: { email: 'a@b.co' } } as any);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
    });

    it('returns 401 when unauthenticated', async () => {
        vi.mocked(getServerSession).mockResolvedValue(null as any);
        const res = await GET({} as any, makeParams('kb-1'));
        expect(res.status).toBe(401);
    });

    it('returns 404 when the knowledge base does not exist', async () => {
        vi.mocked(KnowledgeBaseService.getKnowledgeBase).mockResolvedValue(null);
        vi.mocked(KnowledgeBaseService.listDataSources).mockResolvedValue([]);

        const res = await GET({} as any, makeParams('kb-missing'));
        expect(res.status).toBe(404);
    });

    it('masks the bitbucket apiToken in returned data sources', async () => {
        vi.mocked(KnowledgeBaseService.getKnowledgeBase).mockResolvedValue({ id: 'kb-1', name: 'KB' } as any);
        vi.mocked(KnowledgeBaseService.listDataSources).mockResolvedValue([
            { id: 'ds-1', sourceType: 'bitbucket', config: { apiToken: 'super-secret' } } as any,
        ]);

        const res = await GET({} as any, makeParams('kb-1'));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.dataSources[0].config.apiToken).toBe('***');
    });

    it('leaves a non-bitbucket data source unchanged', async () => {
        vi.mocked(KnowledgeBaseService.getKnowledgeBase).mockResolvedValue({ id: 'kb-1', name: 'KB' } as any);
        vi.mocked(KnowledgeBaseService.listDataSources).mockResolvedValue([
            { id: 'ds-1', sourceType: 's3-bucket', config: { bucket: 'my-bucket' } } as any,
        ]);

        const res = await GET({} as any, makeParams('kb-1'));
        const body = await res.json();
        expect(body.dataSources[0].config).toEqual({ bucket: 'my-bucket' });
    });

    it('returns 500 when the service throws', async () => {
        vi.mocked(KnowledgeBaseService.getKnowledgeBase).mockRejectedValue(new Error('DB down'));
        const res = await GET({} as any, makeParams('kb-1'));
        expect(res.status).toBe(500);
    });

    it('falls back to a generic message when the service throws a non-Error value', async () => {
        vi.mocked(KnowledgeBaseService.getKnowledgeBase).mockRejectedValue('plain string failure');
        const res = await GET({} as any, makeParams('kb-1'));
        const body = await res.json();
        expect(res.status).toBe(500);
        expect(body.error).toBe('Failed to get knowledge base');
    });
});

describe('PUT /api/knowledge-base/[kbId]', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getServerSession).mockResolvedValue({ user: { email: 'a@b.co' } } as any);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(KnowledgeBaseService.getKnowledgeBase).mockResolvedValue({ id: 'kb-1', name: 'KB' } as any);
        // clearAllMocks() clears call history but not a prior mockRejectedValue — re-stub the
        // success path every test so an earlier failure test can't poison a later one.
        vi.mocked(KnowledgeBaseService.setKnowledgeBaseStatus).mockResolvedValue(undefined as any);
        vi.mocked(KnowledgeBaseService.updateKnowledgeBase).mockResolvedValue(undefined as any);
        vi.mocked(AuditService.logUserAction).mockResolvedValue(undefined as any);
    });

    it('returns 401 when unauthenticated', async () => {
        vi.mocked(getServerSession).mockResolvedValue(null as any);
        const res = await PUT(makeRequest({ name: 'x' }), makeParams('kb-1'));
        expect(res.status).toBe(401);
    });

    it('returns 403 when the caller does not own the knowledge base', async () => {
        vi.mocked(KnowledgeBaseService.getKnowledgeBase).mockResolvedValue(null);
        const res = await PUT(makeRequest({ name: 'x' }), makeParams('kb-other'));
        expect(res.status).toBe(403);
    });

    it('returns 400 for an invalid status value', async () => {
        const res = await PUT(makeRequest({ status: 'bogus' }), makeParams('kb-1'));
        expect(res.status).toBe(400);
    });

    it('updates status and logs an audit event', async () => {
        const res = await PUT(makeRequest({ status: 'inactive' }), makeParams('kb-1'));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body).toEqual({ success: true });
        expect(KnowledgeBaseService.setKnowledgeBaseStatus).toHaveBeenCalledWith('kb-1', 'tenant-1', 'inactive');
        expect(AuditService.logUserAction).toHaveBeenCalledWith(expect.objectContaining({ status: 'success' }));
    });

    it('updates name/description when provided', async () => {
        await PUT(makeRequest({ name: 'New Name' }), makeParams('kb-1'));
        expect(KnowledgeBaseService.updateKnowledgeBase).toHaveBeenCalledWith(
            'kb-1', { name: 'New Name', description: undefined }, 'tenant-1'
        );
    });

    it('returns 500 when the service throws', async () => {
        vi.mocked(KnowledgeBaseService.updateKnowledgeBase).mockRejectedValueOnce(new Error('DB down'));
        const res = await PUT(makeRequest({ name: 'x' }), makeParams('kb-1'));
        expect(res.status).toBe(500);
    });

    it('logs "Activated" for status=active and falls back to the kbId when neither the request nor the existing record has a name', async () => {
        vi.mocked(KnowledgeBaseService.getKnowledgeBase).mockResolvedValue({ id: 'kb-1', name: undefined } as any);
        const res = await PUT(makeRequest({ status: 'active' }), makeParams('kb-1'));
        expect(res.status).toBe(200);
        expect(AuditService.logUserAction).toHaveBeenCalledWith(expect.objectContaining({
            action: 'Activated Knowledge Base',
            resourceName: 'kb-1',
            details: 'Set knowledge base "kb-1" status to active',
        }));
    });

    it('falls back to a generic message and "unknown" resource fields when the service throws a non-Error value', async () => {
        vi.mocked(KnowledgeBaseService.updateKnowledgeBase).mockRejectedValueOnce('plain string failure');
        const res = await PUT(makeRequest({ name: 'x' }), makeParams('kb-1'));
        const body = await res.json();
        expect(res.status).toBe(500);
        expect(body.error).toBe('Failed to update knowledge base');
        expect(AuditService.logUserAction).toHaveBeenCalledWith(expect.objectContaining({
            status: 'error', details: 'Failed to update knowledge base: Unknown error',
        }));
    });

    it('does not throw when the success-path audit log write fails', async () => {
        vi.mocked(AuditService.logUserAction).mockRejectedValueOnce(new Error('audit sink down'));
        const res = await PUT(makeRequest({ name: 'x' }), makeParams('kb-1'));
        expect(res.status).toBe(200);
    });

    it('does not throw when the error-path audit log write itself fails', async () => {
        vi.mocked(KnowledgeBaseService.updateKnowledgeBase).mockRejectedValueOnce(new Error('DB down'));
        vi.mocked(AuditService.logUserAction).mockRejectedValueOnce(new Error('audit sink down'));
        const res = await PUT(makeRequest({ name: 'x' }), makeParams('kb-1'));
        expect(res.status).toBe(500);
    });
});

describe('DELETE /api/knowledge-base/[kbId]', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getServerSession).mockResolvedValue({ user: { email: 'a@b.co' } } as any);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(KnowledgeBaseService.getKnowledgeBase).mockResolvedValue({ id: 'kb-1', name: 'KB' } as any);
        vi.mocked(KnowledgeBaseService.listDataSources).mockResolvedValue([]);
        // clearAllMocks() clears call history but not a prior mockRejectedValue — re-stub the
        // success path every test so an earlier failure test can't poison a later one.
        vi.mocked(KnowledgeBaseService.deleteDataSource).mockResolvedValue(undefined as any);
        vi.mocked(KnowledgeBaseService.deleteKnowledgeBase).mockResolvedValue(undefined as any);
        vi.mocked(AuditService.logUserAction).mockResolvedValue(undefined as any);
    });

    it('returns 401 when unauthenticated', async () => {
        vi.mocked(getServerSession).mockResolvedValue(null as any);
        const res = await DELETE({} as any, makeParams('kb-1'));
        expect(res.status).toBe(401);
    });

    it('returns 403 when the caller does not own the knowledge base', async () => {
        vi.mocked(KnowledgeBaseService.getKnowledgeBase).mockResolvedValue(null);
        const res = await DELETE({} as any, makeParams('kb-other'));
        expect(res.status).toBe(403);
    });

    it('cascade-deletes vectors and data sources before deleting the KB', async () => {
        vi.mocked(KnowledgeBaseService.listDataSources).mockResolvedValue([
            { id: 'ds-1', vectorKeys: ['v1', 'v2'] } as any,
        ]);

        const res = await DELETE({} as any, makeParams('kb-1'));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body).toEqual({ success: true });
        expect(deleteVectors).toHaveBeenCalledWith(['v1', 'v2']);
        expect(KnowledgeBaseService.deleteDataSource).toHaveBeenCalledWith('kb-1', 'ds-1', 'tenant-1');
        expect(KnowledgeBaseService.deleteKnowledgeBase).toHaveBeenCalledWith('kb-1', 'tenant-1');
    });

    it('returns 500 when the service throws', async () => {
        vi.mocked(KnowledgeBaseService.deleteKnowledgeBase).mockRejectedValueOnce(new Error('DB down'));
        const res = await DELETE({} as any, makeParams('kb-1'));
        expect(res.status).toBe(500);
    });

    it('skips deleteVectors for a data source with no vector keys', async () => {
        vi.mocked(KnowledgeBaseService.listDataSources).mockResolvedValue([{ id: 'ds-1', vectorKeys: [] } as any]);
        const res = await DELETE({} as any, makeParams('kb-1'));
        expect(res.status).toBe(200);
        expect(deleteVectors).not.toHaveBeenCalled();
        expect(KnowledgeBaseService.deleteDataSource).toHaveBeenCalledWith('kb-1', 'ds-1', 'tenant-1');
    });

    it('falls back to "unknown" for the audit user and to the kbId for the resource name when the session/name are absent', async () => {
        vi.mocked(getServerSession).mockResolvedValue({ user: {} } as any);
        vi.mocked(KnowledgeBaseService.getKnowledgeBase).mockResolvedValue({ id: 'kb-1', name: undefined } as any);
        const res = await DELETE({} as any, makeParams('kb-1'));
        expect(res.status).toBe(200);
        expect(AuditService.logUserAction).toHaveBeenCalledWith(expect.objectContaining({
            user: 'unknown', resourceName: 'kb-1',
        }));
    });

    it('falls back to a generic message when the service throws a non-Error value, without throwing on the audit write', async () => {
        vi.mocked(KnowledgeBaseService.deleteKnowledgeBase).mockRejectedValueOnce('plain string failure');
        vi.mocked(AuditService.logUserAction).mockRejectedValueOnce(new Error('audit sink down'));
        const res = await DELETE({} as any, makeParams('kb-1'));
        const body = await res.json();
        expect(res.status).toBe(500);
        expect(body.error).toBe('Failed to delete knowledge base');
        expect(AuditService.logUserAction).toHaveBeenCalledWith(expect.objectContaining({
            status: 'error', details: 'Failed to delete knowledge base: Unknown error',
        }));
    });

    it('does not throw when the success-path audit log write fails', async () => {
        vi.mocked(AuditService.logUserAction).mockRejectedValueOnce(new Error('audit sink down'));
        const res = await DELETE({} as any, makeParams('kb-1'));
        expect(res.status).toBe(200);
    });
});
