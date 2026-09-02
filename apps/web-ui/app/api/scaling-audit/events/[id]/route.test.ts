import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/scaling-audit-service', () => ({ ScalingAuditService: { getEvent: vi.fn() } }));

import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { ScalingAuditService } from '@/lib/scaling-audit-service';
import { GET } from './route';

const makeParams = (id: string) => ({ params: Promise.resolve({ id }) });

describe('GET /api/scaling-audit/events/[id]', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
    });

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);

        const res = await GET({} as any, makeParams('evt-1'));
        expect(res).toBe(authError);
    });

    it('returns 404 when the event does not exist', async () => {
        vi.mocked(ScalingAuditService.getEvent).mockResolvedValue(null);

        const res = await GET({} as any, makeParams('evt-missing'));
        const body = await res.json();

        expect(res.status).toBe(404);
        expect(body.error).toBe('Scaling event not found');
    });

    it('returns 200 with event detail', async () => {
        vi.mocked(ScalingAuditService.getEvent).mockResolvedValue({ id: 'evt-1', rawPayload: {} } as any);

        const res = await GET({} as any, makeParams('evt-1'));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.data.id).toBe('evt-1');
        expect(ScalingAuditService.getEvent).toHaveBeenCalledWith('evt-1', 'tenant-1');
    });

    it('returns 500 when the service throws', async () => {
        vi.mocked(ScalingAuditService.getEvent).mockRejectedValue(new Error('DB down'));
        const res = await GET({} as any, makeParams('evt-1'));
        expect(res.status).toBe(500);
    });
});
