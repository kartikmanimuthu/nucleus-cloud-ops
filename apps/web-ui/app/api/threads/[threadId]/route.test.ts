import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn(), getSessionUserId: vi.fn() }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) } }));

const mockDeleteThread = vi.fn();
const mockUpdateThread = vi.fn();
vi.mock('@/lib/store/thread-store', () => ({
    threadStore: { deleteThread: mockDeleteThread, updateThread: mockUpdateThread },
}));

import { getSessionTenantId, getSessionUserId } from '@/lib/auth-session';
import { AuditService } from '@/lib/audit-service';
import { DELETE, PATCH } from './route';

const makeParams = (threadId: string) => ({ params: Promise.resolve({ threadId }) });
const makeRequest = (body: unknown) => ({ json: vi.fn().mockResolvedValue(body) }) as any;

describe('DELETE /api/threads/[threadId]', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(getSessionUserId).mockResolvedValue('u1');
    });

    it('returns 401 when unauthenticated', async () => {
        vi.mocked(getSessionTenantId).mockRejectedValue(new Error('Unauthenticated'));
        const res = await DELETE({} as any, makeParams('thread-1'));
        expect(res.status).toBe(401);
    });

    it('returns 403 for a namespaced thread belonging to another tenant', async () => {
        const res = await DELETE({} as any, makeParams('tenant-other:u1:1'));
        expect(res.status).toBe(403);
        expect(mockDeleteThread).not.toHaveBeenCalled();
    });

    it('returns 404 when the thread does not exist', async () => {
        mockDeleteThread.mockResolvedValue(false);
        const res = await DELETE({} as any, makeParams('thread-1'));
        expect(res.status).toBe(404);
    });

    it('deletes the thread, logs an audit event, and returns success', async () => {
        mockDeleteThread.mockResolvedValue(true);

        const res = await DELETE({} as any, makeParams('thread-1'));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body).toEqual({ success: true });
        expect(mockDeleteThread).toHaveBeenCalledWith('thread-1', 'tenant-1');
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'chat.thread.deleted', status: 'success' })
        );
    });

    it('returns 500 when the thread store throws', async () => {
        mockDeleteThread.mockRejectedValue(new Error('DB down'));
        const res = await DELETE({} as any, makeParams('thread-1'));
        expect(res.status).toBe(500);
    });
});

describe('PATCH /api/threads/[threadId]', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(getSessionUserId).mockResolvedValue('u1');
    });

    it('returns 401 when unauthenticated', async () => {
        vi.mocked(getSessionUserId).mockRejectedValue(new Error('Unauthenticated'));
        const res = await PATCH(makeRequest({ title: 'New' }), makeParams('thread-1'));
        expect(res.status).toBe(401);
    });

    it('returns 404 when the thread does not exist', async () => {
        mockUpdateThread.mockResolvedValue(null);
        const res = await PATCH(makeRequest({ title: 'New' }), makeParams('thread-1'));
        expect(res.status).toBe(404);
    });

    it('updates the title and returns the updated thread', async () => {
        mockUpdateThread.mockResolvedValue({ id: 'thread-1', title: 'Renamed' });

        const res = await PATCH(makeRequest({ title: 'Renamed' }), makeParams('thread-1'));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body).toEqual({ id: 'thread-1', title: 'Renamed' });
        expect(mockUpdateThread).toHaveBeenCalledWith('thread-1', 'tenant-1', { title: 'Renamed' });
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'chat.thread.updated', status: 'success' })
        );
    });

    it('returns 500 when the thread store throws', async () => {
        mockUpdateThread.mockRejectedValue(new Error('DB down'));
        const res = await PATCH(makeRequest({ title: 'x' }), makeParams('thread-1'));
        expect(res.status).toBe(500);
    });
});
