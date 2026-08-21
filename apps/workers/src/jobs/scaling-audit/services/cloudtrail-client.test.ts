import { describe, it, expect } from 'vitest';
import { isHumanPrincipal, isPlatformPrincipal, principalOf, ecsResourceId } from './cloudtrail-client.js';
import { classifyCause } from './cause-classifier.js';
import { inventoryIdentityKeys } from './normalize.js';

describe('isHumanPrincipal — keeps CloudTrail complementary, not redundant', () => {
    // Automated scaling appears in CloudTrail too, attributed to an AWS service.
    // Ingesting those would duplicate every policy-driven scale the activity APIs
    // already record with a far richer cause. This filter is what makes the
    // "combine both sources" design work.
    it.each([
        ['IAMUser', { type: 'IAMUser', arn: 'arn:aws:iam::1:user/alice' }],
        ['AssumedRole', { type: 'AssumedRole', arn: 'arn:aws:sts::1:assumed-role/dev/alice' }],
        ['FederatedUser', { type: 'FederatedUser', arn: 'arn:aws:sts::1:federated-user/bob' }],
        ['Root', { type: 'Root', arn: 'arn:aws:iam::1:root' }],
    ])('keeps a %s principal', (_label, identity) => {
        expect(isHumanPrincipal(identity)).toBe(true);
    });

    it('skips an AWSService principal (target-tracking scaling AWS performed itself)', () => {
        expect(isHumanPrincipal({ type: 'AWSService', arn: 'application-autoscaling.amazonaws.com' })).toBe(false);
    });

    it('skips anything invoked on behalf of an AWS service, even with a role identity', () => {
        // Scheduled actions surface as AssumedRole + invokedBy — without the
        // invokedBy check these would slip through and duplicate the scheduled
        // rows the activity API already captures.
        expect(
            isHumanPrincipal({ type: 'AssumedRole', arn: 'arn:aws:sts::1:assumed-role/x/y', invokedBy: 'application-autoscaling.amazonaws.com' })
        ).toBe(false);
    });

    it('skips a missing identity rather than assuming human', () => {
        expect(isHumanPrincipal(undefined)).toBe(false);
    });
});

describe('isPlatformPrincipal — this platform is not a human', () => {
    // Verbatim from sbx on 2026-08-05. Without this filter one account produced
    // 1010 rows from the platform's own scheduler against 19 genuinely human
    // ones, all mislabelled scalingType='manual' / actorType='user'.
    const PLATFORM_ROLE_ARN = 'arn:aws:iam::688849551607:role/NucleusAccess-970547372609';
    const schedulerIdentity = {
        type: 'AssumedRole',
        arn: 'arn:aws:sts::688849551607:assumed-role/NucleusAccess-970547372609/scheduler-session-688849551607-ap-south-1',
        sessionContext: { sessionIssuer: { arn: PLATFORM_ROLE_ARN } },
    };
    const humanIdentity = {
        type: 'AssumedRole',
        arn: 'arn:aws:sts::688849551607:assumed-role/AWSReservedSSO_stx-devops-admin-tefk_d1ff2c9bfba14ced/test-user@example.com',
        sessionContext: { sessionIssuer: { arn: 'arn:aws:iam::688849551607:role/AWSReservedSSO_stx-devops-admin-tefk_d1ff2c9bfba14ced' } },
    };

    it('identifies the platform scheduler via the session issuer ARN', () => {
        expect(isPlatformPrincipal(schedulerIdentity, PLATFORM_ROLE_ARN)).toBe(true);
    });

    it('still identifies it when sessionContext is absent, via the assumed-role name', () => {
        expect(isPlatformPrincipal({ type: 'AssumedRole', arn: schedulerIdentity.arn }, PLATFORM_ROLE_ARN)).toBe(true);
    });

    it('does NOT flag a real human on the same account', () => {
        expect(isPlatformPrincipal(humanIdentity, PLATFORM_ROLE_ARN)).toBe(false);
    });

    it('works with a renamed role — the ARN is configured, not pattern-matched', () => {
        // RoleName is a customer-overridable CloudFormation parameter.
        const renamed = 'arn:aws:iam::688849551607:role/AcmeCustomAuditRole';
        const identity = {
            type: 'AssumedRole',
            arn: 'arn:aws:sts::688849551607:assumed-role/AcmeCustomAuditRole/scheduler-session-x',
            sessionContext: { sessionIssuer: { arn: renamed } },
        };
        expect(isPlatformPrincipal(identity, renamed)).toBe(true);
        expect(isPlatformPrincipal(identity, PLATFORM_ROLE_ARN)).toBe(false);
    });

    it('is inert when no platform role is known — never guesses', () => {
        expect(isPlatformPrincipal(schedulerIdentity, undefined)).toBe(false);
    });

    it('the human passes BOTH gates; the scheduler passes only the first', () => {
        // isHumanPrincipal alone is insufficient — that was the actual defect.
        expect(isHumanPrincipal(schedulerIdentity)).toBe(true);
        expect(isPlatformPrincipal(schedulerIdentity, PLATFORM_ROLE_ARN)).toBe(true);
        expect(isHumanPrincipal(humanIdentity)).toBe(true);
        expect(isPlatformPrincipal(humanIdentity, PLATFORM_ROLE_ARN)).toBe(false);
    });
});

