import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/db/repository-factory', () => ({ getScalingAuditRepository: vi.fn() }));

import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { getScalingAuditRepository } from '@/lib/db/repository-factory';
import { GET } from './route';

const makeRequest = (url = 'http://localhost/api/scaling-audit/resources') => ({ url }) as any;

describe('GET /api/scaling-audit/resources', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
    });

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);

        const res = await GET(makeRequest());
        expect(res).toBe(authError);
    });

    it('defaults effect to capacity_changes', async () => {
        const listResources = vi.fn().mockResolvedValue({ resources: [], total: 0 });
        vi.mocked(getScalingAuditRepository).mockReturnValue({ listResources } as any);

        await GET(makeRequest());

        expect(listResources).toHaveBeenCalledWith(expect.objectContaining({ effect: 'capacity_changes' }));
    });

    it('returns resources with pagination meta', async () => {
        const listResources = vi.fn().mockResolvedValue({ resources: [{ id: 'r1' }], total: 1 });
        vi.mocked(getScalingAuditRepository).mockReturnValue({ listResources } as any);

        const res = await GET(makeRequest());
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.data).toEqual([{ id: 'r1' }]);
    });

    it('returns 500 when the repository throws', async () => {
        vi.mocked(getScalingAuditRepository).mockReturnValue({
            listResources: vi.fn().mockRejectedValue(new Error('DB down')),
        } as any);

        const res = await GET(makeRequest());
        expect(res.status).toBe(500);
    });
});
