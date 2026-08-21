// workers/src/jobs/scaling-audit/services/cause-classifier.ts
//
// Pure function: classify an AWS scaling activity's free-text `Cause` (and
// `Description`) into a scalingType + extracted policy/alarm/schedule names and
// before/after desired capacity. No I/O, no AWS calls — testable in isolation
// (cause-classifier.test.ts, cause-classifier.property.test.ts).
//
// The raw `cause` string is ALWAYS retained verbatim by the caller regardless of
// what this function returns — classification is a derived, versioned,
// re-derivable view, never the source of truth. When nothing matches, this
// returns 'unparsed' rather than guessing 'manual': a mis-defaulted 'manual' reads
// as an unauthorised change, which is itself an audit finding.
//
// AWS's Cause text format is shared, near-identical vocabulary across both
// autoscaling:DescribeScalingActivities (ASG) and Application Auto Scaling's
// DescribeScalingActivities (ECS) — "monitor alarm ... triggered policy",
// "scheduled action", "a user request" all appear in both. The one documented
// difference is the capacity noun: ASG says "desired capacity", ECS says
// "desired count" — extractCapacity() matches either.
import type { ClassifiedCause, ScalingType } from '../types.js';

interface CauseMatcher {
    type: ScalingType;
    test: RegExp;
    extract?: (cause: string, match: RegExpMatchArray) => Partial<ClassifiedCause>;
}

