import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn(), getSessionUserId: vi.fn() }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) } }));

const mockListThreads = vi.fn();
const mockCreateThread = vi.fn();
vi.mock('@/lib/store/thread-store', () => ({
    threadStore: { listThreads: mockListThreads, createThread: mockCreateThread },
}));

import { getSessionTenantId, getSessionUserId } from '@/lib/auth-session';
import { AuditService } from '@/lib/audit-service';
import { GET, POST } from './route';

const makeRequest = (body: unknown) => ({ json: vi.fn().mockResolvedValue(body) }) as any;

describe('GET /api/threads', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(getSessionUserId).mockResolvedValue('u1');
    });

    it('returns 401 when unauthenticated', async () => {
        vi.mocked(getSessionTenantId).mockRejectedValue(new Error('Unauthenticated'));

        const res = await GET();
        expect(res.status).toBe(401);
    });

    it('returns the tenant-scoped thread list', async () => {
        mockListThreads.mockResolvedValue([{ id: 't1' }]);

        const res = await GET();
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body).toEqual([{ id: 't1' }]);
        expect(mockListThreads).toHaveBeenCalledWith('tenant-1');
    });

    it('returns 500 when the thread store throws', async () => {
        mockListThreads.mockRejectedValue(new Error('DB down'));
        const res = await GET();
        expect(res.status).toBe(500);
    });
});

describe('POST /api/threads', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(getSessionUserId).mockResolvedValue('u1');
    });

    it('returns 400 when id is missing', async () => {
        const res = await POST(makeRequest({ title: 'x' }));
        expect(res.status).toBe(400);
    });

    it('returns 401 when unauthenticated', async () => {
        vi.mocked(getSessionUserId).mockRejectedValue(new Error('Unauthenticated'));
        const res = await POST(makeRequest({ id: 'thread-1' }));
        expect(res.status).toBe(401);
    });

    it('returns 403 when a namespaced thread id embeds a different tenant', async () => {
        const res = await POST(makeRequest({ id: 'tenant-other:u1:123' }));
        const body = await res.json();
        expect(res.status).toBe(403);
        expect(body.error).toContain('another tenant');
        expect(mockCreateThread).not.toHaveBeenCalled();
    });

    it('creates the thread, logs an audit event, and returns it', async () => {
        mockCreateThread.mockResolvedValue({ id: 'tenant-1:u1:123', title: 'New Chat' });

        const res = await POST(makeRequest({ id: 'tenant-1:u1:123', title: 'New Chat', model: 'sonnet' }));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body).toEqual({ id: 'tenant-1:u1:123', title: 'New Chat' });
        expect(mockCreateThread).toHaveBeenCalledWith('tenant-1:u1:123', 'New Chat', 'sonnet', 'tenant-1', 'u1');
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'chat.thread.created', status: 'success' })
        );
    });

    it('returns 500 when the thread store throws', async () => {
        mockCreateThread.mockRejectedValue(new Error('DB down'));
        const res = await POST(makeRequest({ id: 'thread-1' }));
        expect(res.status).toBe(500);
    });
});
