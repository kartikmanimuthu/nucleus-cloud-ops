import { describe, it, expect } from 'vitest';
import { inventoryIdentityKeys, normalizeActivity } from './normalize.js';
import type { RawScalingActivity } from '../types.js';

// The exact pair of identifiers the two subsystems produce for one real service,
// captured from ap-south-1 on 2026-08-05. Discovery stores the ARN (its idKeys
// check 'serviceArn' before 'serviceName'); Application Auto Scaling reports the
// short form. They are the same resource.
const ECS_SERVICE_ARN = 'arn:aws:ecs:ap-south-1:688849551607:service/stx-kyc-ekyc-ecs-fargate/stx-kyc-ekyc-admin-api';
const ECS_AAS_RESOURCE_ID = 'service/stx-kyc-ekyc-ecs-fargate/stx-kyc-ekyc-admin-api';
const ECS_SERVICE_NAME = 'stx-kyc-ekyc-admin-api';

describe('inventoryIdentityKeys', () => {
    it('expands an ECS service ARN to the Application Auto Scaling form and the bare name', () => {
        const keys = inventoryIdentityKeys(ECS_SERVICE_ARN);
        expect(keys).toContain(ECS_SERVICE_ARN);
        expect(keys).toContain(ECS_AAS_RESOURCE_ID);
        expect(keys).toContain(ECS_SERVICE_NAME);
    });

    it('expands the Application Auto Scaling form to the bare service name', () => {
        expect(inventoryIdentityKeys(ECS_AAS_RESOURCE_ID)).toEqual([ECS_AAS_RESOURCE_ID, ECS_SERVICE_NAME]);
    });

    it('leaves a bare ASG group name untouched — no spurious extra keys', () => {
        expect(inventoryIdentityKeys('nucleus-scale-sentinel-test-asg')).toEqual(['nucleus-scale-sentinel-test-asg']);
    });

    it('does not treat a non-ECS ARN as an ECS service ARN', () => {
        const asgArn = 'arn:aws:autoscaling:ap-south-1:688849551607:autoScalingGroup:uuid:autoScalingGroupName/my-asg';
        expect(inventoryIdentityKeys(asgArn)).not.toContain('service/my-asg');
    });
});

