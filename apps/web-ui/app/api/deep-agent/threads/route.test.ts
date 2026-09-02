import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../lib/deep-agent/db/chat-history-store', () => ({
    listThreads: vi.fn(), createThread: vi.fn(),
}));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn(), getAuthSession: vi.fn() }));

import { listThreads, createThread } from '../../../../lib/deep-agent/db/chat-history-store';
import { AuditService } from '@/lib/audit-service';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import { GET, POST } from './route';

const makeGetRequest = (search = '') => ({ url: `http://localhost/api/deep-agent/threads${search}` }) as any;
const makePostRequest = (body: unknown) => ({ json: vi.fn().mockResolvedValue(body) }) as any;

describe('GET /api/deep-agent/threads', () => {
    beforeEach(() => vi.clearAllMocks());

    it('lists threads with default limit/skip', async () => {
        vi.mocked(listThreads).mockResolvedValue([{ threadId: 't1' }] as any);
        const res = await GET(makeGetRequest());
        const body = await res.json();

        expect(listThreads).toHaveBeenCalledWith(50, 0);
        expect(res.status).toBe(200);
        expect(body.threads).toEqual([{ threadId: 't1' }]);
    });

    it('caps limit at 100', async () => {
        vi.mocked(listThreads).mockResolvedValue([]);
        await GET(makeGetRequest('?limit=500&skip=10'));
        expect(listThreads).toHaveBeenCalledWith(100, 10);
    });

    it('returns 500 when the store throws', async () => {
        vi.mocked(listThreads).mockRejectedValue(new Error('DB down'));
        const res = await GET(makeGetRequest());
        expect(res.status).toBe(500);
    });
});

describe('POST /api/deep-agent/threads', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(getAuthSession).mockResolvedValue({ user: { email: 'a@b.co' } } as any);
    });

    it('creates a thread with a generated id when none is provided', async () => {
        vi.mocked(createThread).mockResolvedValue({ threadId: 'generated', title: 'New conversation' } as any);

        const res = await POST(makePostRequest({}));
        const body = await res.json();

        expect(createThread).toHaveBeenCalledWith(expect.any(String), 'New conversation', 'default');
        expect(res.status).toBe(201);
        expect(body.thread).toEqual({ threadId: 'generated', title: 'New conversation' });
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'chat.thread.created', tenantId: 'tenant-1', user: 'a@b.co' })
        );
    });

    it('uses the provided threadId, title, and model', async () => {
        vi.mocked(createThread).mockResolvedValue({ threadId: 't1' } as any);
        await POST(makePostRequest({ threadId: 't1', title: 'My Chat', model: 'sonnet' }));
        expect(createThread).toHaveBeenCalledWith('t1', 'My Chat', 'sonnet');
    });

    it('still creates the thread and returns 201 when audit context resolution fails', async () => {
        vi.mocked(getSessionTenantId).mockRejectedValue(new Error('Unauthenticated'));
        vi.mocked(createThread).mockResolvedValue({ threadId: 't1' } as any);

        const res = await POST(makePostRequest({ threadId: 't1' }));
        expect(res.status).toBe(201);
    });

    it('returns 500 when thread creation fails', async () => {
        vi.mocked(createThread).mockRejectedValue(new Error('DB down'));
        const res = await POST(makePostRequest({}));
        expect(res.status).toBe(500);
    });
});
