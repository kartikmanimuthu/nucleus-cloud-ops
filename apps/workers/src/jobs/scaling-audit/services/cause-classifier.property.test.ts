import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { classifyCause } from './cause-classifier.js';

const VALID_SCALING_TYPES = new Set([
    'scheduled', 'target_tracking', 'step', 'simple', 'predictive', 'manual',
    'health_check_replacement', 'capacity_rebalance', 'instance_refresh',
    'az_rebalance', 'max_instance_lifetime', 'not_scaled', 'unparsed',
]);

describe('classifyCause properties', () => {
    it('is total: never throws on arbitrary input, including empty/unicode/huge strings', () => {
        fc.assert(
            fc.property(fc.string({ maxLength: 5000 }), (cause) => {
                expect(() => classifyCause(cause)).not.toThrow();
            })
        );
    });

    it('always returns a scalingType from the declared enum', () => {
        fc.assert(
            fc.property(fc.string({ maxLength: 500 }), (cause) => {
                const result = classifyCause(cause);
                expect(VALID_SCALING_TYPES.has(result.scalingType)).toBe(true);
            })
        );
    });

    it('is deterministic — same input always yields the same output', () => {
        fc.assert(
            fc.property(fc.string({ maxLength: 500 }), (cause) => {
                expect(classifyCause(cause)).toEqual(classifyCause(cause));
            })
        );
    });

    it('unparsed implies no parsed capacity fields', () => {
        fc.assert(
            fc.property(fc.string({ maxLength: 500 }), (cause) => {
                const result = classifyCause(cause);
                if (result.scalingType === 'unparsed') {
                    expect(result.desiredBefore).toBeUndefined();
                    expect(result.desiredAfter).toBeUndefined();
                    expect(result.policyName).toBeUndefined();
                    expect(result.alarmName).toBeUndefined();
                    expect(result.scheduledActionName).toBeUndefined();
                }
            })
        );
    });

    it('parsed capacity fields, when present, are always non-negative integers', () => {
        fc.assert(
            fc.property(fc.string({ maxLength: 500 }), (cause) => {
                const result = classifyCause(cause);
                if (result.desiredBefore !== undefined) {
                    expect(Number.isInteger(result.desiredBefore)).toBe(true);
                    expect(result.desiredBefore).toBeGreaterThanOrEqual(0);
                }
                if (result.desiredAfter !== undefined) {
                    expect(Number.isInteger(result.desiredAfter)).toBe(true);
                    expect(result.desiredAfter).toBeGreaterThanOrEqual(0);
                }
            })
        );
    });

    it('never crashes and stays total on adversarial regex-special-character input', () => {
        const specials = fc
            .array(fc.constantFrom('(', ')', '.', '*', '+', '?', '[', ']', '\\', '$', '^', '|', '{', '}'), { maxLength: 200 })
            .map((chars) => chars.join(''));
        fc.assert(
            fc.property(specials, (cause) => {
                expect(() => classifyCause(cause)).not.toThrow();
            })
        );
    });

    it('embedding a known cause phrase inside arbitrary noise still classifies past unparsed', () => {
        const knownFragments = [
            'a scheduled action named x changing the desired capacity from 1 to 2',
            'a user request update of AutoScalingGroup constraints to min: 1, max: 5, desired: 3 change successfully executed',
            'instance i-1 was taken out of service in response to a EC2 health check indicating it has been terminated or stopped',
        ];
        fc.assert(
            fc.property(
                fc.constantFrom(...knownFragments),
                fc.string({ maxLength: 50 }),
                fc.string({ maxLength: 50 }),
                (fragment, prefix, suffix) => {
                    const result = classifyCause(`${prefix}${fragment}${suffix}`);
                    expect(result.scalingType).not.toBe('unparsed');
                }
            )
        );
    });
});
