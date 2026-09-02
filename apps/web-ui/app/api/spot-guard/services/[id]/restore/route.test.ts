import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn(), getSessionUserEmail: vi.fn() }));
vi.mock('@/lib/spot-guard-service', () => ({ SpotGuardService: { triggerRestore: vi.fn() } }));

import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId, getSessionUserEmail } from '@/lib/auth-session';
import { SpotGuardService } from '@/lib/spot-guard-service';
import { POST } from './route';

const makeParams = (id: string) => ({ params: Promise.resolve({ id }) });

describe('POST /api/spot-guard/services/[id]/restore', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(getSessionUserEmail).mockResolvedValue('a@b.co');
    });

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);

        const res = await POST({} as any, makeParams('svc-1'));
        expect(res).toBe(authError);
    });

    it('returns 202 with the new jobId when a fresh restore is queued', async () => {
        vi.mocked(SpotGuardService.triggerRestore).mockResolvedValue({ jobId: 'job-1' } as any);

        const res = await POST({} as any, makeParams('svc-1'));
        const body = await res.json();

        expect(res.status).toBe(202);
        expect(body.data).toEqual({ jobId: 'job-1', alreadyQueued: false });
        expect(SpotGuardService.triggerRestore).toHaveBeenCalledWith('tenant-1', 'a@b.co', ['svc-1']);
    });

    it('returns 200 with alreadyQueued: true when the restore was deduplicated', async () => {
        vi.mocked(SpotGuardService.triggerRestore).mockResolvedValue({ jobId: null } as any);

        const res = await POST({} as any, makeParams('svc-1'));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.data).toEqual({ jobId: null, alreadyQueued: true });
    });

    it('returns 500 when the service throws', async () => {
        vi.mocked(SpotGuardService.triggerRestore).mockRejectedValue(new Error('DB down'));
        const res = await POST({} as any, makeParams('svc-1'));
        expect(res.status).toBe(500);
    });
});
