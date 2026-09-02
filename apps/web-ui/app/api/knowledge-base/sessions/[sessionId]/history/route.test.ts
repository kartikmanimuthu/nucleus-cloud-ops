import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/store/kb-chat-store', () => ({ kbChatStore: { getSession: vi.fn(), getMessages: vi.fn() } }));

import { getSessionTenantId } from '@/lib/auth-session';
import { kbChatStore } from '@/lib/store/kb-chat-store';
import { GET } from './route';

const makeParams = (sessionId: string) => ({ params: Promise.resolve({ sessionId }) });

describe('GET /api/knowledge-base/sessions/[sessionId]/history', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
    });

    it('returns 401 when unauthenticated', async () => {
        vi.mocked(getSessionTenantId).mockRejectedValue(new Error('Unauthenticated'));
        const res = await GET({} as any, makeParams('sess-1'));
        expect(res.status).toBe(401);
    });

    it('returns 404 when the session does not exist for this tenant', async () => {
        vi.mocked(kbChatStore.getSession).mockResolvedValue(null);
        const res = await GET({} as any, makeParams('sess-missing'));
        expect(res.status).toBe(404);
    });

    it('returns messages, knowledgeBaseId, and title', async () => {
        vi.mocked(kbChatStore.getSession).mockResolvedValue({ id: 'sess-1', knowledgeBaseId: 'kb-1', title: 'Chat' } as any);
        vi.mocked(kbChatStore.getMessages).mockResolvedValue([{ role: 'user', content: 'hi' }] as any);

        const res = await GET({} as any, makeParams('sess-1'));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.data).toEqual({
            messages: [{ role: 'user', content: 'hi' }], knowledgeBaseId: 'kb-1', title: 'Chat',
        });
    });

    it('returns 500 when the store throws', async () => {
        vi.mocked(kbChatStore.getSession).mockRejectedValue(new Error('DB down'));
        const res = await GET({} as any, makeParams('sess-1'));
        expect(res.status).toBe(500);
    });
});
