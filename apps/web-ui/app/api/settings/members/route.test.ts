import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/db/pg-config', () => ({ getTenantClient: vi.fn() }));

import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { getTenantClient } from '@/lib/db/pg-config';
import { GET } from './route';

describe('GET /api/settings/members', () => {
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

    it('returns members ordered by assignedAt desc', async () => {
        const findMany = vi.fn().mockResolvedValue([{ id: 'm1' }]);
        vi.mocked(getTenantClient).mockReturnValue({ userTenantRole: { findMany } } as any);

        const res = await GET();
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.data).toEqual([{ id: 'm1' }]);
        expect(findMany).toHaveBeenCalledWith({ orderBy: { assignedAt: 'desc' } });
        expect(getTenantClient).toHaveBeenCalledWith('tenant-1');
    });

    it('returns 500 when the database call throws', async () => {
        vi.mocked(getTenantClient).mockReturnValue({
            userTenantRole: { findMany: vi.fn().mockRejectedValue(new Error('DB down')) },
        } as any);

        const res = await GET();
        expect(res.status).toBe(500);
    });
});
