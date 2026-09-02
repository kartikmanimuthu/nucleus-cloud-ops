import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/rbac/row-filter', () => ({ getReadRowFilter: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { getAuditLogs: vi.fn(), createAuditLog: vi.fn() } }));

import { authorize } from '@/lib/rbac/authorize';
import { getReadRowFilter } from '@/lib/rbac/row-filter';
import { getSessionTenantId } from '@/lib/auth-session';
import { AuditService } from '@/lib/audit-service';
import { GET, POST, DELETE } from './route';

const makeGetRequest = (search = '') => ({ url: `http://localhost/api/audit${search}` }) as any;
const makePostRequest = (body: unknown, headers: Record<string, string> = {}) => ({
    json: vi.fn().mockResolvedValue(body),
    headers: { get: (k: string) => headers[k] ?? null },
}) as any;

describe('GET /api/audit', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getReadRowFilter).mockResolvedValue(undefined as any);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
    });

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);

        const res = await GET(makeGetRequest());
        expect(res).toBe(authError);
        expect(AuditService.getAuditLogs).not.toHaveBeenCalled();
    });

    it('builds filters from query params, applies the row filter, and scopes by tenant', async () => {
        vi.mocked(getReadRowFilter).mockResolvedValue({ user: 'a@b.co' } as any);
        vi.mocked(AuditService.getAuditLogs).mockResolvedValue({ logs: [{ id: 'l1' }], nextPageToken: 'next' } as any);

        const res = await GET(makeGetRequest('?status=success&limit=10'));
        const body = await res.json();

        expect(AuditService.getAuditLogs).toHaveBeenCalledWith(
            expect.objectContaining({ status: 'success', limit: 10, rowFilter: { user: 'a@b.co' } }),
            'tenant-1',
        );
        expect(res.status).toBe(200);
        expect(body).toEqual({ success: true, data: [{ id: 'l1' }], nextPageToken: 'next', count: 1 });
    });

    it('returns 500 when the service throws', async () => {
        vi.mocked(AuditService.getAuditLogs).mockRejectedValue(new Error('DB down'));
        const res = await GET(makeGetRequest());
        expect(res.status).toBe(500);
    });
});

describe('POST /api/audit', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
    });

    it('creates an audit log scoped to the session tenant with request metadata', async () => {
        vi.mocked(AuditService.createAuditLog).mockResolvedValue(undefined as any);

        const res = await POST(makePostRequest({ action: 'x' }, { 'user-agent': 'jest', 'x-forwarded-for': '1.2.3.4' }));
        const body = await res.json();

        expect(AuditService.createAuditLog).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'x', tenantId: 'tenant-1', userAgent: 'jest', ipAddress: '1.2.3.4', source: 'platform' })
        );
        expect(res.status).toBe(200);
        expect(body.success).toBe(true);
    });

    it('returns 500 when creation fails', async () => {
        vi.mocked(AuditService.createAuditLog).mockRejectedValue(new Error('DB down'));
        const res = await POST(makePostRequest({ action: 'x' }));
        expect(res.status).toBe(500);
    });
});

describe('DELETE /api/audit', () => {
    it('returns 501 — audit logs are immutable', async () => {
        const res = await DELETE();
        expect(res.status).toBe(501);
    });
});
