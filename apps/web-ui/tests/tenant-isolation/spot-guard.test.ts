// web-ui/tests/tenant-isolation/spot-guard.test.ts
//
// The 7th file in this directory — tenant isolation is an enforced convention here, not an
// optional extra. Asserts that every Spot Guard read and mutation is scoped to the caller's
// tenant, and that a cross-tenant id is indistinguishable from a missing one.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

const mockRepo = {
    listServices: vi.fn(),
    getService: vi.fn(),
    findServiceByTarget: vi.fn(),
    upsertService: vi.fn(),
    setManagementState: vi.fn(),
    deleteService: vi.fn(),
    listEvents: vi.fn(),
    recordEvent: vi.fn(),
    getSummary: vi.fn(),
    getHoursReport: vi.fn(),
    listEligibleServices: vi.fn(),
};

vi.mock('@/lib/auth-session', () => ({
    getSessionTenantId: vi.fn(async () => TENANT_A),
    getSessionUserEmail: vi.fn(async () => 'test-user@example.com'),
}));

vi.mock('@/lib/rbac/authorize', () => ({
    authorize: vi.fn(async () => null), // authorized
}));

vi.mock('@/lib/db/repository-factory', () => ({
    getSpotGuardRepository: () => mockRepo,
    getAccountRepository: () => ({ getAccount: vi.fn(async () => null) }),
}));

vi.mock('@/lib/audit-service', () => ({
    AuditService: { logUserAction: vi.fn(async () => undefined) },
}));

vi.mock('@/lib/boss-client', () => ({
    getBoss: vi.fn(async () => ({ send: vi.fn(async () => 'job-1') })),
}));

beforeEach(() => {
    vi.clearAllMocks();
});

describe('Spot Guard tenant isolation — reads', () => {
    it('scopes the services list to the session tenant', async () => {
        mockRepo.listServices.mockResolvedValue({ services: [], total: 0 });
        const { GET } = await import('@/app/api/spot-guard/services/route');
        await GET(new Request('http://localhost/api/spot-guard/services') as never);

        expect(mockRepo.listServices).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT_A }));
        // The request never mentions tenant B, and no call may reference it.
        expect(JSON.stringify(mockRepo.listServices.mock.calls)).not.toContain(TENANT_B);
    });

    it('does not let a query parameter override the tenant', async () => {
        // A caller adding ?tenantId=tenant-b must not be able to read another tenant's data;
        // the tenant comes from the session, never the request.
        mockRepo.listServices.mockResolvedValue({ services: [], total: 0 });
        const { GET } = await import('@/app/api/spot-guard/services/route');
        await GET(new Request(`http://localhost/api/spot-guard/services?tenantId=${TENANT_B}`) as never);

        expect(mockRepo.listServices).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT_A }));
        expect(JSON.stringify(mockRepo.listServices.mock.calls)).not.toContain(TENANT_B);
    });

    it('scopes the events list to the session tenant', async () => {
        mockRepo.listEvents.mockResolvedValue({ events: [], total: 0 });
        const { GET } = await import('@/app/api/spot-guard/events/route');
        await GET(new Request('http://localhost/api/spot-guard/events') as never);
        expect(mockRepo.listEvents).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT_A }));
    });

    it('scopes the summary to the session tenant', async () => {
        mockRepo.getSummary.mockResolvedValue({});
        const { GET } = await import('@/app/api/spot-guard/summary/route');
        await GET();
        expect(mockRepo.getSummary).toHaveBeenCalledWith(TENANT_A);
    });

    it('scopes the hours report to the session tenant', async () => {
        mockRepo.getHoursReport.mockResolvedValue({ rows: [], totals: {}, dataQuality: {} });
        const { GET } = await import('@/app/api/spot-guard/report/route');
        await GET(new Request('http://localhost/api/spot-guard/report') as never);
        expect(mockRepo.getHoursReport).toHaveBeenCalledWith(TENANT_A, expect.anything());
    });

    it('scopes the eligible list to the session tenant', async () => {
        mockRepo.listEligibleServices.mockResolvedValue({ services: [], total: 0 });
        const { GET } = await import('@/app/api/spot-guard/eligible/route');
        await GET(new Request('http://localhost/api/spot-guard/eligible') as never);
        expect(mockRepo.listEligibleServices).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT_A }));
    });
});

