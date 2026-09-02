import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('next-auth', () => ({ getServerSession: vi.fn() }));
vi.mock('@/app/api/auth/[...nextauth]/route', () => ({ authOptions: {} }));
vi.mock('@/lib/db/pg-config', () => ({ getPrismaClient: vi.fn() }));

import { authorize } from '@/lib/rbac/authorize';
import { getServerSession } from 'next-auth';
import { getPrismaClient } from '@/lib/db/pg-config';
import { GET } from './route';

const makeRequest = () => ({}) as any;

describe('GET /api/discovery/status', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getServerSession).mockResolvedValue({ user: { tenantId: 'tenant-1' } } as any);
    });

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);

        const res = await GET(makeRequest());
        expect(res).toBe(authError);
    });

    it('returns 403 when the session has no tenant context', async () => {
        vi.mocked(getServerSession).mockResolvedValue({ user: {} } as any);
        const res = await GET(makeRequest());
        const body = await res.json();
        expect(res.status).toBe(403);
        expect(body.error).toBe('No tenant context');
    });

    it('returns the 10 most recent sync statuses', async () => {
        const findMany = vi.fn().mockResolvedValue([{ id: 's1' }]);
        vi.mocked(getPrismaClient).mockReturnValue({ inventorySyncStatus: { findMany } } as any);

        const res = await GET(makeRequest());
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.data).toEqual([{ id: 's1' }]);
        expect(findMany).toHaveBeenCalledWith({ orderBy: { syncedAt: 'desc' }, take: 10 });
    });

    it('returns 500 when the database call throws', async () => {
        vi.mocked(getPrismaClient).mockReturnValue({
            inventorySyncStatus: { findMany: vi.fn().mockRejectedValue(new Error('DB down')) },
        } as any);

        const res = await GET(makeRequest());
        expect(res.status).toBe(500);
    });
});
