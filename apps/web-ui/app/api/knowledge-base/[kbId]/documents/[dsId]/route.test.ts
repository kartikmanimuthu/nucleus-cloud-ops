import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next-auth', () => ({ getServerSession: vi.fn() }));
vi.mock('@/app/api/auth/[...nextauth]/route', () => ({ authOptions: {} }));
vi.mock('@/lib/knowledge-base/service', () => ({
    KnowledgeBaseService: { getKnowledgeBase: vi.fn(), getDataSource: vi.fn(), getDataSourceContent: vi.fn() },
}));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));

import { getServerSession } from 'next-auth';
import { KnowledgeBaseService } from '@/lib/knowledge-base/service';
import { getSessionTenantId } from '@/lib/auth-session';
import { GET } from './route';

const makeParams = (kbId: string, dsId: string) => ({ params: Promise.resolve({ kbId, dsId }) });

describe('GET /api/knowledge-base/[kbId]/documents/[dsId]', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getServerSession).mockResolvedValue({ user: { email: 'a@b.co' } } as any);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(KnowledgeBaseService.getKnowledgeBase).mockResolvedValue({ id: 'kb-1' } as any);
    });

    it('returns 401 when unauthenticated', async () => {
        vi.mocked(getServerSession).mockResolvedValue(null as any);
        const res = await GET({} as any, makeParams('kb-1', 'ds-1'));
        expect(res.status).toBe(401);
    });

    it('returns 403 when the caller does not own the knowledge base', async () => {
        vi.mocked(KnowledgeBaseService.getKnowledgeBase).mockResolvedValue(null);
        const res = await GET({} as any, makeParams('kb-other', 'ds-1'));
        expect(res.status).toBe(403);
    });

    it('returns 404 when the data source is not a document type', async () => {
        vi.mocked(KnowledgeBaseService.getDataSource).mockResolvedValue({ id: 'ds-1', sourceType: 'file-upload' } as any);
        const res = await GET({} as any, makeParams('kb-1', 'ds-1'));
        expect(res.status).toBe(404);
    });

    it('returns 404 when the data source does not exist', async () => {
        vi.mocked(KnowledgeBaseService.getDataSource).mockResolvedValue(null);
        const res = await GET({} as any, makeParams('kb-1', 'ds-missing'));
        expect(res.status).toBe(404);
    });

    it('returns the document content', async () => {
        vi.mocked(KnowledgeBaseService.getDataSource).mockResolvedValue({ id: 'ds-1', name: 'Runbook', sourceType: 'document' } as any);
        vi.mocked(KnowledgeBaseService.getDataSourceContent).mockResolvedValue('# Runbook\ncontent');

        const res = await GET({} as any, makeParams('kb-1', 'ds-1'));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body).toEqual({ id: 'ds-1', name: 'Runbook', content: '# Runbook\ncontent' });
    });

    it('defaults content to an empty string when none is stored', async () => {
        vi.mocked(KnowledgeBaseService.getDataSource).mockResolvedValue({ id: 'ds-1', name: 'Runbook', sourceType: 'document' } as any);
        vi.mocked(KnowledgeBaseService.getDataSourceContent).mockResolvedValue(null);

        const res = await GET({} as any, makeParams('kb-1', 'ds-1'));
        const body = await res.json();
        expect(body.content).toBe('');
    });
});