describe('normalizeActivity — inventoryMatched', () => {
    const ecsActivity: RawScalingActivity = {
        activityId: 'be94d126-3f1b-4ac8-8cf7-176f074259e8',
        resourceId: ECS_AAS_RESOURCE_ID,
        clusterName: 'stx-kyc-ekyc-ecs-fargate',
        serviceName: ECS_SERVICE_NAME,
        cause: 'monitor alarm TargetTracking-x in state ALARM triggered policy cpu',
        description: 'Setting desired count to 1.',
        statusCode: 'Successful',
        startedAt: new Date('2026-07-28T21:50:40.227Z'),
        rawPayload: {},
    };

    const ctx = (ids: string[]) => ({
        tenantId: 't1',
        accountId: '688849551607',
        region: 'ap-south-1',
        scope: 'ecs' as const,
        source: 'aws_api' as const,
        inventoryResourceIds: new Set(ids.flatMap(inventoryIdentityKeys)),
    });

    it('matches an ECS activity against an inventory row stored as an ARN', () => {
        // This is the regression: before expanding identities, the ARN in inventory
        // and the AAS resourceId on the activity never compared equal, so every ECS
        // row reported "resource not found in current inventory".
        expect(normalizeActivity(ecsActivity, ctx([ECS_SERVICE_ARN])).inventoryMatched).toBe(true);
    });

    it('still matches when inventory happens to hold the bare service name', () => {
        expect(normalizeActivity(ecsActivity, ctx([ECS_SERVICE_NAME])).inventoryMatched).toBe(true);
    });

    it('reports unmatched for a service genuinely absent from inventory', () => {
        const other = 'arn:aws:ecs:ap-south-1:688849551607:service/other-cluster/other-svc';
        expect(normalizeActivity(ecsActivity, ctx([other])).inventoryMatched).toBe(false);
    });

    it('matches a CloudTrail-sourced ECS row against an ARN-stored inventory row', () => {
        // CloudTrail builds resourceId in the Application Auto Scaling form, so it
        // must resolve against inventory exactly as an aws_api row does.
        const ctActivity: RawScalingActivity = {
            activityId: 'evt-abc',
            resourceId: ECS_AAS_RESOURCE_ID,
            clusterName: 'stx-kyc-ekyc-ecs-fargate',
            serviceName: ECS_SERVICE_NAME,
            cause: '[CloudTrail] UpdateService called by arn:aws:iam::688849551607:user/alice',
            description: 'Setting desired count to 2.',
            statusCode: 'Successful',
            startedAt: new Date('2026-08-05T16:00:00Z'),
            rawPayload: {},
            actor: 'arn:aws:iam::688849551607:user/alice',
            actorType: 'user',
            scalingTypeOverride: 'direct_api',
        };
        const result = normalizeActivity(ctActivity, { ...ctx([ECS_SERVICE_ARN]), source: 'cloudtrail' as const });
        expect(result.inventoryMatched).toBe(true);
        // Per-event attribution from the source beats the scan-wide context.
        expect(result.actor).toBe('arn:aws:iam::688849551607:user/alice');
        expect(result.actorType).toBe('user');
        // Describes the MECHANISM only. Deliberately not 'manual': an AssumedRole
        // may be a pipeline, so asserting a human would be an unfounded inference.
        expect(result.scalingType).toBe('direct_api');
        expect(result.desiredAfter).toBe(2);
    });

    it('matches an ASG activity by bare group name', () => {
        const asgActivity: RawScalingActivity = {
            activityId: 'a1',
            resourceId: 'nucleus-scale-sentinel-test-asg',
            asgName: 'nucleus-scale-sentinel-test-asg',
            cause: 'a user request explicitly set group desired capacity changing the desired capacity from 1 to 2.',
            startedAt: new Date('2026-08-05T10:35:16.161Z'),
            rawPayload: {},
        };
        const asgCtx = { ...ctx(['nucleus-scale-sentinel-test-asg']), scope: 'asg' as const };
        expect(normalizeActivity(asgActivity, asgCtx).inventoryMatched).toBe(true);
    });
});

describe('normalizeActivity — desiredBeforeSource (SA-003)', () => {
    const ctx = {
        tenantId: 't1', accountId: '688849551607', region: 'ap-south-1',
        scope: 'asg' as const, source: 'aws_api' as const, inventoryResourceIds: new Set<string>(),
    };

    it("tags 'activity' when the Cause text itself names the prior value", () => {
        const asgActivity: RawScalingActivity = {
            activityId: 'a1',
            resourceId: 'my-asg',
            asgName: 'my-asg',
            cause: 'a user request explicitly set group desired capacity changing the desired capacity from 1 to 2.',
            startedAt: new Date('2026-08-05T10:35:16.161Z'),
            rawPayload: {},
        };
        const result = normalizeActivity(asgActivity, ctx);
        expect(result.desiredBefore).toBe(1);
        expect(result.desiredBeforeSource).toBe('activity');
    });

    it('leaves desiredBeforeSource unset (not cloudwatch) when the activity carries no prior value — that is index.ts\'s enrichment step to fill', () => {
        // CloudTrail's synthesized prose ("Setting desired count to N.") never
        // states a range — this is the primary motivating case for SA-003.
        const ctActivity: RawScalingActivity = {
            activityId: 'evt-1',
            resourceId: 'service/my-cluster/my-svc',
            clusterName: 'my-cluster',
            serviceName: 'my-svc',
            cause: '[CloudTrail] UpdateService called by arn:aws:iam::1:user/alice',
            description: 'Setting desired count to 2.',
            startedAt: new Date('2026-08-05T16:00:00Z'),
            rawPayload: {},
            scalingTypeOverride: 'direct_api',
        };
        const result = normalizeActivity(ctActivity, { ...ctx, scope: 'ecs', source: 'cloudtrail' });
        expect(result.desiredBefore).toBeUndefined();
        expect(result.desiredBeforeSource).toBeUndefined();
        expect(result.desiredAfter).toBe(2);
    });
});
