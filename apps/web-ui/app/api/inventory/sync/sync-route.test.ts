import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSend = vi.hoisted(() => vi.fn().mockResolvedValue('job-123'));

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
vi.mock('@/lib/auth-session', () => ({
    getSessionTenantId: vi.fn().mockResolvedValue('tenant-abc'),
}));
vi.mock('@/lib/audit-service', () => ({
    AuditService: { logResourceAction: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('@/lib/boss-client', () => ({
    getBoss: vi.fn().mockResolvedValue({ send: mockSend }),
}));

import { POST } from './route';

const makeRequest = (body: unknown) =>
    ({ json: vi.fn().mockResolvedValue(body) }) as any;

describe('POST /api/inventory/sync', () => {
    beforeEach(() => { mockSend.mockClear(); });

    it('uses tenant-scoped singleton key when no accountId', async () => {
        await POST(makeRequest({}));
        const [, , opts] = mockSend.mock.calls[0];
        expect(opts.singletonKey).toBe('tenant:tenant-abc');
    });

    it('uses account-scoped singleton key when accountId provided', async () => {
        await POST(makeRequest({ accountId: 'acc-111' }));
        const [, , opts] = mockSend.mock.calls[0];
        expect(opts.singletonKey).toBe('tenant:tenant-abc:account:acc-111');
    });

    it('returns 200 with jobId and scanId on success', async () => {
        const res = await POST(makeRequest({ accountId: 'acc-111' }));
        expect(res._status).toBe(200);
        expect(res._data.success).toBe(true);
        expect(res._data.jobId).toBe('job-123');
    });
});
