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
const mockSummarise = vi.hoisted(() => vi.fn());
const mockGetSeed = vi.hoisted(() => vi.fn());

vi.mock('@/lib/rbac/authorize', () => ({ authorize: mockAuthorize }));

vi.mock('@/lib/db/repository-factory', () => ({
    getResourceGraphRepository: () => ({ summarise: mockSummarise, getSeed: mockGetSeed }),
}));

vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: () => 'tenant-1' }));

import { GET as summaryGet } from './summary/route';
import { GET as seedGet } from './seed/route';
import { parseFilters } from './graph-request';

const req = (qs: string) => ({ url: `http://localhost/api/resource-graph?${qs}` }) as never;

describe('resource graph routes', () => {
    beforeEach(() => {
        mockAuthorize.mockReset().mockResolvedValue(null);
        mockSummarise.mockReset().mockResolvedValue({ accounts: [], byResourceType: [], byRelation: [] });
        mockGetSeed.mockReset().mockResolvedValue({
            mode: 'full-account', nodes: [], edges: [], totalVisibleNodes: 0, truncated: false,
        });
    });

    it('guards the route with the ResourceGraph read permission', async () => {
        await summaryGet(req(''));
        expect(mockAuthorize).toHaveBeenCalledWith('read', 'ResourceGraph');
    });

    it('returns the authorize response untouched when it denies', async () => {
        const denied = { _data: { success: false }, _status: 403 };
        mockAuthorize.mockResolvedValue(denied);

        const res = await summaryGet(req(''));

        expect(res).toBe(denied);
        expect(mockSummarise).not.toHaveBeenCalled();
    });

    it('binds the tenant from the session, never from the query string', async () => {
        await summaryGet(req('tenantId=someone-else'));
        expect(mockSummarise).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-1' }));
    });

    it('rejects a seed request with no accountId', async () => {
        const res = await seedGet(req('')) as unknown as { _status: number };
        expect(res._status).toBe(400);
        expect(mockGetSeed).not.toHaveBeenCalled();
    });

    it('parses the opt-in filter flags', () => {
        const filters = parseFilters(new URL('http://x/?includeHiddenTypes=true').searchParams);
        expect(filters.includeHiddenTypes).toBe(true);
        expect(filters.includeObservation).toBeUndefined();
    });
});
