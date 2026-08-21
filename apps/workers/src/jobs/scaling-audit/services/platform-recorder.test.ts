// workers/src/jobs/scaling-audit/services/platform-recorder.test.ts
//
// Regression coverage for the per-account opt-in gap this session found in
// prod: recordPlatformScalingEvent() is called synchronously by the scheduler
// (ecs-scheduler.ts / asg-scheduler.ts) whenever it mutates an ASG/ECS
// resource, on a totally separate path from the AWS-poll scan in index.ts —
// one that never loaded getScalingAuditEligibleAccounts() and so had no way
// to know an account had switched Scale Sentinel off. It recorded compliance
// rows for those accounts anyway. This asserts the fix: the same per-account
// scalingAuditEnabled check the poll side already respects.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./db-writer.js', () => ({
    insertEvents: vi.fn(),
    isScalingAuditEnabledForAccount: vi.fn(),
}));

import { insertEvents, isScalingAuditEnabledForAccount } from './db-writer.js';
import { recordPlatformScalingEvent } from './platform-recorder.js';

const BASE_INPUT = {
    tenantId: 'tenant-1',
    accountId: '629065147865',
    region: 'ap-south-1',
    scope: 'ecs' as const,
    resourceId: 'service/cluster/svc',
    activityId: 'exec-1-svc-start',
    description: 'Scheduled start',
    statusCode: 'Successful' as const,
};

describe('recordPlatformScalingEvent', () => {
    beforeEach(() => {
        vi.mocked(insertEvents).mockReset();
        vi.mocked(isScalingAuditEnabledForAccount).mockReset();
    });

    it('does not record when the account has Scale Sentinel switched off', async () => {
        vi.mocked(isScalingAuditEnabledForAccount).mockResolvedValue(false);

        await recordPlatformScalingEvent(BASE_INPUT);

        expect(isScalingAuditEnabledForAccount).toHaveBeenCalledWith('tenant-1', '629065147865');
        expect(insertEvents).not.toHaveBeenCalled();
    });

    it('records when the account has opted in', async () => {
        vi.mocked(isScalingAuditEnabledForAccount).mockResolvedValue(true);

        await recordPlatformScalingEvent(BASE_INPUT);

        expect(insertEvents).toHaveBeenCalledTimes(1);
    });

    it('is a no-op with no tenantId, and never even asks about eligibility', async () => {
        await recordPlatformScalingEvent({ ...BASE_INPUT, tenantId: undefined });

        expect(isScalingAuditEnabledForAccount).not.toHaveBeenCalled();
        expect(insertEvents).not.toHaveBeenCalled();
    });
});
