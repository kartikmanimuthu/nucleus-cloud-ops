import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../../lib/deep-agent/db/chat-history-store', () => ({
    getThread: vi.fn(), deleteThread: vi.fn(),
}));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn(), getAuthSession: vi.fn() }));

import { getThread, deleteThread } from '../../../../../lib/deep-agent/db/chat-history-store';
import { AuditService } from '@/lib/audit-service';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import { GET, DELETE } from './route';

const makeParams = (threadId: string) => ({ params: Promise.resolve({ threadId }) });

describe('GET /api/deep-agent/threads/[threadId]', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns 404 when the thread does not exist', async () => {
        vi.mocked(getThread).mockResolvedValue(null);
        const res = await GET({} as any, makeParams('t-missing'));
        expect(res.status).toBe(404);
    });

    it('returns the thread', async () => {
        vi.mocked(getThread).mockResolvedValue({ threadId: 't1' } as any);
        const res = await GET({} as any, makeParams('t1'));
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(body.thread).toEqual({ threadId: 't1' });
    });

    it('returns 500 when the store throws', async () => {
        vi.mocked(getThread).mockRejectedValue(new Error('DB down'));
        const res = await GET({} as any, makeParams('t1'));
        expect(res.status).toBe(500);
    });
});

describe('DELETE /api/deep-agent/threads/[threadId]', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(getAuthSession).mockResolvedValue({ user: { email: 'a@b.co' } } as any);
    });

    it('returns 404 when the thread does not exist', async () => {
        vi.mocked(deleteThread).mockResolvedValue(false);
        const res = await DELETE({} as any, makeParams('t-missing'));
        expect(res.status).toBe(404);
    });

    it('deletes the thread and logs an audit event', async () => {
        vi.mocked(deleteThread).mockResolvedValue(true);
        const res = await DELETE({} as any, makeParams('t1'));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body).toEqual({ success: true });
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'chat.thread.deleted', tenantId: 'tenant-1', user: 'a@b.co' })
        );
    });

    it('still deletes and returns success when audit context resolution fails', async () => {
        vi.mocked(deleteThread).mockResolvedValue(true);
        vi.mocked(getSessionTenantId).mockRejectedValue(new Error('Unauthenticated'));
        const res = await DELETE({} as any, makeParams('t1'));
        expect(res.status).toBe(200);
    });

    it('returns 500 when deletion throws', async () => {
        vi.mocked(deleteThread).mockRejectedValue(new Error('DB down'));
        const res = await DELETE({} as any, makeParams('t1'));
        expect(res.status).toBe(500);
    });
});
