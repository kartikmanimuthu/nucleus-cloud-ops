import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn(), getSessionUserId: vi.fn() }));
vi.mock('@/lib/store/kb-chat-store', () => ({ kbChatStore: { getSession: vi.fn(), deleteSession: vi.fn() } }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) } }));

import { getSessionTenantId, getSessionUserId } from '@/lib/auth-session';
import { kbChatStore } from '@/lib/store/kb-chat-store';
import { AuditService } from '@/lib/audit-service';
import { DELETE } from './route';

const makeParams = (sessionId: string) => ({ params: Promise.resolve({ sessionId }) });

describe('DELETE /api/knowledge-base/sessions/[sessionId]', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(getSessionUserId).mockResolvedValue('u1');
    });

    it('returns 401 when unauthenticated', async () => {
        vi.mocked(getSessionTenantId).mockRejectedValue(new Error('Unauthenticated'));
        const res = await DELETE({} as any, makeParams('sess-1'));
        expect(res.status).toBe(401);
    });

    it('returns 404 when the session does not exist for this tenant', async () => {
        vi.mocked(kbChatStore.getSession).mockResolvedValue(null);
        const res = await DELETE({} as any, makeParams('sess-missing'));
        expect(res.status).toBe(404);
    });

    it('returns 404 when deleteSession reports it could not find the row', async () => {
        vi.mocked(kbChatStore.getSession).mockResolvedValue({ id: 'sess-1', title: 'x' } as any);
        vi.mocked(kbChatStore.deleteSession).mockResolvedValue(false);

        const res = await DELETE({} as any, makeParams('sess-1'));
        expect(res.status).toBe(404);
    });

    it('deletes the session and logs an audit event', async () => {
        vi.mocked(kbChatStore.getSession).mockResolvedValue({ id: 'sess-1', title: 'My chat' } as any);
        vi.mocked(kbChatStore.deleteSession).mockResolvedValue(true);

        const res = await DELETE({} as any, makeParams('sess-1'));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body).toEqual({ success: true });
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'kb.chat.session.deleted', status: 'success' })
        );
    });

    it('returns 500 when the store throws', async () => {
        vi.mocked(kbChatStore.getSession).mockRejectedValue(new Error('DB down'));
        const res = await DELETE({} as any, makeParams('sess-1'));
        expect(res.status).toBe(500);
    });
});
