import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/db/repository-factory', () => ({ getAuditLogRepository: vi.fn() }));

import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { getAuditLogRepository } from '@/lib/db/repository-factory';
import { GET } from './route';

describe('GET /api/audit/filters', () => {
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

    it('returns 501 when the repository does not support distinct filter values', async () => {
        vi.mocked(getAuditLogRepository).mockReturnValue({} as any);
        const res = await GET();
        expect(res.status).toBe(501);
    });

    it('returns distinct filter values scoped by tenant', async () => {
        const getDistinctFilterValues = vi.fn().mockResolvedValue({ eventTypes: ['a'] });
        vi.mocked(getAuditLogRepository).mockReturnValue({ getDistinctFilterValues } as any);

        const res = await GET();
        const body = await res.json();

        expect(getDistinctFilterValues).toHaveBeenCalledWith('tenant-1');
        expect(res.status).toBe(200);
        expect(body.data).toEqual({ eventTypes: ['a'] });
    });

    it('returns 500 when the repository throws', async () => {
        vi.mocked(getAuditLogRepository).mockReturnValue({
            getDistinctFilterValues: vi.fn().mockRejectedValue(new Error('DB down')),
        } as any);
        const res = await GET();
        expect(res.status).toBe(500);
    });
});
