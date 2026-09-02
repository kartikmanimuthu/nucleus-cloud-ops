import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/rbac/registry-admin', () => ({ loadAdminRegistry: vi.fn() }));

import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { loadAdminRegistry } from '@/lib/rbac/registry-admin';
import { GET } from './route';

describe('GET /api/settings/rbac/registry', () => {
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

    it('loads the full admin registry scoped by tenant', async () => {
        vi.mocked(loadAdminRegistry).mockResolvedValue({ modules: [], actions: [], subjects: [] } as any);

        const res = await GET();
        const body = await res.json();

        expect(loadAdminRegistry).toHaveBeenCalledWith('tenant-1');
        expect(res.status).toBe(200);
        expect(body.data).toEqual({ modules: [], actions: [], subjects: [] });
    });

    it('returns 500 when the registry load fails', async () => {
        vi.mocked(loadAdminRegistry).mockRejectedValue(new Error('DB down'));
        const res = await GET();
        expect(res.status).toBe(500);
    });
});
