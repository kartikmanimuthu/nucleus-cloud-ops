import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { getAuditLogsByCorrelation: vi.fn() } }));

import { getSessionTenantId } from '@/lib/auth-session';
import { AuditService } from '@/lib/audit-service';
import { GET } from './route';

const makeParams = (correlationId: string) => ({ params: Promise.resolve({ correlationId }) });

describe('GET /api/audit/correlation/[correlationId]', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
    });

    it('returns 400 when correlationId is missing', async () => {
        const res = await GET({} as any, makeParams(''));
        expect(res.status).toBe(400);
    });

    it('fetches correlated logs scoped by tenant', async () => {
        vi.mocked(AuditService.getAuditLogsByCorrelation).mockResolvedValue([{ id: 'l1' }, { id: 'l2' }] as any);

        const res = await GET({} as any, makeParams('corr-1'));
        const body = await res.json();

        expect(AuditService.getAuditLogsByCorrelation).toHaveBeenCalledWith('corr-1', 'tenant-1');
        expect(res.status).toBe(200);
        expect(body).toEqual({ success: true, data: [{ id: 'l1' }, { id: 'l2' }], count: 2 });
    });

    it('returns 500 when the service throws', async () => {
        vi.mocked(AuditService.getAuditLogsByCorrelation).mockRejectedValue(new Error('DB down'));
        const res = await GET({} as any, makeParams('corr-1'));
        expect(res.status).toBe(500);
    });
});
