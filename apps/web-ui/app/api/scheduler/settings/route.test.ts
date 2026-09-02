import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/tenant-config-service', () => ({
    TenantConfigService: { getConfig: vi.fn(), saveConfig: vi.fn() },
}));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('next-auth', () => ({ getServerSession: vi.fn() }));
vi.mock('@/lib/auth-options', () => ({ authOptions: {} }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/boss-client', () => ({ getBoss: vi.fn() }));

import { TenantConfigService } from '@/lib/tenant-config-service';
import { AuditService } from '@/lib/audit-service';
import { getServerSession } from 'next-auth';
import { getSessionTenantId } from '@/lib/auth-session';
import { getBoss } from '@/lib/boss-client';
import { GET, PUT } from './route';

const makeRequest = (body: unknown) => ({ json: vi.fn().mockResolvedValue(body) }) as any;

describe('GET /api/scheduler/settings', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
    });

    it('returns 401 when there is no tenant context', async () => {
        vi.mocked(getSessionTenantId).mockResolvedValue('' as any);
        const res = await GET();
        expect(res.status).toBe(401);
    });

    it('defaults to a 30-minute interval when no config is saved', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue(null);

        const res = await GET();
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.data).toEqual({
            intervalMinutes: 30,
            cronExpression: '*/30 * * * *',
            status: 'active',
            source: 'pg-boss',
        });
    });

    it('returns the saved interval and its cron expression', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({ intervalMinutes: 5 });

        const res = await GET();
        const body = await res.json();

        expect(body.data.intervalMinutes).toBe(5);
        expect(body.data.cronExpression).toBe('*/5 * * * *');
    });

    it('maps a 60-minute interval to the hourly cron expression', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({ intervalMinutes: 60 });
        const res = await GET();
        const body = await res.json();
        expect(body.data.cronExpression).toBe('0 * * * *');
    });

    it('falls back to the 30-minute cron expression for an unrecognized stored interval', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({ intervalMinutes: 45 });
        const res = await GET();
        const body = await res.json();
        expect(body.data.intervalMinutes).toBe(45);
        expect(body.data.cronExpression).toBe('*/30 * * * *');
    });

    it('returns 500 when the service throws', async () => {
        vi.mocked(TenantConfigService.getConfig).mockRejectedValue(new Error('DB down'));
        const res = await GET();
        expect(res.status).toBe(500);
    });
});

describe('PUT /api/scheduler/settings', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(getServerSession).mockResolvedValue({ user: { email: 'a@b.co' } } as any);
        vi.mocked(getBoss).mockResolvedValue({ send: vi.fn().mockResolvedValue('job-1') } as any);
    });

    it('returns 401 when there is no tenant context', async () => {
        vi.mocked(getSessionTenantId).mockResolvedValue('' as any);
        const res = await PUT(makeRequest({ scheduleInterval: 15 }));
        expect(res.status).toBe(401);
    });

    it('returns 400 for an invalid scheduleInterval', async () => {
        const res = await PUT(makeRequest({ scheduleInterval: 7 }));
        const body = await res.json();
        expect(res.status).toBe(400);
        expect(body.error).toContain('Invalid scheduleInterval');
    });

    it('saves the config, notifies workers, logs an audit event, and returns 200', async () => {
        const res = await PUT(makeRequest({ scheduleInterval: 15 }));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.data.intervalMinutes).toBe(15);
        expect(TenantConfigService.saveConfig).toHaveBeenCalledWith(
            'scheduler-cron',
            { intervalMinutes: 15 },
            'tenant-1',
            'a@b.co'
        );
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'schedule.settings.updated', status: 'success' })
        );
    });

    it('still succeeds when notifying workers fails (non-fatal)', async () => {
        vi.mocked(getBoss).mockRejectedValue(new Error('queue down'));

        const res = await PUT(makeRequest({ scheduleInterval: 15 }));
        expect(res.status).toBe(200);
    });

    it('returns 500 and logs a failure audit event when saveConfig throws', async () => {
        vi.mocked(TenantConfigService.saveConfig).mockRejectedValue(new Error('DB down'));

        const res = await PUT(makeRequest({ scheduleInterval: 15 }));
        expect(res.status).toBe(500);
        expect(AuditService.logUserAction).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));
    });

    it('still returns 500 when the failure-path audit log itself throws', async () => {
        vi.mocked(TenantConfigService.saveConfig).mockRejectedValue(new Error('DB down'));
        vi.mocked(AuditService.logUserAction).mockRejectedValue(new Error('audit table down'));

        const res = await PUT(makeRequest({ scheduleInterval: 15 }));
        expect(res.status).toBe(500);
    });
});
