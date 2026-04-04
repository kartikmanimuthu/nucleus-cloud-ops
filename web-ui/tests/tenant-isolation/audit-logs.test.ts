import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// Mock auth session — controls which tenant the test impersonates
vi.mock('@/lib/auth-session', () => ({
    getSessionTenantId: vi.fn(),
    getAuthSession: vi.fn(),
    getSessionUserId: vi.fn(),
}));

// Mock RBAC — always allow (testing data isolation, not permissions)
vi.mock('@/lib/rbac/authorize', () => ({
    authorize: vi.fn().mockResolvedValue(null),
}));

// Mock AuditService — route calls AuditService.getAuditLogs(filters, tenantId)
vi.mock('@/lib/audit-service', () => ({
    AuditService: {
        getAuditLogs: vi.fn(),
        createAuditLog: vi.fn().mockResolvedValue(undefined),
    },
}));

// Mock AWS config (DELETE handler uses getDynamoDBDocumentClient)
vi.mock('@/lib/aws-config', () => ({
    getDynamoDBDocumentClient: vi.fn().mockReturnValue({ send: vi.fn() }),
    AUDIT_TABLE_NAME: 'test-audit-table',
}));

import { getSessionTenantId } from '@/lib/auth-session';
import { AuditService } from '@/lib/audit-service';
import { GET } from '@/app/api/audit/route';

describe('Audit Logs API — cross-tenant isolation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(AuditService.getAuditLogs).mockResolvedValue({ logs: [], nextPageToken: undefined });
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-a');
    });

    it('GET passes tenant-a to AuditService.getAuditLogs — tenant-b data never queried', async () => {
        const req = new NextRequest('http://localhost:3000/api/audit');
        await GET(req);

        // Route calls AuditService.getAuditLogs(filters, tenantId) — tenantId is second arg
        expect(AuditService.getAuditLogs).toHaveBeenCalledWith(
            expect.any(Object),
            'tenant-a'
        );

        const calls = vi.mocked(AuditService.getAuditLogs).mock.calls;
        for (const [, tenantId] of calls) {
            expect(tenantId).not.toBe('tenant-b');
        }
    });

    it('switching session to tenant-b queries tenant-b only', async () => {
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-b');
        const req = new NextRequest('http://localhost:3000/api/audit');
        await GET(req);

        expect(AuditService.getAuditLogs).toHaveBeenCalledWith(
            expect.any(Object),
            'tenant-b'
        );
    });

    it('tenant-a session never triggers a tenant-b query', async () => {
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-a');
        const req = new NextRequest('http://localhost:3000/api/audit');
        await GET(req);

        const calls = vi.mocked(AuditService.getAuditLogs).mock.calls;
        const tenantIds = calls.map(([, id]) => id);
        expect(tenantIds).not.toContain('tenant-b');
    });

    it('returns error response when getSessionTenantId throws — no unscoped data returned', async () => {
        vi.mocked(getSessionTenantId).mockRejectedValue(new Error('No active session'));
        const req = new NextRequest('http://localhost:3000/api/audit');
        const response = await GET(req);

        expect(response.status).toBe(500);
        // AuditService must NOT have been called with any tenant
        expect(AuditService.getAuditLogs).not.toHaveBeenCalled();
    });
});
