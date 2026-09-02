import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/server', () => ({
    NextRequest: vi.fn(),
    NextResponse: {
        json: vi.fn((data: unknown, init?: { status?: number }) => ({
            _data: data,
            _status: init?.status ?? 200,
        })),
    },
}));

vi.mock('next-auth', () => ({ getServerSession: vi.fn() }));
vi.mock('@/app/api/auth/[...nextauth]/route', () => ({ authOptions: {} }));

// vi.hoisted is required, not stylistic: vi.mock is hoisted above plain const
// declarations, so a factory that evaluates a bare `mockX` at import time hits a
// temporal dead zone. Matches app/api/accounts/bulk/route.test.ts.
const mockAuthorize = vi.hoisted(() => vi.fn());
const mockGetResourceDependencies = vi.hoisted(() => vi.fn());
const mockResolveResourceType = vi.hoisted(() => vi.fn());
const mockListAccounts = vi.hoisted(() => vi.fn());

vi.mock('@/lib/rbac/authorize', () => ({ authorize: mockAuthorize }));

vi.mock('@/lib/db/repository-factory', () => ({
    getResourceGraphRepository: () => ({
        getResourceDependencies: mockGetResourceDependencies,
        resolveResourceType: mockResolveResourceType,
        // resolveResourceRef is what the tools call now. Deriving it from the existing
        // resolveResourceType mock keeps these cases exercising id-only resolution, which is
        // what they were written to cover; name resolution has its own test.
        resolveResourceRef: async ({ ref }: { ref: string }) => {
            const resourceType = await mockResolveResourceType({ resourceId: ref });
            return resourceType ? { resourceType, resourceId: ref } : null;
        },
    }),
    getAccountRepository: () => ({ listByTenant: mockListAccounts }),
}));

vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: () => 'tenant-1' }));

import { GET } from './route';

const req = (qs: string) => ({ url: `http://localhost/api/resource-graph?${qs}` }) as never;

const EMPTY = { dependents: { edges: [], total: 0, truncated: false },
                dependsOn: { edges: [], total: 0, truncated: false }, accountIds: [] };

describe('GET /api/resource-graph', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockAuthorize.mockResolvedValue(null);
        mockGetResourceDependencies.mockResolvedValue(EMPTY);
        mockResolveResourceType.mockResolvedValue('ec2_instances');
        mockListAccounts.mockResolvedValue([
            { accountId: 'acc-1', lastSyncedAt: '2026-08-11T00:00:00.000Z' },
        ]);
    });

    it('rejects when RBAC denies', async () => {
        mockAuthorize.mockResolvedValue({ _data: { error: 'forbidden' }, _status: 403 });
        const res = await GET(req('resourceType=ec2_instances&resourceId=i-1'));
        expect((res as never as { _status: number })._status).toBe(403);
        expect(mockGetResourceDependencies).not.toHaveBeenCalled();
    });

    it('400s without resourceId', async () => {
        const res = await GET(req('resourceType=ec2_instances'));
        expect((res as never as { _status: number })._status).toBe(400);
    });

    // Not 404: the UI must still render asOf for an undiscovered resource.
    it('returns 200 with focus.exists false when the resource is not in inventory', async () => {
        mockResolveResourceType.mockResolvedValue(null);
        const res = await GET(req('resourceType=ec2_instances&resourceId=i-nope'));
        const body = (res as never as { _data: { data: { focus: { exists: boolean } } } })._data;
        expect((res as never as { _status: number })._status).toBe(200);
        expect(body.data.focus.exists).toBe(false);
    });

    it('reports the oldest lastSyncedAt across the accounts represented', async () => {
        mockGetResourceDependencies.mockResolvedValue({ ...EMPTY, accountIds: ['acc-1', 'acc-2'] });
        mockListAccounts.mockResolvedValue([
            { accountId: 'acc-1', lastSyncedAt: '2026-08-11T00:00:00.000Z' },
            { accountId: 'acc-2', lastSyncedAt: '2026-08-04T00:00:00.000Z' },
        ]);

        const res = await GET(req('resourceType=ec2_instances&resourceId=i-1'));
        const { asOf } = (res as never as { _data: { data: { asOf: {
            oldestSyncedAt: string | null; accountsRepresented: number; neverScanned: boolean } } } })._data.data;

        expect(asOf.oldestSyncedAt).toBe('2026-08-04T00:00:00.000Z');
        expect(asOf.accountsRepresented).toBe(2);
        expect(asOf.neverScanned).toBe(false);
    });

    it('flags neverScanned when any represented account has no sync time', async () => {
        mockGetResourceDependencies.mockResolvedValue({ ...EMPTY, accountIds: ['acc-1', 'acc-3'] });
        mockListAccounts.mockResolvedValue([
            { accountId: 'acc-1', lastSyncedAt: '2026-08-11T00:00:00.000Z' },
            { accountId: 'acc-3', lastSyncedAt: null },
        ]);

        const res = await GET(req('resourceType=ec2_instances&resourceId=i-1'));
        const { asOf } = (res as never as { _data: { data: { asOf: { neverScanned: boolean } } } })._data.data;
        expect(asOf.neverScanned).toBe(true);
    });
});
