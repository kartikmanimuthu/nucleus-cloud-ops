import { describe, it, expect } from 'vitest';
import { classifyCause, applyNotScaledOverride } from './cause-classifier.js';

describe('classifyCause', () => {
    it('classifies a target-tracking alarm (ASG)', () => {
        const cause =
            "At 2023-11-02T09:00:00Z a monitor alarm TargetTracking-my-asg-AlarmHigh-abc123 in state ALARM triggered policy my-target-tracking-policy changing the desired capacity from 2 to 4.";
        const result = classifyCause(cause);
        expect(result.scalingType).toBe('target_tracking');
        expect(result.alarmName).toBe('TargetTracking-my-asg-AlarmHigh-abc123');
        expect(result.policyName).toBe('my-target-tracking-policy');
        expect(result.desiredBefore).toBe(2);
        expect(result.desiredAfter).toBe(4);
    });

    it('classifies a step-scaling alarm (non-TargetTracking alarm name) as step', () => {
        const cause =
            "At 2023-11-02T09:00:00Z a monitor alarm my-cpu-high-alarm in state ALARM triggered policy my-step-policy changing the desired capacity from 3 to 6.";
        const result = classifyCause(cause);
        expect(result.scalingType).toBe('step');
        expect(result.alarmName).toBe('my-cpu-high-alarm');
        expect(result.policyName).toBe('my-step-policy');
        expect(result.desiredBefore).toBe(3);
        expect(result.desiredAfter).toBe(6);
    });

    it('classifies a scheduled action', () => {
        const cause =
            "At 2023-11-02T09:00:00Z a scheduled action named my-scale-up-9am changing the desired capacity from 2 to 6 was executed.";
        const result = classifyCause(cause);
        expect(result.scalingType).toBe('scheduled');
        expect(result.scheduledActionName).toBe('my-scale-up-9am');
        expect(result.desiredBefore).toBe(2);
        expect(result.desiredAfter).toBe(6);
    });

    it('classifies an Application Auto Scaling (ECS) scheduled action — "name", not "named" (captured live, ap-south-1, 2026-08-05)', () => {
        const cause = 'scheduled action name nucleus-scale-sentinel-test-scale-to-2 was triggered';
        const result = classifyCause(cause);
        expect(result.scalingType).toBe('scheduled');
        expect(result.scheduledActionName).toBe('nucleus-scale-sentinel-test-scale-to-2');
    });

    it('classifies a manual ASG scale-out via set-desired-capacity (captured live, ap-south-1, 2026-08-05)', () => {
        const cause =
            'At 2026-08-05T10:35:05Z a user request explicitly set group desired capacity changing the desired capacity from 1 to 2.  At 2026-08-05T10:35:14Z an instance was started in response to a difference between desired and actual capacity, increasing the capacity from 1 to 2.';
        const result = classifyCause(cause);
        expect(result.scalingType).toBe('manual');
        expect(result.desiredBefore).toBe(1);
        expect(result.desiredAfter).toBe(2);
    });

    describe('capacity recovered from Description (Application Auto Scaling / ECS)', () => {
        // Application Auto Scaling puts the trigger in Cause and the target
        // capacity in Description. All three of these were captured live from
        // ap-south-1 on 2026-08-05; before this, each landed with null capacity.
        it('recovers desiredAfter for an alarm-driven ECS scale', () => {
            const result = classifyCause(
                'monitor alarm TargetTracking-service/c/s-AlarmLow-0f6a5a12 in state ALARM triggered policy cpu',
                'Setting desired count to 1.'
            );
            expect(result.scalingType).toBe('target_tracking');
            expect(result.desiredAfter).toBe(1);
        });

        it('recovers desiredAfter when the cause is otherwise unparseable', () => {
            const result = classifyCause('minimum capacity was set to 2', 'Setting desired count to 2.');
            expect(result.scalingType).toBe('unparsed');
            expect(result.desiredAfter).toBe(2);
        });

        it('leaves capacity absent for a guardrail-only bound change', () => {
            const result = classifyCause(
                'scheduled action name nucleus-scale-sentinel-test-scale-to-2 was triggered',
                'Setting min capacity to 2 and max capacity to 3'
            );
            expect(result.scalingType).toBe('scheduled');
            expect(result.desiredAfter).toBeUndefined();
            expect(result.desiredBefore).toBeUndefined();
        });

        it('prefers the cause-derived before/after range over the description target', () => {
            const result = classifyCause(
                'At 2026-08-05T10:35:05Z a user request explicitly set group desired capacity changing the desired capacity from 1 to 2.',
                'Setting desired count to 99.'
            );
            expect(result.desiredBefore).toBe(1);
            expect(result.desiredAfter).toBe(2);
        });

        it('is unaffected when no description is supplied', () => {
            expect(classifyCause('minimum capacity was set to 2')).toEqual({ scalingType: 'unparsed' });
        });
    });

    it('classifies a manual user request (no from/to range, only desired:)', () => {
        const cause =
            "At 2023-11-02T09:00:00Z a user request update of AutoScalingGroup constraints to min: 1, max: 5, desired: 3 change successfully executed.";
        const result = classifyCause(cause);
        expect(result.scalingType).toBe('manual');
        expect(result.desiredBefore).toBeUndefined();
        expect(result.desiredAfter).toBe(3);
    });

    it('classifies an ECS service scaling event using "desired count" phrasing', () => {
        const cause =
            "At 2023-11-02T09:00:00Z a monitor alarm TargetTracking-service/my-cluster/my-svc-AlarmHigh-xyz in state ALARM triggered policy my-ecs-policy changing the desired count from 2 to 5.";
        const result = classifyCause(cause);
        expect(result.scalingType).toBe('target_tracking');
        expect(result.desiredBefore).toBe(2);
        expect(result.desiredAfter).toBe(5);
    });

    it('classifies a health check replacement', () => {
        const cause =
            "At 2023-11-02T09:00:03Z instance i-0abc123 was taken out of service in response to a EC2 health check indicating it has been terminated or stopped.";
        expect(classifyCause(cause).scalingType).toBe('health_check_replacement');
    });

    it('classifies a capacity rebalance', () => {
        const cause =
            "At 2023-11-02T09:00:03Z instance i-0abc123 was taken out of service in response to a EC2 Capacity Rebalance recommendation.";
        expect(classifyCause(cause).scalingType).toBe('capacity_rebalance');
    });

    it('classifies an AZ rebalance', () => {
        const cause =
            "At 2023-11-02T09:00:03Z an instance was started in response to an AZ rebalance in group my-asg changing the desired capacity from 4 to 5.";
        expect(classifyCause(cause).scalingType).toBe('az_rebalance');
    });

    it('classifies a max instance lifetime replacement', () => {
        const cause =
            "At 2023-11-02T09:00:03Z instance i-0abc123 was taken out of service in response to a max instance lifetime action.";
        expect(classifyCause(cause).scalingType).toBe('max_instance_lifetime');
    });

    it('classifies an instance refresh', () => {
        const cause =
            "At 2023-11-02T09:00:03Z instance i-0abc123 was taken out of service as part of instance refresh req-0123456789abcdef0.";
        expect(classifyCause(cause).scalingType).toBe('instance_refresh');
    });

    it('classifies a predictive scaling policy', () => {
        const cause =
            "At 2023-11-02T09:00:00Z a predictive scaling policy my-predictive-policy changing the desired capacity from 2 to 5 was executed as forecast.";
        const result = classifyCause(cause);
        expect(result.scalingType).toBe('predictive');
        expect(result.policyName).toBe('my-predictive-policy');
    });

    it('returns unparsed for unrecognized text, with no capacity fields', () => {
        const result = classifyCause('some future AWS phrasing we have never seen before');
        expect(result.scalingType).toBe('unparsed');
        expect(result.desiredBefore).toBeUndefined();
        expect(result.desiredAfter).toBeUndefined();
    });

    it('returns unparsed (never throws) for an empty string', () => {
        expect(classifyCause('').scalingType).toBe('unparsed');
    });
});

describe('applyNotScaledOverride', () => {
    it('leaves classification untouched when there are no NotScaledReasons', () => {
        const classified = classifyCause('a scheduled action named x changing the desired capacity from 1 to 2');
        expect(applyNotScaledOverride(classified, false)).toEqual(classified);
    });

    it('overrides to not_scaled when NotScaledReasons is present, regardless of the underlying cause', () => {
        const classified = classifyCause(
            "a monitor alarm TargetTracking-svc-AlarmHigh-abc in state ALARM triggered policy p changing the desired count from 2 to 2"
        );
        const overridden = applyNotScaledOverride(classified, true);
        expect(overridden.scalingType).toBe('not_scaled');
        // Extracted fields (policy/alarm names, capacity) are preserved — only the
        // classification changes, so the audit record keeps full context.
        expect(overridden.policyName).toBe('p');
    });
});