describe('principalOf', () => {
    it('prefers the direct ARN', () => {
        expect(principalOf({ type: 'IAMUser', arn: 'arn:aws:iam::1:user/alice', userName: 'alice' })).toBe('arn:aws:iam::1:user/alice');
    });

    it('falls back to the role that issued the session', () => {
        expect(
            principalOf({ type: 'AssumedRole', sessionContext: { sessionIssuer: { arn: 'arn:aws:iam::1:role/deploy' } } })
        ).toBe('arn:aws:iam::1:role/deploy');
    });

    it('never returns empty — attribution must always say something', () => {
        expect(principalOf({})).toBe('unknown');
    });
});

describe('ecsResourceId — must match the Application Auto Scaling form', () => {
    // The whole point: a CloudTrail row and an activity-API row for the same
    // service must carry the same resourceId, and must resolve against inventory
    // (which stores the service ARN).
    it('builds service/<cluster>/<service> from bare names', () => {
        expect(ecsResourceId({ cluster: 'my-cluster', service: 'my-svc' })?.resourceId).toBe('service/my-cluster/my-svc');
    });

    it('builds the same id when requestParameters carry full ARNs', () => {
        const ids = ecsResourceId({
            cluster: 'arn:aws:ecs:ap-south-1:1:cluster/my-cluster',
            service: 'arn:aws:ecs:ap-south-1:1:service/my-cluster/my-svc',
        });
        expect(ids?.resourceId).toBe('service/my-cluster/my-svc');
        expect(ids?.clusterName).toBe('my-cluster');
        expect(ids?.serviceName).toBe('my-svc');
    });

    it('assumes the default cluster when none is given, as ECS does', () => {
        expect(ecsResourceId({ service: 'my-svc' })?.resourceId).toBe('service/default/my-svc');
    });

    it('returns null when no service is named — not a capacity change', () => {
        expect(ecsResourceId({ cluster: 'c' })).toBeNull();
        expect(ecsResourceId(undefined)).toBeNull();
    });

    it('produces an id that resolves against an inventory-stored service ARN', () => {
        const built = ecsResourceId({ cluster: 'my-cluster', service: 'my-svc' })!;
        const inventoryKeys = new Set(inventoryIdentityKeys('arn:aws:ecs:ap-south-1:1:service/my-cluster/my-svc'));
        expect(inventoryKeys.has(built.resourceId)).toBe(true);
    });
});

describe('attribution asserts only what CloudTrail proves', () => {
    // Measured over 7 days in one live account, the principals issuing
    // ecs:UpdateService were: 32 another Nucleus deployment's scheduler, 8 CI/CD
    // CodePipeline roles, 6 real humans, 4 AWS service-linked. An AssumedRole is
    // therefore NOT evidence of a person, and an earlier version of this code
    // recorded all of them as scalingType='manual' / actorType='user'.
    it('IAMUser and Root are the only identities that name a person outright', () => {
        expect(['IAMUser', 'Root'].includes('IAMUser')).toBe(true);
        expect(['IAMUser', 'Root'].includes('AssumedRole')).toBe(false);
    });

    it('a CI/CD pipeline role passes the human filter — which is why type alone cannot decide intent', () => {
        const pipeline = {
            type: 'AssumedRole',
            arn: 'arn:aws:sts::688849551607:assumed-role/secops-stx-kyc-ekyc-pf-app-CodepipelineRole-32ag/deploy',
        };
        // It is not an AWS service and not our platform, so it reaches ingest...
        expect(isHumanPrincipal(pipeline)).toBe(true);
        expect(isPlatformPrincipal(pipeline, 'arn:aws:iam::688849551607:role/NucleusAccess-970547372609')).toBe(false);
        // ...and must therefore never be labelled a human-made change. The ARN is
        // recorded as the evidence and the reader judges for themselves.
        expect(principalOf(pipeline)).toContain('CodepipelineRole');
    });
});

describe('synthesized description feeds the existing classifier', () => {
    // The CloudTrail client writes its description in AWS's own prose precisely
    // so capacity flows through the normal path instead of a special case.
    it('recovers desiredAfter from the ECS wording', () => {
        expect(classifyCause('[CloudTrail] UpdateService called by arn:aws:iam::1:user/alice', 'Setting desired count to 4.').desiredAfter).toBe(4);
    });

    it('recovers desiredAfter from the ASG wording', () => {
        expect(classifyCause('[CloudTrail] SetDesiredCapacity called by arn:aws:iam::1:user/alice', 'Setting desired capacity to 7.').desiredAfter).toBe(7);
    });
});
