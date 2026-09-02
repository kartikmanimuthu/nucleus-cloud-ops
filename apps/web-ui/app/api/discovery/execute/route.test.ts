import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('next-auth', () => ({ getServerSession: vi.fn() }));
vi.mock('@/app/api/auth/[...nextauth]/route', () => ({ authOptions: {} }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('@/lib/boss-client', () => ({ getBoss: vi.fn() }));

import { authorize } from '@/lib/rbac/authorize';
import { getServerSession } from 'next-auth';
import { AuditService } from '@/lib/audit-service';
import { getBoss } from '@/lib/boss-client';
import { POST } from './route';

const makeRequest = (body: unknown = {}) => ({ json: vi.fn().mockResolvedValue(body) }) as any;

describe('POST /api/discovery/execute', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getServerSession).mockResolvedValue({
            user: { tenantId: 'tenant-1', email: 'a@b.co' },
        } as any);
    });

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);

        const res = await POST(makeRequest());
        expect(res).toBe(authError);
    });

    it('returns 403 when the session has no tenant context', async () => {
        vi.mocked(getServerSession).mockResolvedValue({ user: {} } as any);

        const res = await POST(makeRequest());
        const body = await res.json();

        expect(res.status).toBe(403);
        expect(body.error).toBe('No tenant context');
    });

    it('enqueues a discovery-scan job and logs a success audit event', async () => {
        const send = vi.fn().mockResolvedValue('job-1');
        vi.mocked(getBoss).mockResolvedValue({ send } as any);

        const res = await POST(makeRequest({ accountId: 'acc-1' }));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body).toEqual({ success: true, jobId: 'job-1' });
        expect(send).toHaveBeenCalledWith(
            'discovery-scan',
            expect.objectContaining({ type: 'scan', tenantId: 'tenant-1', accountId: 'acc-1' }),
            expect.objectContaining({ singletonKey: 'tenant:tenant-1' })
        );
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'inventory.discovery.triggered', status: 'success' })
        );
    });

    it('returns 409 when a scan is already queued (send returns null)', async () => {
        vi.mocked(getBoss).mockResolvedValue({ send: vi.fn().mockResolvedValue(null) } as any);

        const res = await POST(makeRequest());
        const body = await res.json();

        expect(res.status).toBe(409);
        expect(body.error).toContain('already queued');
    });

    it('returns 500 when getBoss throws', async () => {
        vi.mocked(getBoss).mockRejectedValue(new Error('queue down'));

        const res = await POST(makeRequest());
        expect(res.status).toBe(500);
    });
});