describe('Spot Guard tenant isolation — cross-tenant access', () => {
    it('returns 404, not 403, for another tenant service detail', async () => {
        // 403 would confirm the row exists somewhere else. The repository scopes its lookup,
        // so "not yours" and "not there" are deliberately indistinguishable.
        mockRepo.getService.mockResolvedValue(null);
        const { GET } = await import('@/app/api/spot-guard/services/[id]/route');
        const res = await GET(new Request('http://localhost/x') as never, {
            params: Promise.resolve({ id: 'tenant-b-service-id' }),
        });
        expect(res.status).toBe(404);
        expect(mockRepo.getService).toHaveBeenCalledWith('tenant-b-service-id', TENANT_A);
    });

    it('returns 404 when enabling Spot on another tenant service', async () => {
        mockRepo.getService.mockResolvedValue(null);
        const { POST } = await import('@/app/api/spot-guard/services/[id]/enable/route');
        const res = await POST(
            new Request('http://localhost/x', {
                method: 'POST',
                body: JSON.stringify({ confirm: true, confirmServiceName: 'api' }),
            }) as never,
            { params: Promise.resolve({ id: 'tenant-b-service-id' }) },
        );
        expect(res.status).toBe(404);
    });

    it('passes the session tenant, not the target tenant, to setManagementState', async () => {
        mockRepo.setManagementState.mockResolvedValue({
            id: 'x', accountId: '1', region: 'r', clusterName: 'c', serviceName: 's',
        });
        mockRepo.recordEvent.mockResolvedValue({});
        const { PATCH } = await import('@/app/api/spot-guard/services/[id]/route');
        await PATCH(
            new Request('http://localhost/x', { method: 'PATCH', body: JSON.stringify({ managementState: 'unmanaged' }) }) as never,
            { params: Promise.resolve({ id: 'svc-1' }) },
        );
        expect(mockRepo.setManagementState).toHaveBeenCalledWith(
            'svc-1',
            TENANT_A,
            'unmanaged',
            'test-user@example.com',
        );
    });
});

describe('Spot Guard RBAC', () => {
    it('refuses a read without the read permission', async () => {
        const { authorize } = await import('@/lib/rbac/authorize');
        vi.mocked(authorize).mockResolvedValueOnce(
            new Response(JSON.stringify({ success: false, error: 'Forbidden' }), { status: 403 }) as never,
        );
        const { GET } = await import('@/app/api/spot-guard/services/route');
        const res = await GET(new Request('http://localhost/api/spot-guard/services') as never);
        expect(res.status).toBe(403);
        // Authorization must short-circuit BEFORE any data access.
        expect(mockRepo.listServices).not.toHaveBeenCalled();
    });

    it('checks update (not read) on the enable route', async () => {
        const { authorize } = await import('@/lib/rbac/authorize');
        mockRepo.getService.mockResolvedValue(null);
        const { POST } = await import('@/app/api/spot-guard/services/[id]/enable/route');
        await POST(
            new Request('http://localhost/x', {
                method: 'POST',
                body: JSON.stringify({ confirm: true, confirmServiceName: 'api' }),
            }) as never,
            { params: Promise.resolve({ id: 'svc-1' }) },
        );
        expect(authorize).toHaveBeenCalledWith('update', 'SpotGuard');
    });

    it('checks delete on the delete route', async () => {
        const { authorize } = await import('@/lib/rbac/authorize');
        mockRepo.deleteService.mockResolvedValue(undefined);
        const { DELETE } = await import('@/app/api/spot-guard/services/[id]/route');
        await DELETE(new Request('http://localhost/x', { method: 'DELETE' }) as never, {
            params: Promise.resolve({ id: 'svc-1' }),
        });
        expect(authorize).toHaveBeenCalledWith('delete', 'SpotGuard');
    });
});
