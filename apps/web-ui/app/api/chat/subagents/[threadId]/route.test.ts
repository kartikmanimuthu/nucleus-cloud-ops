import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/db/repository-factory', () => ({
    getSubagentRunRepository: vi.fn(),
}));

import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { getSubagentRunRepository } from '@/lib/db/repository-factory';
import { GET } from './route';

const params = (threadId: string) => ({ params: Promise.resolve({ threadId }) });
const listByThread = vi.fn();

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authorize).mockResolvedValue(null as never);
    vi.mocked(getSessionTenantId).mockResolvedValue('t1' as never);
    vi.mocked(getSubagentRunRepository).mockReturnValue({ save: vi.fn(), listByThread } as never);
    listByThread.mockResolvedValue([{ subagentId: 'a', role: 'A', transcript: [] }]);
});

describe('GET /api/chat/subagents/[threadId]', () => {
    it('returns the thread\'s sub-agent runs', async () => {
        const body = await (await GET({} as never, params('thread-1'))).json();

        expect(body.success).toBe(true);
        expect(body.data).toHaveLength(1);
        expect(listByThread).toHaveBeenCalledWith('t1', 'thread-1');
    });

    it('propagates an RBAC denial', async () => {
        const denied = { status: 403 };
        vi.mocked(authorize).mockResolvedValue(denied as never);
        expect(await GET({} as never, params('thread-1'))).toBe(denied);
    });

    it('403s with no tenant context', async () => {
        vi.mocked(getSessionTenantId).mockResolvedValue(null as never);
        expect((await GET({} as never, params('thread-1'))).status).toBe(403);
    });

    // getSessionTenantId THROWS on an unauthenticated session (it does not return
    // null), so the 403 above is only reachable if the throw is caught and mapped —
    // otherwise a signed-out caller would get a misleading 500.
    it('403s when the session lookup throws', async () => {
        vi.mocked(getSessionTenantId).mockRejectedValue(new Error('Unauthenticated: no valid session'));
        expect((await GET({} as never, params('thread-1'))).status).toBe(403);
    });

    it('500s when the repository throws', async () => {
        listByThread.mockRejectedValue(new Error('db down'));
        expect((await GET({} as never, params('thread-1'))).status).toBe(500);
    });
});