/** Ordered — first match wins. More specific phrasing before generic ones. */
const MATCHERS: CauseMatcher[] = [
    {
        // AWS Cause example: "At 2023-11-02T09:00:03Z instance i-0abc123 was taken
        // out of service in response to a EC2 health check indicating it has been
        // terminated or stopped."
        type: 'health_check_replacement',
        test: /health check/i,
    },
    {
        // AWS Cause example: "At 2023-11-02T09:00:03Z instance i-0abc123 was taken
        // out of service in response to a EC2 Capacity Rebalance recommendation."
        type: 'capacity_rebalance',
        test: /capacity rebalance|rebalance recommendation/i,
    },
    {
        // AWS Cause example: "At 2023-11-02T09:00:03Z an instance was started in
        // response to an AZ rebalance in group my-asg changing the desired
        // capacity from 4 to 5."
        type: 'az_rebalance',
        test: /\baz rebalance\b/i,
    },
    {
        // AWS Cause example: "At 2023-11-02T09:00:03Z instance i-0abc123 was taken
        // out of service in response to a max instance lifetime action."
        type: 'max_instance_lifetime',
        test: /max instance lifetime/i,
    },
    {
        // AWS Cause example: "At 2023-11-02T09:00:03Z instance i-0abc123 was taken
        // out of service as part of instance refresh req-0123456789abcdef0."
        type: 'instance_refresh',
        test: /instance refresh/i,
    },
    {
        // AWS Cause example: "At 2023-11-02T09:00:00Z a predictive scaling policy
        // my-predictive-policy changing the desired capacity from 2 to 5 was
        // executed as forecast."
        type: 'predictive',
        test: /predictive scaling/i,
        extract: (cause) => {
            const m = cause.match(/predictive scaling policy\s+([^\s,]+)/i);
            return m ? { policyName: m[1] } : {};
        },
    },
    {
        // AWS Cause example (ASG): "At 2023-11-02T09:00:00Z a scheduled action
        // named my-scale-up-9am changing the desired capacity from 2 to 6 was
        // executed."
        // AWS Cause example (Application Auto Scaling / ECS — verified against a
        // live scheduled action, ap-south-1, 2026-08-05): "scheduled action name
        // nucleus-scale-sentinel-test-scale-to-2 was triggered." Note "name", not
        // "named" — the connector word differs between the two APIs.
        type: 'scheduled',
        test: /scheduled action/i,
        extract: (cause) => {
            const m = cause.match(/scheduled action\s+name(?:d)?\s+['"]?([^\s,'"]+)/i);
            return m ? { scheduledActionName: m[1] } : {};
        },
    },
    {
        // AWS Cause example: "At 2023-11-02T09:00:00Z a monitor alarm
        // TargetTracking-my-asg-AlarmHigh-abc123 in state ALARM triggered policy
        // my-target-tracking-policy changing the desired capacity from 2 to 4."
        //
        // Heuristic: ASG/Application Auto Scaling auto-name target-tracking alarms
        // "TargetTracking-...". A step-scaling alarm is user/CFN-named, so
        // classify() promotes anything else alarm-driven from 'step' to
        // 'target_tracking' based on that prefix (see below). 'simple' is
        // reserved for a future cross-reference against DescribePolicies'
        // PolicyType — Cause text alone cannot distinguish simple from step
        // scaling, both being CloudWatch-alarm-driven.
        type: 'step',
        test: /monitor alarm/i,
        extract: (cause) => {
            const m = cause.match(/monitor alarm\s+(\S+)\s+in state\s+\w+\s+triggered policy\s+([^\s,]+)/i);
            return m ? { alarmName: m[1], policyName: m[2] } : {};
        },
    },
    {
        // AWS Cause example: "At 2023-11-02T09:00:00Z a user request update of
        // AutoScalingGroup constraints to min: 1, max: 5, desired: 3 change
        // successfully executed."
        type: 'manual',
        test: /user request/i,
    },
];

/** Matches both "desired capacity" (ASG) and "desired count" (ECS) phrasing. */
function extractCapacity(cause: string): Pick<ClassifiedCause, 'desiredBefore' | 'desiredAfter'> {
    const range = cause.match(/changing the desired (?:capacity|count) from (\d+) to (\d+)/i);
    if (range) {
        return { desiredBefore: Number(range[1]), desiredAfter: Number(range[2]) };
    }
    const desiredOnly = cause.match(/desired:\s*(\d+)/i);
    if (desiredOnly) {
        return { desiredAfter: Number(desiredOnly[1]) };
    }
    return {};
}

/**
 * Application Auto Scaling splits the information across two fields: `Cause`
 * names only the trigger ("monitor alarm ... triggered policy cpu", "minimum
 * capacity was set to 2") while the target capacity lives in `Description`
 * ("Setting desired count to 2."). Verified against live ap-south-1 activities,
 * 2026-08-05 — before this, every real ECS scaling row landed with both
 * desiredBefore and desiredAfter null, so a compliance export of an ECS scale
 * showed no capacity figures at all.
 *
 * Only ever fills a gap: an explicit before/after range parsed from the cause
 * always wins, since that carries both endpoints and this carries only the target.
 */
function extractCapacityFromDescription(description: string): Pick<ClassifiedCause, 'desiredAfter'> {
    // "count" is Application Auto Scaling's noun; "capacity" is the ASG noun used
    // by the CloudTrail client's synthesized description (cloudtrail-client.ts),
    // which is deliberately written in this same prose so it parses here rather
    // than needing a special case.
    const m = description.match(/setting desired (?:count|capacity) to (\d+)/i);
    return m ? { desiredAfter: Number(m[1]) } : {};
}

const TARGET_TRACKING_ALARM_PREFIX = /^TargetTracking-/i;

/**
 * Classify a scaling activity's Cause text. Total function — never throws, and
 * always returns a value; unmatched input yields 'unparsed', never a guess.
 *
 * `description` is optional and used only to recover capacity figures the cause
 * text omits (see extractCapacityFromDescription).
 */
export function classifyCause(cause: string, description?: string): ClassifiedCause {
    const text = cause ?? '';
    const descriptionCapacity = extractCapacityFromDescription(description ?? '');

    for (const matcher of MATCHERS) {
        if (!matcher.test.test(text)) continue;

        const extracted = matcher.extract ? matcher.extract(text, text.match(matcher.test)!) : {};
        let scalingType = matcher.type;
        if (scalingType === 'step' && typeof extracted.alarmName === 'string' && TARGET_TRACKING_ALARM_PREFIX.test(extracted.alarmName)) {
            scalingType = 'target_tracking';
        }

        const causeCapacity = extractCapacity(text);
        return {
            scalingType,
            ...extracted,
            // Cause-derived capacity wins; description only fills the gap.
            ...descriptionCapacity,
            ...causeCapacity,
        };
    }

    return { scalingType: 'unparsed', ...descriptionCapacity };
}

/**
 * Applied by the writer, not classifyCause() itself: when AWS reports the
 * activity as suppressed (Application Auto Scaling's NotScaledReasons, e.g.
 * "AlreadyAtMaxCapacity"), the outcome is semantically distinct from whatever
 * cause classifyCause() found — a suppressed scale-out is often the single most
 * audit-relevant event in the whole record, and must not be buried under
 * 'target_tracking' or 'scheduled' as if it succeeded.
 */
export function applyNotScaledOverride(classified: ClassifiedCause, hasNotScaledReasons: boolean): ClassifiedCause {
    if (!hasNotScaledReasons) return classified;
    return { ...classified, scalingType: 'not_scaled' };
}
