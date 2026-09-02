import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn(), getAuthSession: vi.fn() }));
vi.mock('@/lib/rbac/registry-admin', () => ({ loadAdminRegistry: vi.fn() }));
vi.mock('@/lib/rbac/registry-admin-writes', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/rbac/registry-admin-writes')>()),
    createAction: vi.fn(),
}));

import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import { loadAdminRegistry } from '@/lib/rbac/registry-admin';
import { createAction, SystemRowError } from '@/lib/rbac/registry-admin-writes';
import { GET, POST } from './route';

const makeRequest = (body: unknown) => ({ json: vi.fn().mockResolvedValue(body) }) as any;

describe('GET /api/settings/rbac/permissions', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
    });

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);

        const res = await GET();
        expect(res).toBe(authError);
    });

    it('lists permissions scoped by tenant', async () => {
        vi.mocked(loadAdminRegistry).mockResolvedValue({ actions: [{ key: 'read' }] } as any);
        const res = await GET();
        const body = await res.json();

        expect(loadAdminRegistry).toHaveBeenCalledWith('tenant-1');
        expect(res.status).toBe(200);
        expect(body.data).toEqual([{ key: 'read' }]);
    });

    it('returns 500 when the registry load fails', async () => {
        vi.mocked(loadAdminRegistry).mockRejectedValue(new Error('DB down'));
        const res = await GET();
        expect(res.status).toBe(500);
    });
});

describe('POST /api/settings/rbac/permissions', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(getAuthSession).mockResolvedValue({ user: { id: 'u1', email: 'a@b.co' } } as any);
    });

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);

        const res = await POST(makeRequest({ key: 'k', label: 'L' }));
        expect(res).toBe(authError);
        expect(createAction).not.toHaveBeenCalled();
    });

    it('returns 400 when key or label is missing', async () => {
        const res = await POST(makeRequest({ key: 'k' }));
        expect(res.status).toBe(400);
    });

    it('creates the permission with defaults applied', async () => {
        vi.mocked(createAction).mockResolvedValue({ id: 'a1' } as any);

        const res = await POST(makeRequest({ key: 'k', label: 'L' }));
        const body = await res.json();

        expect(createAction).toHaveBeenCalledWith(
            { userId: 'u1', email: 'a@b.co', tenantId: 'tenant-1' },
            expect.objectContaining({ key: 'k', label: 'L', aliasOfKey: null, isDangerous: false, sortOrder: 100 }),
        );
        expect(res.status).toBe(201);
        expect(body.data).toEqual({ id: 'a1' });
    });

    it('maps SystemRowError to 403', async () => {
        vi.mocked(createAction).mockRejectedValue(new SystemRowError('system row'));
        const res = await POST(makeRequest({ key: 'k', label: 'L' }));
        expect(res.status).toBe(403);
    });
});
