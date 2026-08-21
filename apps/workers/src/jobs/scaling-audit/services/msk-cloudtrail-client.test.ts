import { describe, it, expect } from 'vitest';
import { toRawActivity } from './msk-cloudtrail-client.js';
import { isHumanPrincipal, isPlatformPrincipal } from './cloudtrail-client.js';

const CLUSTER_ARN = 'arn:aws:kafka:ap-south-1:123456789012:cluster/my-cluster/abcd1234-abcd-1234-abcd-1234567890ab-2';

function event(partial: {
    eventID?: string;
    eventName?: string;
    eventTime?: string;
    errorCode?: string;
    errorMessage?: string;
    userIdentity?: Record<string, unknown>;
    requestParameters?: Record<string, unknown>;
}) {
    return {
        eventID: 'evt-1',
        eventName: 'UpdateBrokerCount',
        eventTime: '2026-01-01T00:00:00Z',
        userIdentity: { type: 'IAMUser', arn: 'arn:aws:iam::123456789012:user/alice' },
        requestParameters: { clusterArn: CLUSTER_ARN, targetNumberOfBrokerNodes: 6 },
        ...partial,
    };
}

describe('toRawActivity — MSK CloudTrail mapping', () => {
    it('derives resourceId from the cluster ARN embedded name, matching msk-operations-client', () => {
        const activity = toRawActivity(event({}));
        expect(activity?.resourceId).toBe('my-cluster');
        expect(activity?.clusterName).toBe('my-cluster');
    });

    it('falls back to the raw ARN when the name cannot be parsed out of it', () => {
        const activity = toRawActivity(event({ requestParameters: { clusterArn: 'not-a-cluster-arn' } }));
        expect(activity?.resourceId).toBe('not-a-cluster-arn');
    });

    it('uses the CloudTrail eventID as activityId — natural dedup key', () => {
        const activity = toRawActivity(event({ eventID: 'evt-xyz' }));
        expect(activity?.activityId).toBe('evt-xyz');
    });

    it('returns null when there is no eventID or eventTime', () => {
        expect(toRawActivity(event({ eventID: undefined }))).toBeNull();
        expect(toRawActivity(event({ eventTime: undefined }))).toBeNull();
    });

    it('returns null when requestParameters carry no clusterArn — not a cluster-scoped call', () => {
        expect(toRawActivity(event({ requestParameters: {} }))).toBeNull();
    });

    it.each([
        ['UpdateBrokerCount', { targetNumberOfBrokerNodes: 9 }, 'Setting broker count to 9.'],
        ['UpdateBrokerType', { targetInstanceType: 'kafka.m5.large' }, 'Setting broker instance type to kafka.m5.large.'],
        ['UpdateBrokerStorage', {}, 'Updating broker EBS storage size.'],
    ])('writes a readable description for %s', (eventName, extraParams, expectedDescription) => {
        const activity = toRawActivity(event({ eventName, requestParameters: { clusterArn: CLUSTER_ARN, ...extraParams } }));
        expect(activity?.description).toBe(expectedDescription);
    });

    it('synthesizes a [CloudTrail] cause naming the event and principal', () => {
        const activity = toRawActivity(event({ eventName: 'UpdateBrokerType' }));
        expect(activity?.cause).toBe('[CloudTrail] UpdateBrokerType called by arn:aws:iam::123456789012:user/alice');
    });

    it('marks a successful call terminal (Successful)', () => {
        const activity = toRawActivity(event({}));
        expect(activity?.statusCode).toBe('Successful');
    });

    it('marks a denied/errored call terminal too (errorCode -> Failed)', () => {
        const activity = toRawActivity(event({ errorCode: 'AccessDenied', errorMessage: 'not authorized' }));
        expect(activity?.statusCode).toBe('Failed');
        expect(activity?.statusMessage).toBe('AccessDenied: not authorized');
    });

    it('always sets scalingTypeOverride to direct_api — MSK has no other mechanism', () => {
        const activity = toRawActivity(event({}));
        expect(activity?.scalingTypeOverride).toBe('direct_api');
    });

    it('labels IAMUser/Root as user, everything else unattributed_out_of_band', () => {
        expect(toRawActivity(event({ userIdentity: { type: 'IAMUser', arn: 'arn:...' } }))?.actorType).toBe('user');
        expect(toRawActivity(event({ userIdentity: { type: 'Root', arn: 'arn:...' } }))?.actorType).toBe('user');
        expect(
            toRawActivity(event({ userIdentity: { type: 'AssumedRole', arn: 'arn:aws:sts::1:assumed-role/deploy/session' } }))?.actorType
        ).toBe('unattributed_out_of_band');
    });
});

describe('shared filters reused (not reimplemented) from cloudtrail-client.ts', () => {
    // These functions are imported directly per the task's instructions rather
    // than duplicated — this just pins that the import target still behaves as
    // expected for MSK's own event shapes.
    it('isHumanPrincipal keeps an IAMUser and drops an AWS-service-invoked call', () => {
        expect(isHumanPrincipal({ type: 'IAMUser', arn: 'arn:aws:iam::1:user/alice' })).toBe(true);
        expect(isHumanPrincipal({ type: 'AWSService' })).toBe(false);
    });

    it('isPlatformPrincipal recognizes this platform acting through the configured role', () => {
        const platformRoleArn = 'arn:aws:iam::688849551607:role/NucleusAccess-970547372609';
        const schedulerIdentity = {
            type: 'AssumedRole',
            arn: 'arn:aws:sts::688849551607:assumed-role/NucleusAccess-970547372609/scheduler-session',
            sessionContext: { sessionIssuer: { arn: platformRoleArn } },
        };
        expect(isPlatformPrincipal(schedulerIdentity, platformRoleArn)).toBe(true);
    });
});
