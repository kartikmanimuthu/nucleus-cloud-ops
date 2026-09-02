import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/store/kb-chat-store', () => ({ kbChatStore: { listSessions: vi.fn() } }));

import { getSessionTenantId } from '@/lib/auth-session';
import { kbChatStore } from '@/lib/store/kb-chat-store';
import { GET } from './route';

describe('GET /api/knowledge-base/sessions', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
    });

    it('returns 401 when unauthenticated', async () => {
        vi.mocked(getSessionTenantId).mockRejectedValue(new Error('Unauthenticated'));
        const res = await GET();
        expect(res.status).toBe(401);
    });

    it('returns 200 with the tenant session list', async () => {
        vi.mocked(kbChatStore.listSessions).mockResolvedValue([{ id: 'sess-1' }] as any);

        const res = await GET();
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.data).toEqual([{ id: 'sess-1' }]);
    });

    it('returns 500 when the store throws', async () => {
        vi.mocked(kbChatStore.listSessions).mockRejectedValue(new Error('DB down'));
        const res = await GET();
        expect(res.status).toBe(500);
    });
});
