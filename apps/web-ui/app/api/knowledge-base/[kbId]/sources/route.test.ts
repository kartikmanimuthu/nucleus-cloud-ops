import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next-auth', () => ({ getServerSession: vi.fn() }));
vi.mock('@/app/api/auth/[...nextauth]/route', () => ({ authOptions: {} }));
vi.mock('@/lib/knowledge-base/service', () => ({
    KnowledgeBaseService: {
        getKnowledgeBase: vi.fn(), listDataSources: vi.fn(), createDataSource: vi.fn(), updateDataSourceCount: vi.fn(),
    },
}));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) } }));

import { getServerSession } from 'next-auth';
import { KnowledgeBaseService } from '@/lib/knowledge-base/service';
import { getSessionTenantId } from '@/lib/auth-session';
import { AuditService } from '@/lib/audit-service';
import { GET, POST } from './route';

const makeParams = (kbId: string) => ({ params: Promise.resolve({ kbId }) });
const makeRequest = (body: unknown) => ({ json: vi.fn().mockResolvedValue(body) }) as any;

describe('GET /api/knowledge-base/[kbId]/sources', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getServerSession).mockResolvedValue({ user: { email: 'a@b.co' } } as any);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(KnowledgeBaseService.getKnowledgeBase).mockResolvedValue({ id: 'kb-1' } as any);
    });

    it('returns 401 when unauthenticated', async () => {
        vi.mocked(getServerSession).mockResolvedValue(null as any);
        const res = await GET({} as any, makeParams('kb-1'));
        expect(res.status).toBe(401);
    });

    it('returns 403 when the caller does not own the knowledge base', async () => {
        vi.mocked(KnowledgeBaseService.getKnowledgeBase).mockResolvedValue(null);
        const res = await GET({} as any, makeParams('kb-other'));
        expect(res.status).toBe(403);
    });

    it('returns masked data sources', async () => {
        vi.mocked(KnowledgeBaseService.listDataSources).mockResolvedValue([
            { id: 'ds-1', sourceType: 's3-bucket', config: {} } as any,
        ]);

        const res = await GET({} as any, makeParams('kb-1'));
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(body.dataSources).toHaveLength(1);
    });

    it('masks the bitbucket apiToken', async () => {
        vi.mocked(KnowledgeBaseService.listDataSources).mockResolvedValue([
            { id: 'ds-1', sourceType: 'bitbucket', config: { apiToken: 'super-secret' } } as any,
        ]);

        const res = await GET({} as any, makeParams('kb-1'));
        const body = await res.json();
        expect(body.dataSources[0].config.apiToken).toBe('***');
    });

    it('returns 500 when the service throws', async () => {
        vi.mocked(KnowledgeBaseService.getKnowledgeBase).mockRejectedValue(new Error('DB down'));
        const res = await GET({} as any, makeParams('kb-1'));
        expect(res.status).toBe(500);
    });
});

describe('POST /api/knowledge-base/[kbId]/sources', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getServerSession).mockResolvedValue({ user: { email: 'a@b.co' } } as any);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(KnowledgeBaseService.getKnowledgeBase).mockResolvedValue({ id: 'kb-1' } as any);
    });

    it('returns 401 when unauthenticated', async () => {
        vi.mocked(getServerSession).mockResolvedValue(null as any);
        const res = await POST(makeRequest({ name: 'Docs', sourceType: 's3-bucket' }), makeParams('kb-1'));
        expect(res.status).toBe(401);
    });

    it('returns 400 when name is missing', async () => {
        const res = await POST(makeRequest({ sourceType: 's3-bucket' }), makeParams('kb-1'));
        expect(res.status).toBe(400);
    });

    it('returns 400 when sourceType is missing', async () => {
        const res = await POST(makeRequest({ name: 'Docs' }), makeParams('kb-1'));
        expect(res.status).toBe(400);
    });

    it('returns 403 when the caller does not own the knowledge base', async () => {
        vi.mocked(KnowledgeBaseService.getKnowledgeBase).mockResolvedValue(null);
        const res = await POST(makeRequest({ name: 'Docs', sourceType: 's3-bucket' }), makeParams('kb-other'));
        expect(res.status).toBe(403);
    });

    it('creates the data source, bumps the count, and logs an audit event', async () => {
        vi.mocked(KnowledgeBaseService.createDataSource).mockResolvedValue({ id: 'ds-1', name: 'Docs', sourceType: 's3-bucket' } as any);

        const res = await POST(makeRequest({ name: '  Docs  ', sourceType: 's3-bucket', config: {} }), makeParams('kb-1'));
        const body = await res.json();

        expect(res.status).toBe(201);
        expect(body.dataSource.name).toBe('Docs');
        expect(KnowledgeBaseService.createDataSource).toHaveBeenCalledWith(
            'kb-1', { name: 'Docs', sourceType: 's3-bucket', config: {} }, 'tenant-1'
        );
        expect(KnowledgeBaseService.updateDataSourceCount).toHaveBeenCalledWith('kb-1', 1, 'tenant-1');
        expect(AuditService.logUserAction).toHaveBeenCalledWith(expect.objectContaining({ status: 'success' }));
    });

    it('returns 500 and logs a failure audit event when the service throws', async () => {
        vi.mocked(KnowledgeBaseService.createDataSource).mockRejectedValue(new Error('DB down'));

        const res = await POST(makeRequest({ name: 'Docs', sourceType: 's3-bucket' }), makeParams('kb-1'));
        expect(res.status).toBe(500);
        expect(AuditService.logUserAction).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));
    });
});
