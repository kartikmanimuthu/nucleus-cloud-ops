import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn(), getAuthSession: vi.fn() }));
vi.mock('@/lib/rbac/registry-admin', () => ({ loadAdminRegistry: vi.fn() }));
vi.mock('@/lib/rbac/registry-admin-writes', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/rbac/registry-admin-writes')>()),
    createModule: vi.fn(),
}));

import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import { loadAdminRegistry } from '@/lib/rbac/registry-admin';
import { createModule, SystemRowError, RegistryInUseError } from '@/lib/rbac/registry-admin-writes';
import { GET, POST } from './route';

const VALID_BODY = { key: 'k', label: 'L', actionKeys: ['read'], subjectKeys: ['Account'] };
const makeRequest = (body: unknown) => ({ json: vi.fn().mockResolvedValue(body) }) as any;

describe('GET /api/settings/rbac/modules', () => {
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
        expect(loadAdminRegistry).not.toHaveBeenCalled();
    });

    it('lists modules scoped by tenant', async () => {
        vi.mocked(loadAdminRegistry).mockResolvedValue({ modules: [{ key: 'm1' }] } as any);
        const res = await GET();
        const body = await res.json();

        expect(loadAdminRegistry).toHaveBeenCalledWith('tenant-1');
        expect(res.status).toBe(200);
        expect(body.data).toEqual([{ key: 'm1' }]);
    });

    it('returns 500 when the registry load fails', async () => {
        vi.mocked(loadAdminRegistry).mockRejectedValue(new Error('DB down'));
        const res = await GET();
        expect(res.status).toBe(500);
    });
});

describe('POST /api/settings/rbac/modules', () => {
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

        const res = await POST(makeRequest(VALID_BODY));
        expect(res).toBe(authError);
        expect(createModule).not.toHaveBeenCalled();
    });

    it('returns 400 when key or label is missing', async () => {
        const res = await POST(makeRequest({ actionKeys: [], subjectKeys: [] }));
        expect(res.status).toBe(400);
    });

    it('returns 400 when actionKeys/subjectKeys are not arrays', async () => {
        const res = await POST(makeRequest({ key: 'k', label: 'L' }));
        expect(res.status).toBe(400);
    });

    it('returns 400 when sortOrder is present but non-numeric', async () => {
        const res = await POST(makeRequest({ ...VALID_BODY, sortOrder: 'abc' }));
        expect(res.status).toBe(400);
    });

    it('creates the module with a resolved actor', async () => {
        vi.mocked(createModule).mockResolvedValue({ id: 'm1' } as any);

        const res = await POST(makeRequest(VALID_BODY));
        const body = await res.json();

        expect(createModule).toHaveBeenCalledWith(
            { userId: 'u1', email: 'a@b.co', tenantId: 'tenant-1' },
            expect.objectContaining({ key: 'k', label: 'L', actionKeys: ['read'], subjectKeys: ['Account'] }),
        );
        expect(res.status).toBe(201);
        expect(body.data).toEqual({ id: 'm1' });
    });

    it('maps SystemRowError to 403', async () => {
        vi.mocked(createModule).mockRejectedValue(new SystemRowError('system row'));
        const res = await POST(makeRequest(VALID_BODY));
        expect(res.status).toBe(403);
    });

    it('maps RegistryInUseError to 409', async () => {
        vi.mocked(createModule).mockRejectedValue(new RegistryInUseError('in use'));
        const res = await POST(makeRequest(VALID_BODY));
        expect(res.status).toBe(409);
    });

    it('maps other errors to 400', async () => {
        vi.mocked(createModule).mockRejectedValue(new Error('bad input'));
        const res = await POST(makeRequest(VALID_BODY));
        expect(res.status).toBe(400);
    });
});
