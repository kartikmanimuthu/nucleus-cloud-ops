import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

vi.mock('@/lib/auth-session', () => ({
    getSessionTenantId: vi.fn(),
}));
vi.mock('@/lib/rbac/authorize', () => ({
    authorize: vi.fn(),
}));
vi.mock('@/lib/db/repository-factory', () => ({
    getAgentMemoryRepository: vi.fn(),
}));
vi.mock('@/lib/rbac/row-filter', () => ({
    getReadRowFilter: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/audit-service', () => ({
    AuditService: { logUserAction: vi.fn() },
}));
vi.mock('next-auth', () => ({ getServerSession: vi.fn().mockResolvedValue({ user: { email: 'x@y.z' } }) }));
vi.mock('@/lib/auth-options', () => ({ authOptions: {} }));

import { getSessionTenantId } from '@/lib/auth-session';
import { authorize } from '@/lib/rbac/authorize';
import { getAgentMemoryRepository } from '@/lib/db/repository-factory';
import { GET } from '@/app/api/agent-memories/route';
import { DELETE } from '@/app/api/agent-memories/[id]/route';

const repo = {
    listByTenant: vi.fn(),
    getById: vi.fn(),
    deleteById: vi.fn(),
};

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSessionTenantId).mockResolvedValue('tenant-a');
    vi.mocked(authorize).mockResolvedValue(null); // authorized by default
    vi.mocked(getAgentMemoryRepository).mockReturnValue(repo as any);
});

describe('GET /api/agent-memories', () => {
    it('scopes the list query to the session tenant and returns the envelope', async () => {
        repo.listByTenant.mockResolvedValue({ memories: [{ id: 'mem-1' }], total: 1 });
        const req = new Request('http://localhost/api/agent-memories?category=infra&search=ecs');
        const res = await GET(req as any);
        const body = await res.json();

        expect(repo.listByTenant).toHaveBeenCalledWith(
            expect.objectContaining({ tenantId: 'tenant-a', categories: ['infra'], search: 'ecs' })
        );
        expect(body).toEqual({ success: true, data: [{ id: 'mem-1' }], total: 1 });
    });

    it('returns the 403 from authorize when permission is denied', async () => {
        vi.mocked(authorize).mockResolvedValue(
            NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        );
        const req = new Request('http://localhost/api/agent-memories');
        const res = await GET(req as any);
        expect(res.status).toBe(403);
        expect(repo.listByTenant).not.toHaveBeenCalled();
    });

    it('parses a comma-separated category param into a validated categories array', async () => {
        repo.listByTenant.mockResolvedValue({ memories: [], total: 0 });
        const req = new Request('http://localhost/api/agent-memories?category=infra,user,bogus');
        await GET(req as any);
        expect(repo.listByTenant).toHaveBeenCalledWith(
            expect.objectContaining({ categories: ['infra', 'user'] })
        );
    });

    it('passes an empty categories array when no category param is present', async () => {
        repo.listByTenant.mockResolvedValue({ memories: [], total: 0 });
        const req = new Request('http://localhost/api/agent-memories');
        await GET(req as any);
        expect(repo.listByTenant).toHaveBeenCalledWith(
            expect.objectContaining({ categories: [] })
        );
    });

    it('parses a valid sort field + direction', async () => {
        repo.listByTenant.mockResolvedValue({ memories: [], total: 0 });
        const req = new Request('http://localhost/api/agent-memories?sort=createdAt&dir=desc');
        await GET(req as any);
        expect(repo.listByTenant).toHaveBeenCalledWith(
            expect.objectContaining({ sortBy: 'createdAt', sortDir: 'desc' })
        );
    });

    it('ignores an invalid sort field and leaves sort undefined', async () => {
        repo.listByTenant.mockResolvedValue({ memories: [], total: 0 });
        const req = new Request('http://localhost/api/agent-memories?sort=bogus&dir=asc');
        await GET(req as any);
        expect(repo.listByTenant).toHaveBeenCalledWith(
            expect.objectContaining({ sortBy: undefined, sortDir: undefined })
        );
    });

    it('defaults sort direction to asc for a valid field', async () => {
        repo.listByTenant.mockResolvedValue({ memories: [], total: 0 });
        const req = new Request('http://localhost/api/agent-memories?sort=key');
        await GET(req as any);
        expect(repo.listByTenant).toHaveBeenCalledWith(
            expect.objectContaining({ sortBy: 'key', sortDir: 'asc' })
        );
    });

    it('returns 401 when the session cannot be resolved', async () => {
        vi.mocked(getSessionTenantId).mockRejectedValue(new Error('Unauthenticated: no session'));
        const req = new Request('http://localhost/api/agent-memories');
        const res = await GET(req as any);
        expect(res.status).toBe(401);
    });

    it('returns 500 for an unexpected error', async () => {
        repo.listByTenant.mockRejectedValue(new Error('DB down'));
        const req = new Request('http://localhost/api/agent-memories');
        const res = await GET(req as any);
        expect(res.status).toBe(500);
    });
});

describe('DELETE /api/agent-memories/[id]', () => {
    it('returns 404 for a missing / cross-tenant memory and never deletes', async () => {
        repo.getById.mockResolvedValue(null);
        const req = new Request('http://localhost/api/agent-memories/mem-x', { method: 'DELETE' });
        const res = await DELETE(req as any, { params: Promise.resolve({ id: 'mem-x' }) });
        expect(res.status).toBe(404);
        expect(repo.deleteById).not.toHaveBeenCalled();
    });

    it('deletes an owned memory and returns success', async () => {
        repo.getById.mockResolvedValue({ id: 'mem-1', key: 'k', namespace: 'infra/a' });
        repo.deleteById.mockResolvedValue(undefined);
        const req = new Request('http://localhost/api/agent-memories/mem-1', { method: 'DELETE' });
        const res = await DELETE(req as any, { params: Promise.resolve({ id: 'mem-1' }) });
        const body = await res.json();
        expect(repo.deleteById).toHaveBeenCalledWith('tenant-a', 'mem-1');
        expect(body).toEqual({ success: true });
    });
});
