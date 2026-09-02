import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/server', () => ({
    NextRequest: vi.fn(),
    NextResponse: {
        json: vi.fn((data: unknown, init?: { status?: number }) => ({
            _data: data, _status: init?.status ?? 200,
        })),
    },
}));
vi.mock('next-auth', () => ({ getServerSession: vi.fn() }));
vi.mock('@/app/api/auth/[...nextauth]/route', () => ({ authOptions: {} }));

// vi.hoisted for the same reason as Task 3 — see app/api/accounts/bulk/route.test.ts.
const mockAuthorize = vi.hoisted(() => vi.fn());
const mockFindOne = vi.hoisted(() => vi.fn());

vi.mock('@/lib/rbac/authorize', () => ({ authorize: mockAuthorize }));
vi.mock('@/lib/db/repository-factory', () => ({
    getInventoryRepository: () => ({ findOne: mockFindOne }),
}));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: () => 'tenant-1' }));

import { GET } from './route';

const ctx = { params: Promise.resolve({ type: 'ec2_instances', id: 'i-1' }) };

describe('GET /api/inventory/resources/[type]/[id]', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockAuthorize.mockResolvedValue(null);
    });

    it('rejects when RBAC denies', async () => {
        mockAuthorize.mockResolvedValue({ _data: {}, _status: 403 });
        const res = await GET({} as never, ctx);
        expect((res as never as { _status: number })._status).toBe(403);
    });

    it('404s an unknown resource', async () => {
        mockFindOne.mockResolvedValue(null);
        const res = await GET({} as never, ctx);
        expect((res as never as { _status: number })._status).toBe(404);
    });

    it('returns tags and metadata so pivoted tabs are not degraded', async () => {
        mockFindOne.mockResolvedValue({
            resourceId: 'i-1', resourceType: 'ec2_instances', region: 'ap-south-1',
            accountId: 'acc-1', name: 'bastion', status: 'running',
            tags: { Name: 'bastion' }, metadata: { instanceType: 't3.micro' },
            discoveredAt: '2026-08-11T00:00:00.000Z',
        });

        const res = await GET({} as never, ctx);
        const body = (res as never as { _data: { data: { tags: unknown; metadata: unknown } } })._data;
        expect(body.data.tags).toEqual({ Name: 'bastion' });
        expect(body.data.metadata).toEqual({ instanceType: 't3.micro' });
    });
});
