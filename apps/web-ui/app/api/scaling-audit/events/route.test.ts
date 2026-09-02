import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/scaling-audit-service', () => ({ ScalingAuditService: { listEvents: vi.fn() } }));

import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { ScalingAuditService } from '@/lib/scaling-audit-service';
import { GET } from './route';

const makeRequest = (url = 'http://localhost/api/scaling-audit/events') => ({ url }) as any;

describe('GET /api/scaling-audit/events', () => {
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

    it('defaults effect to capacity_changes when not "all"', async () => {
        vi.mocked(ScalingAuditService.listEvents).mockResolvedValue({ events: [], total: 0 } as any);

        await GET(makeRequest());

        expect(ScalingAuditService.listEvents).toHaveBeenCalledWith(
            expect.objectContaining({ effect: 'capacity_changes' })
        );
    });

    it('opts into "all" only when effect=all is explicit', async () => {
        vi.mocked(ScalingAuditService.listEvents).mockResolvedValue({ events: [], total: 0 } as any);

        await GET(makeRequest('http://localhost/api/scaling-audit/events?effect=all'));

        expect(ScalingAuditService.listEvents).toHaveBeenCalledWith(expect.objectContaining({ effect: 'all' }));
    });

    it('splits excludeScalingTypes into an array', async () => {
        vi.mocked(ScalingAuditService.listEvents).mockResolvedValue({ events: [], total: 0 } as any);

        await GET(makeRequest('http://localhost/api/scaling-audit/events?excludeScalingTypes=guardrail,unparsed'));

        expect(ScalingAuditService.listEvents).toHaveBeenCalledWith(
            expect.objectContaining({ excludeScalingTypes: ['guardrail', 'unparsed'] })
        );
    });

    it('returns events with pagination meta', async () => {
        vi.mocked(ScalingAuditService.listEvents).mockResolvedValue({ events: [{ id: 'e1' }], total: 1 } as any);

        const res = await GET(makeRequest());
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.data).toEqual([{ id: 'e1' }]);
    });

    it('returns 500 when the service throws', async () => {
        vi.mocked(ScalingAuditService.listEvents).mockRejectedValue(new Error('DB down'));
        const res = await GET(makeRequest());
        expect(res.status).toBe(500);
    });
});
