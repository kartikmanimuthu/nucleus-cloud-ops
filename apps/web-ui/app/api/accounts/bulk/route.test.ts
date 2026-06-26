import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockUpdate = vi.hoisted(() => vi.fn());
const mockValidate = vi.hoisted(() => vi.fn());
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
vi.mock('@/lib/account-service', () => ({
    AccountService: { updateAccount: mockUpdate, validateAccount: mockValidate },
}));

import { POST } from './route';

const makeRequest = (body: unknown) =>
    ({ json: vi.fn().mockResolvedValue(body) }) as any;

describe('POST /api/accounts/bulk', () => {
    beforeEach(() => {
        mockUpdate.mockReset().mockResolvedValue({});
        mockValidate.mockReset().mockResolvedValue({});
        mockAuthorize.mockReset().mockResolvedValue(null);
    });

    it('rejects an unsupported action', async () => {
        const res = await POST(makeRequest({ action: 'nuke', accountIds: ['a'] }));
        expect(res._status).toBe(400);
        expect(res._data.success).toBe(false);
    });

    it('rejects an empty id list', async () => {
        const res = await POST(makeRequest({ action: 'activate', accountIds: [] }));
        expect(res._status).toBe(400);
    });

    it('returns the authorize() response when not permitted', async () => {
        mockAuthorize.mockResolvedValue({ _status: 403, _data: { error: 'Forbidden' } });
        const res = await POST(makeRequest({ action: 'activate', accountIds: ['a'] }));
        expect(res._status).toBe(403);
        expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('activate sets active:true for every id', async () => {
        await POST(makeRequest({ action: 'activate', accountIds: ['a', 'b'] }));
        expect(mockUpdate).toHaveBeenCalledTimes(2);
        expect(mockUpdate.mock.calls[0][1]).toMatchObject({ active: true });
    });

    it('reports partial success when one item fails', async () => {
        mockUpdate
            .mockResolvedValueOnce({})
            .mockRejectedValueOnce(new Error('boom'));
        const res = await POST(makeRequest({ action: 'deactivate', accountIds: ['a', 'b'] }));
        expect(res._status).toBe(200);
        expect(res._data.data.total).toBe(2);
        expect(res._data.data.succeeded).toBe(1);
        expect(res._data.data.failed).toBe(1);
        const failed = res._data.data.results.find((r: any) => r.status === 'error');
        expect(failed.error).toBe('boom');
    });

    it('validate routes to validateAccount', async () => {
        await POST(makeRequest({ action: 'validate', accountIds: ['a'] }));
        expect(mockValidate).toHaveBeenCalledTimes(1);
        expect(mockUpdate).not.toHaveBeenCalled();
    });
});
