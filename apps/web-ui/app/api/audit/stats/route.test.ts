import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { getAuditLogStats: vi.fn() } }));

import { getSessionTenantId } from '@/lib/auth-session';
import { AuditService } from '@/lib/audit-service';
import { GET } from './route';

const makeRequest = (search = '') => ({ url: `http://localhost/api/audit/stats${search}` }) as any;

describe('GET /api/audit/stats', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
    });

    it('builds filters from query params and scopes stats by tenant', async () => {
        vi.mocked(AuditService.getAuditLogStats).mockResolvedValue({ total: 5 } as any);

        const res = await GET(makeRequest('?severity=high&limit=20'));
        const body = await res.json();

        expect(AuditService.getAuditLogStats).toHaveBeenCalledWith(
            expect.objectContaining({ severity: 'high', limit: 20 }),
            'tenant-1',
        );
        expect(res.status).toBe(200);
        expect(body.data).toEqual({ total: 5 });
        expect(res.headers.get('Cache-Control')).toContain('s-maxage=60');
    });

    it('returns 500 when the service throws', async () => {
        vi.mocked(AuditService.getAuditLogStats).mockRejectedValue(new Error('DB down'));
        const res = await GET(makeRequest());
        expect(res.status).toBe(500);
    });
});
