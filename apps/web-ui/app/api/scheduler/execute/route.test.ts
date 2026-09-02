import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('next-auth/next', () => ({ getServerSession: vi.fn() }));
vi.mock('@/lib/auth-options', () => ({ authOptions: {} }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('@/lib/boss-client', () => ({ getBoss: vi.fn() }));

import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { getServerSession } from 'next-auth/next';
import { AuditService } from '@/lib/audit-service';
import { getBoss } from '@/lib/boss-client';
import { POST } from './route';

describe('POST /api/scheduler/execute', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(getServerSession).mockResolvedValue({ user: { email: 'a@b.co' } } as any);
    });

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);

        const res = await POST();
        expect(res).toBe(authError);
    });

    it('returns 401 when there is no tenant context', async () => {
        vi.mocked(getSessionTenantId).mockResolvedValue('' as any);

        const res = await POST();
        const body = await res.json();
        expect(res.status).toBe(401);
        expect(body.error).toBe('Unauthorized');
    });

    it('returns 500 when resolving the session throws outside the enqueue step', async () => {
        vi.mocked(getSessionTenantId).mockRejectedValue(new Error('session lookup failed'));

        const res = await POST();
        const body = await res.json();
        expect(res.status).toBe(500);
        expect(body.error).toBe('session lookup failed');
    });

    it('enqueues a full scan job and logs a success audit event', async () => {
        const send = vi.fn().mockResolvedValue('job-1');
        vi.mocked(getBoss).mockResolvedValue({ send } as any);

        const res = await POST();
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.isAsync).toBe(true);
        expect(send).toHaveBeenCalledWith(
            'scheduler-scan',
            expect.objectContaining({ triggeredBy: 'web-ui', tenantId: 'tenant-1' }),
            expect.objectContaining({ priority: 10, singletonKey: 'manual:tenant-1' })
        );
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ status: 'success', eventType: 'schedule.execution.triggered' })
        );
    });

    it('returns deduplicated: true when send returns null', async () => {
        vi.mocked(getBoss).mockResolvedValue({ send: vi.fn().mockResolvedValue(null) } as any);

        const res = await POST();
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.deduplicated).toBe(true);
    });

    it('returns 500 and logs a failure audit event when enqueue throws', async () => {
        vi.mocked(getBoss).mockRejectedValue(new Error('queue down'));

        const res = await POST();
        const body = await res.json();

        expect(res.status).toBe(500);
        expect(body.error).toBe('queue down');
        expect(AuditService.logUserAction).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));
    });
});
