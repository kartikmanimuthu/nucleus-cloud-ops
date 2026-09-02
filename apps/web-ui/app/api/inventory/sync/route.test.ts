import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/audit-service', () => ({ AuditService: { logResourceAction: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/boss-client', () => ({ getBoss: vi.fn() }));
vi.mock('next-auth', () => ({ getServerSession: vi.fn() }));
vi.mock('@/app/api/auth/[...nextauth]/route', () => ({ authOptions: {} }));

import { AuditService } from '@/lib/audit-service';
import { getSessionTenantId } from '@/lib/auth-session';
import { getBoss } from '@/lib/boss-client';
import { getServerSession } from 'next-auth';
import { POST } from './route';

const makeRequest = (body: unknown) => ({ json: vi.fn().mockResolvedValue(body) }) as any;
const mockBoss = { send: vi.fn() };

describe('POST /api/inventory/sync', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(getServerSession).mockResolvedValue({ user: { email: 'a@b.co' } } as any);
        vi.mocked(getBoss).mockResolvedValue(mockBoss as any);
    });

    it('triggers a full-tenant scan with a tenant-scoped singleton key when no accountId is given', async () => {
        mockBoss.send.mockResolvedValue('job-1');
        const res = await POST(makeRequest({}));
        const body = await res.json();

        expect(mockBoss.send).toHaveBeenCalledWith(
            'discovery-scan',
            expect.objectContaining({ tenantId: 'tenant-1', accountId: undefined, triggeredBy: 'web-ui', userEmail: 'a@b.co' }),
            expect.objectContaining({ singletonKey: 'tenant:tenant-1' }),
        );
        expect(res.status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.jobId).toBe('job-1');
        expect(AuditService.logResourceAction).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'scan_triggered', status: 'success' })
        );
    });

    it('scopes the singleton key to a specific account when accountId is given', async () => {
        mockBoss.send.mockResolvedValue('job-2');
        await POST(makeRequest({ accountId: 'acc-1' }));
        expect(mockBoss.send).toHaveBeenCalledWith(
            'discovery-scan',
            expect.objectContaining({ accountId: 'acc-1' }),
            expect.objectContaining({ singletonKey: 'tenant:tenant-1:account:acc-1' }),
        );
    });

    it('returns 500 and logs a failure audit event when pg-boss returns no jobId', async () => {
        mockBoss.send.mockResolvedValue(null);
        const res = await POST(makeRequest({}));
        const body = await res.json();

        expect(res.status).toBe(500);
        expect(body.error).toContain('already queued');
        expect(AuditService.logResourceAction).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'scan_failed', status: 'error' })
        );
    });

    it('tolerates an unparsable request body, defaulting to a full scan', async () => {
        mockBoss.send.mockResolvedValue('job-3');
        const res = await POST({ json: vi.fn().mockRejectedValue(new Error('bad json')) } as any);
        expect(res.status).toBe(200);
        expect(mockBoss.send).toHaveBeenCalledWith('discovery-scan', expect.objectContaining({ accountId: undefined }), expect.anything());
    });

    it('returns 500 when a dependency throws', async () => {
        vi.mocked(getSessionTenantId).mockRejectedValue(new Error('Unauthenticated'));
        const res = await POST(makeRequest({}));
        expect(res.status).toBe(500);
    });
});
