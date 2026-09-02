import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next-auth', () => ({ getServerSession: vi.fn() }));
vi.mock('@/app/api/auth/[...nextauth]/route', () => ({ authOptions: {} }));
vi.mock('@/lib/knowledge-base/service', () => ({
    KnowledgeBaseService: { getKnowledgeBase: vi.fn(), getDataSource: vi.fn(), updateDataSource: vi.fn() },
}));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('@/lib/boss-client', () => ({ getBoss: vi.fn() }));

import { getServerSession } from 'next-auth';
import { KnowledgeBaseService } from '@/lib/knowledge-base/service';
import { getSessionTenantId } from '@/lib/auth-session';
import { getBoss } from '@/lib/boss-client';
import { POST } from './route';

const makeParams = (kbId: string, dsId: string) => ({ params: Promise.resolve({ kbId, dsId }) });

describe('POST /api/knowledge-base/[kbId]/sources/[dsId]/sync', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getServerSession).mockResolvedValue({ user: { email: 'a@b.co' } } as any);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(KnowledgeBaseService.getKnowledgeBase).mockResolvedValue({ id: 'kb-1' } as any);
        vi.mocked(getBoss).mockResolvedValue({ send: vi.fn().mockResolvedValue('job-1') } as any);
    });

    it('returns 401 when unauthenticated', async () => {
        vi.mocked(getServerSession).mockResolvedValue(null as any);
        const res = await POST({} as any, makeParams('kb-1', 'ds-1'));
        expect(res.status).toBe(401);
    });

    it('returns 403 when the caller does not own the knowledge base', async () => {
        vi.mocked(KnowledgeBaseService.getKnowledgeBase).mockResolvedValue(null);
        const res = await POST({} as any, makeParams('kb-other', 'ds-1'));
        expect(res.status).toBe(403);
    });

    it('returns 404 when the data source does not exist', async () => {
        vi.mocked(KnowledgeBaseService.getDataSource).mockResolvedValue(null);
        const res = await POST({} as any, makeParams('kb-1', 'ds-missing'));
        expect(res.status).toBe(404);
    });

    it('returns 400 for a file-upload source (no re-sync supported)', async () => {
        vi.mocked(KnowledgeBaseService.getDataSource).mockResolvedValue({ id: 'ds-1', sourceType: 'file-upload' } as any);
        const res = await POST({} as any, makeParams('kb-1', 'ds-1'));
        expect(res.status).toBe(400);
    });

    it('returns 400 for an unrecognized source type', async () => {
        vi.mocked(KnowledgeBaseService.getDataSource).mockResolvedValue({ id: 'ds-1', sourceType: 'bogus' } as any);
        const res = await POST({} as any, makeParams('kb-1', 'ds-1'));
        expect(res.status).toBe(400);
    });

    it('marks syncing, enqueues the correct job type, and returns 202', async () => {
        vi.mocked(KnowledgeBaseService.getDataSource).mockResolvedValue({ id: 'ds-1', sourceType: 'confluence', name: 'Docs' } as any);
        const send = vi.fn().mockResolvedValue('job-1');
        vi.mocked(getBoss).mockResolvedValue({ send } as any);

        const res = await POST({} as any, makeParams('kb-1', 'ds-1'));
        const body = await res.json();

        expect(res.status).toBe(202);
        expect(body).toEqual({ success: true, status: 'syncing' });
        expect(KnowledgeBaseService.updateDataSource).toHaveBeenCalledWith('kb-1', 'ds-1', { status: 'syncing' }, 'tenant-1');
        expect(send).toHaveBeenCalledWith('kb-sync', expect.objectContaining({ type: 'confluence-sync', kbId: 'kb-1', dsId: 'ds-1' }));
    });
});
