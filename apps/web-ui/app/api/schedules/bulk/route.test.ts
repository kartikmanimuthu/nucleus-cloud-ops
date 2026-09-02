import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSetActive = vi.hoisted(() => vi.fn());
const mockExecute = vi.hoisted(() => vi.fn());
const mockAuthorize = vi.hoisted(() => vi.fn().mockResolvedValue(null));

vi.mock('next/server', () => ({
    NextRequest: vi.fn(),
    NextResponse: {
        json: vi.fn((data: unknown, init?: { status?: number }) => ({
            _data: data,
            _status: init?.status ?? 200,
        })),
    },
}));

vi.mock('@/lib/rbac/authorize', () => ({ authorize: mockAuthorize }));
vi.mock('@/lib/auth-session', () => ({
    getSessionTenantId: vi.fn().mockResolvedValue('tenant-abc'),
    getAuthSession: vi.fn().mockResolvedValue({ user: { email: 'u@x.com' } }),
}));
vi.mock('@/lib/schedule-service', () => ({
    ScheduleService: { setScheduleActive: mockSetActive, executeSchedule: mockExecute },
}));

import { getSessionTenantId } from '@/lib/auth-session';
import { POST } from './route';

const makeRequest = (body: unknown) =>
    ({ json: vi.fn().mockResolvedValue(body) }) as any;

describe('POST /api/schedules/bulk', () => {
    beforeEach(() => {
        mockSetActive.mockReset().mockResolvedValue({});
        mockExecute.mockReset().mockResolvedValue({ executionTime: 't' });
        mockAuthorize.mockReset().mockResolvedValue(null);
    });

    it('rejects an unsupported action', async () => {
        const res = await POST(makeRequest({ action: 'delete', scheduleIds: ['s'] }));
        expect(res._status).toBe(400);
    });

    it('returns 400 for a body that fails to parse as JSON', async () => {
        const req = { json: vi.fn().mockRejectedValue(new Error('bad json')) } as any;
        const res = await POST(req);
        expect(res._status).toBe(400);
        expect(res._data.error).toBe('Invalid JSON body');
    });

    it('returns 401 when the session tenant cannot be resolved', async () => {
        vi.mocked(getSessionTenantId).mockRejectedValueOnce(new Error('Unauthenticated'));
        const res = await POST(makeRequest({ action: 'activate', scheduleIds: ['s1'] }));
        expect(res._status).toBe(401);
    });

    it('rejects an empty id list', async () => {
        const res = await POST(makeRequest({ action: 'activate', scheduleIds: [] }));
        expect(res._status).toBe(400);
    });

    it('honors authorize() rejection', async () => {
        mockAuthorize.mockResolvedValue({ _status: 403, _data: { error: 'Forbidden' } });
        const res = await POST(makeRequest({ action: 'execute', scheduleIds: ['s'] }));
        expect(res._status).toBe(403);
        expect(mockExecute).not.toHaveBeenCalled();
    });

    it('activate sets explicit active:true (not a flip)', async () => {
        await POST(makeRequest({ action: 'activate', scheduleIds: ['s1', 's2'] }));
        expect(mockSetActive).toHaveBeenCalledTimes(2);
        expect(mockSetActive.mock.calls[0][1]).toBe(true);
    });

    it('deactivate sets explicit active:false (not a flip)', async () => {
        await POST(makeRequest({ action: 'deactivate', scheduleIds: ['s1'] }));
        expect(mockSetActive).toHaveBeenCalledWith('s1', false, 'u@x.com', 'tenant-abc');
    });

    it('execute routes to executeSchedule and reports partial success', async () => {
        mockExecute
            .mockResolvedValueOnce({ executionTime: 't' })
            .mockRejectedValueOnce(new Error('Schedule not found'));
        const res = await POST(makeRequest({ action: 'execute', scheduleIds: ['s1', 's2'] }));
        expect(res._status).toBe(200);
        expect(res._data.data.succeeded).toBe(1);
        expect(res._data.data.failed).toBe(1);
    });
});
