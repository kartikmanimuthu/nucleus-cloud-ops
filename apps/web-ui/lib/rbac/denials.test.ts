import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) } }));

import { AuditService } from '@/lib/audit-service';
import { recordDenial, resetDenialBuckets, type DenialContext } from './denials';

const CTX: DenialContext = {
    userId: 'u1', email: 'a@b.co', tenantId: 'tenant-1', roleName: 'Viewer', action: 'delete', subject: 'Account',
};

describe('recordDenial', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetDenialBuckets();
    });

    it('logs a warning-level authorization audit event', async () => {
        await recordDenial(CTX);
        expect(AuditService.logUserAction).toHaveBeenCalledWith(expect.objectContaining({
            action: 'rbac.access.denied', status: 'warning', tenantId: 'tenant-1',
            eventType: 'authorization', severity: 'low',
        }));
    });

    it('includes the reason in the details string when provided', async () => {
        await recordDenial({ ...CTX, reason: 'no matching rule' });
        const call = vi.mocked(AuditService.logUserAction).mock.calls[0][0];
        expect(call.details).toContain('no matching rule');
    });

    it('never throws when the audit write fails', async () => {
        vi.mocked(AuditService.logUserAction).mockRejectedValue(new Error('DB down'));
        await expect(recordDenial(CTX)).resolves.toBeUndefined();
    });

    it('logs every denial up to the per-window cap', async () => {
        for (let i = 0; i < 50; i++) await recordDenial(CTX);
        expect(AuditService.logUserAction).toHaveBeenCalledTimes(50);
    });

    it('samples 1-in-20 once the per-window cap is exceeded', async () => {
        for (let i = 0; i < 70; i++) await recordDenial(CTX);
        // 50 logged in full (count 1-50), then only the count=60 call (the one
        // multiple of 20 between 51 and 70) is sampled through.
        expect(AuditService.logUserAction).toHaveBeenCalledTimes(51);
    });

    it('marks a sampled-through denial with its sample weight', async () => {
        for (let i = 0; i < 60; i++) await recordDenial(CTX);
        const lastCall = vi.mocked(AuditService.logUserAction).mock.calls.at(-1)![0];
        expect(lastCall.metadata).toEqual(expect.objectContaining({ sampleWeight: 20 }));
    });

    it('resets the count once the time window elapses', async () => {
        vi.useFakeTimers();
        try {
            for (let i = 0; i < 50; i++) await recordDenial(CTX);
            vi.advanceTimersByTime(61_000);
            await recordDenial(CTX);
            expect(AuditService.logUserAction).toHaveBeenCalledTimes(51);
        } finally {
            vi.useRealTimers();
        }
    });

    it('tracks separate windows per tenant', async () => {
        for (let i = 0; i < 55; i++) await recordDenial(CTX); // tenant-1: 50 logged + sampling starts
        for (let i = 0; i < 5; i++) await recordDenial({ ...CTX, tenantId: 'tenant-2' }); // fresh window
        const tenant2Calls = vi.mocked(AuditService.logUserAction).mock.calls.filter(([c]) => c.tenantId === 'tenant-2');
        expect(tenant2Calls).toHaveLength(5);
    });
});
