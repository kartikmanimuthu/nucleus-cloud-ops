import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/dashboard-service', () => ({
    DashboardService: {
        getHeroKpis: vi.fn(),
        getActionCenter: vi.fn(),
        getCoverage: vi.fn(),
        getCostAutomation: vi.fn(),
        getAgentActivity: vi.fn(),
        getInventorySnapshot: vi.fn(),
        getAuditSnapshot: vi.fn(),
    },
}));

import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { DashboardService } from '@/lib/dashboard-service';
import { GET } from './route';

const makeRequest = (url: string) => ({ nextUrl: new URL(url) }) as any;

describe('GET /api/dashboard', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
    });

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);

        const res = await GET(makeRequest('http://localhost/api/dashboard'));
        expect(res).toBe(authError);
    });

    it('defaults to the hero zone and 24h range', async () => {
        vi.mocked(DashboardService.getHeroKpis).mockResolvedValue({ kpi: 1 } as any);

        const res = await GET(makeRequest('http://localhost/api/dashboard'));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.data).toEqual({ kpi: 1 });
        expect(DashboardService.getHeroKpis).toHaveBeenCalledWith('tenant-1', '24h');
    });

    it('returns 400 for an unknown zone', async () => {
        const res = await GET(makeRequest('http://localhost/api/dashboard?zone=bogus'));
        const body = await res.json();
        expect(res.status).toBe(400);
        expect(body.error).toContain('bogus');
    });

    it('returns 400 for an invalid range', async () => {
        const res = await GET(makeRequest('http://localhost/api/dashboard?zone=hero&range=1y'));
        expect(res.status).toBe(400);
    });

    it.each([
        ['action-center', 'getActionCenter'],
        ['cost-automation', 'getCostAutomation'],
        ['agent-activity', 'getAgentActivity'],
        ['audit', 'getAuditSnapshot'],
    ] as const)('routes zone=%s to DashboardService.%s with tenantId + range', async (zone, method) => {
        vi.mocked(DashboardService[method]).mockResolvedValue({ ok: true } as any);

        const res = await GET(makeRequest(`http://localhost/api/dashboard?zone=${zone}&range=7d`));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.data).toEqual({ ok: true });
        expect(DashboardService[method]).toHaveBeenCalledWith('tenant-1', '7d');
    });

    it.each([
        ['coverage', 'getCoverage'],
        ['inventory', 'getInventorySnapshot'],
    ] as const)('routes zone=%s to DashboardService.%s with tenantId only', async (zone, method) => {
        vi.mocked(DashboardService[method]).mockResolvedValue({ ok: true } as any);

        const res = await GET(makeRequest(`http://localhost/api/dashboard?zone=${zone}`));
        const body = await res.json();

        expect(body.data).toEqual({ ok: true });
        expect(DashboardService[method]).toHaveBeenCalledWith('tenant-1');
    });

    it('returns 500 when the service throws', async () => {
        vi.mocked(DashboardService.getHeroKpis).mockRejectedValue(new Error('DB down'));

        const res = await GET(makeRequest('http://localhost/api/dashboard'));
        expect(res.status).toBe(500);
    });
});
