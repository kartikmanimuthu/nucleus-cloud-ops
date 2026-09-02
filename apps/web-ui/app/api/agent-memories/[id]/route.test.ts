import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/repository-factory', () => ({ getAgentMemoryRepository: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('next-auth', () => ({ getServerSession: vi.fn() }));
vi.mock('@/lib/auth-options', () => ({ authOptions: {} }));

import { getAgentMemoryRepository } from '@/lib/db/repository-factory';
import { getSessionTenantId } from '@/lib/auth-session';
import { authorize } from '@/lib/rbac/authorize';
import { AuditService } from '@/lib/audit-service';
import { getServerSession } from 'next-auth';
import { GET, DELETE } from './route';

const makeParams = (id: string) => ({ params: Promise.resolve({ id }) });
const mockRepo = { getById: vi.fn(), deleteById: vi.fn() };

describe('GET /api/agent-memories/[id]', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getAgentMemoryRepository).mockReturnValue(mockRepo as any);
    });

    it('returns 401 when unauthenticated', async () => {
        vi.mocked(getSessionTenantId).mockRejectedValue(new Error('Unauthenticated'));
        const res = await GET({} as any, makeParams('m1'));
        expect(res.status).toBe(401);
    });

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);

        const res = await GET({} as any, makeParams('m1'));
        expect(res).toBe(authError);
        expect(mockRepo.getById).not.toHaveBeenCalled();
    });

    it('returns 404 when the memory does not exist for this tenant', async () => {
        mockRepo.getById.mockResolvedValue(null);
        const res = await GET({} as any, makeParams('m-missing'));
        expect(res.status).toBe(404);
    });

    it('returns the memory scoped by tenant', async () => {
        mockRepo.getById.mockResolvedValue({ id: 'm1', key: 'k' });
        const res = await GET({} as any, makeParams('m1'));
        const body = await res.json();

        expect(mockRepo.getById).toHaveBeenCalledWith('tenant-1', 'm1');
        expect(res.status).toBe(200);
        expect(body.data).toEqual({ id: 'm1', key: 'k' });
    });

    it('returns 500 for other errors', async () => {
        mockRepo.getById.mockRejectedValue(new Error('DB down'));
        const res = await GET({} as any, makeParams('m1'));
        expect(res.status).toBe(500);
    });
});

describe('DELETE /api/agent-memories/[id]', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getAgentMemoryRepository).mockReturnValue(mockRepo as any);
        vi.mocked(getServerSession).mockResolvedValue({ user: { email: 'a@b.co' } } as any);
    });

    it('returns 401 when unauthenticated', async () => {
        vi.mocked(getSessionTenantId).mockRejectedValue(new Error('Unauthenticated'));
        const res = await DELETE({} as any, makeParams('m1'));
        expect(res.status).toBe(401);
    });

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);

        const res = await DELETE({} as any, makeParams('m1'));
        expect(res).toBe(authError);
        expect(mockRepo.deleteById).not.toHaveBeenCalled();
    });

    it('returns 404 when the memory does not exist', async () => {
        mockRepo.getById.mockResolvedValue(null);
        const res = await DELETE({} as any, makeParams('m-missing'));
        expect(res.status).toBe(404);
    });

    it('deletes the memory scoped by tenant and logs an audit event', async () => {
        mockRepo.getById.mockResolvedValue({ id: 'm1', key: 'k', namespace: 'ns' });
        mockRepo.deleteById.mockResolvedValue(undefined);

        const res = await DELETE({} as any, makeParams('m1'));
        const body = await res.json();

        expect(mockRepo.deleteById).toHaveBeenCalledWith('tenant-1', 'm1');
        expect(res.status).toBe(200);
        expect(body).toEqual({ success: true });
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'delete', resourceId: 'm1', tenantId: 'tenant-1', status: 'success' })
        );
    });

    it('returns 500 for other errors', async () => {
        mockRepo.getById.mockRejectedValue(new Error('DB down'));
        const res = await DELETE({} as any, makeParams('m1'));
        expect(res.status).toBe(500);
    });
});
