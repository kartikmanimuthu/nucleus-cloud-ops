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

import { GET, PATCH } from './route';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId, getSessionUserId } from '@/lib/auth-session';
import { RightSizingService } from '@/lib/right-sizing-service';

const makeParams = (id: string) => ({ params: Promise.resolve({ id }) }) as any;
const makeRequest = () => ({}) as any;
const makePatchRequest = (body: unknown) => ({ json: vi.fn().mockResolvedValue(body) }) as any;

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSessionTenantId).mockResolvedValue('tenant-a');
    vi.mocked(getSessionUserId).mockResolvedValue('user-1');
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

    it('returns 500 when the service throws', async () => {
        vi.mocked(RightSizingService.getRecommendationDetail).mockRejectedValue(new Error('DB down'));
        const res = await GET(makeRequest(), makeParams('rec-1'));
        expect((res as any)._status).toBe(500);
    });
});

describe('PATCH /api/right-sizing/recommendations/[id]', () => {
    it('returns 403 when authorize denies', async () => {
        vi.mocked(authorize).mockResolvedValue({ status: 403, _data: { error: 'Forbidden' }, _status: 403 } as any);

        const res = await PATCH(makePatchRequest({ status: 'approved' }), makeParams('rec-1'));

        expect(res).toEqual({ status: 403, _data: { error: 'Forbidden' }, _status: 403 });
        expect(RightSizingService.updateStatus).not.toHaveBeenCalled();
    });

    it('returns 400 when status is missing', async () => {
        const res = await PATCH(makePatchRequest({}), makeParams('rec-1'));
        expect((res as any)._status).toBe(400);
    });

    it('tolerates an unparsable body and returns 400 for missing status', async () => {
        const res = await PATCH({ json: vi.fn().mockRejectedValue(new Error('bad json')) } as any, makeParams('rec-1'));
        expect((res as any)._status).toBe(400);
    });

    it('updates the status scoped by tenant and user, with no snooze date', async () => {
        vi.mocked(RightSizingService.updateStatus).mockResolvedValue({ id: 'rec-1', status: 'approved' } as any);

        const res = await PATCH(makePatchRequest({ status: 'approved' }), makeParams('rec-1'));

        expect(RightSizingService.updateStatus).toHaveBeenCalledWith('rec-1', 'tenant-a', 'approved', 'user-1', null);
        expect((res as any)._status).toBe(200);
        expect((res as any)._data).toEqual({ success: true, data: { id: 'rec-1', status: 'approved' } });
    });

    it('parses snoozeUntil into a Date when provided', async () => {
        vi.mocked(RightSizingService.updateStatus).mockResolvedValue({ id: 'rec-1', status: 'snoozed' } as any);

        await PATCH(makePatchRequest({ status: 'snoozed', snoozeUntil: '2026-02-01T00:00:00Z' }), makeParams('rec-1'));

        expect(RightSizingService.updateStatus).toHaveBeenCalledWith(
            'rec-1', 'tenant-a', 'snoozed', 'user-1', new Date('2026-02-01T00:00:00Z'),
        );
    });

    it('maps a NOT_FOUND error to a generic 404 (no cross-tenant leak)', async () => {
        vi.mocked(RightSizingService.updateStatus).mockRejectedValue(new Error('NOT_FOUND'));
        const res = await PATCH(makePatchRequest({ status: 'approved' }), makeParams('rec-missing'));
        expect((res as any)._status).toBe(404);
        expect((res as any)._data.error).toBe('Recommendation not found');
    });

    it('maps an "Invalid status" error to 400', async () => {
        vi.mocked(RightSizingService.updateStatus).mockRejectedValue(new Error('Invalid status transition'));
        const res = await PATCH(makePatchRequest({ status: 'bogus' }), makeParams('rec-1'));
        expect((res as any)._status).toBe(400);
    });

    it('maps a "not supported" error to 400', async () => {
        vi.mocked(RightSizingService.updateStatus).mockRejectedValue(new Error('Transition not supported'));
        const res = await PATCH(makePatchRequest({ status: 'approved' }), makeParams('rec-1'));
        expect((res as any)._status).toBe(400);
    });

    it('returns 500 for other errors', async () => {
        vi.mocked(RightSizingService.updateStatus).mockRejectedValue(new Error('DB down'));
        const res = await PATCH(makePatchRequest({ status: 'approved' }), makeParams('rec-1'));
        expect((res as any)._status).toBe(500);
    });
});
