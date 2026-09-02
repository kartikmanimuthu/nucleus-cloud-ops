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

const mockAuthorize = vi.hoisted(() => vi.fn());
const mockQueryGraph = vi.hoisted(() => vi.fn());

vi.mock('@/lib/rbac/authorize', () => ({ authorize: mockAuthorize }));
vi.mock('@/lib/db/repository-factory', () => ({
    getResourceGraphRepository: () => ({ queryGraph: mockQueryGraph }),
}));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: () => 'tenant-1' }));

import { GET } from './route';

const req = (qs: string) => ({ url: `http://localhost/api/resource-graph/query?${qs}` }) as never;

describe('GET /api/resource-graph/query', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockAuthorize.mockResolvedValue(null);
        mockQueryGraph.mockResolvedValue({ nodes: [], edges: [], total: 0, truncated: false });
    });

    it('400s a by-type request with no resourceType', async () => {
        const res = await GET(req('predicate=by-type')) as unknown as { _status: number; _data: { success: boolean; error: string } };
        expect(res._status).toBe(400);
        expect(res._data.success).toBe(false);
        expect(mockQueryGraph).not.toHaveBeenCalled();
    });

    it('400s a by-vpc request with no vpcId', async () => {
        const res = await GET(req('predicate=by-vpc')) as unknown as { _status: number; _data: { success: boolean } };
        expect(res._status).toBe(400);
        expect(mockQueryGraph).not.toHaveBeenCalled();
    });
});
