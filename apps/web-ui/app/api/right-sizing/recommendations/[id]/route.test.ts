import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/server', () => ({
    NextRequest: vi.fn(),
    NextResponse: {
        json: vi.fn((data: unknown, init?: { status?: number }) => ({
            _data: data,
            _status: init?.status ?? 200,
            status: init?.status ?? 200,
            json: async () => data,
        })),
    },
}));

vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({
    getSessionTenantId: vi.fn(),
    getSessionUserId: vi.fn(),
}));
vi.mock('@/lib/right-sizing-service', () => ({
    RightSizingService: {
        getRecommendationDetail: vi.fn(),
        updateStatus: vi.fn(),
    },
}));

import { GET } from './route';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { RightSizingService } from '@/lib/right-sizing-service';

const makeParams = (id: string) => ({ params: Promise.resolve({ id }) }) as any;
const makeRequest = () => ({}) as any;

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSessionTenantId).mockResolvedValue('tenant-a');
    vi.mocked(authorize).mockResolvedValue(null);
});

describe('GET /api/right-sizing/recommendations/[id]', () => {
    it('returns 200 with the composed detail on success', async () => {
        const detail = {
            recommendation: { id: 'rec-1', tenantId: 'tenant-a' },
            resource: { id: 'inv-1' },
            account: { id: 'acc-1' },
        };
        vi.mocked(RightSizingService.getRecommendationDetail).mockResolvedValue(detail as any);

        const res = await GET(makeRequest(), makeParams('rec-1'));

        expect((res as any)._status).toBe(200);
        expect((res as any)._data.success).toBe(true);
        expect((res as any)._data.data).toEqual(detail);
        expect(RightSizingService.getRecommendationDetail).toHaveBeenCalledWith('rec-1', 'tenant-a');
    });

    it('returns 404 when the recommendation is not found', async () => {
        vi.mocked(RightSizingService.getRecommendationDetail).mockResolvedValue(null);

        const res = await GET(makeRequest(), makeParams('missing'));

        expect((res as any)._status).toBe(404);
        expect((res as any)._data.success).toBe(false);
        expect((res as any)._data.error).toBe('Recommendation not found');
    });

    it('returns 403 when authorize denies', async () => {
        vi.mocked(authorize).mockResolvedValue({ status: 403, _data: { error: 'Forbidden' }, _status: 403 } as any);

        const res = await GET(makeRequest(), makeParams('rec-1'));

        expect(res).toEqual({ status: 403, _data: { error: 'Forbidden' }, _status: 403 });
    });
});
