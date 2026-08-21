// workers/src/jobs/spot-guard/bus-policy.test.ts
//
// Tests for the bus-policy document builder and its size ceiling.
//
// buildBusPolicyDocument is deliberately exported as a pure function so the sizing
// argument that drove the whole design (one statement with a condition list, rather
// than one statement per account) is verifiable rather than asserted in a comment.
import { describe, it, expect } from 'vitest';
import { buildBusPolicyDocument } from './bus-policy.js';

const BUS_ARN = 'arn:aws:events:ap-south-1:044656767899:event-bus/stx-nucleus-ops-sbx-spot-guard';

const accounts = (n: number) =>
    Array.from({ length: n }, (_, i) => String(100000000000 + i));

describe('buildBusPolicyDocument', () => {
    it('emits a single statement gated on aws:PrincipalAccount', () => {
        const doc = JSON.parse(buildBusPolicyDocument(BUS_ARN, ['111111111111', '222222222222']));
        expect(doc.Statement).toHaveLength(1);
        const s = doc.Statement[0];
        expect(s.Effect).toBe('Allow');
        expect(s.Action).toBe('events:PutEvents');
        expect(s.Resource).toBe(BUS_ARN);
        expect(s.Condition.StringEquals['aws:PrincipalAccount']).toEqual(['111111111111', '222222222222']);
    });

    it('never emits an unconditioned wildcard principal', () => {
        // Principal "*" is only safe BECAUSE of the condition. A statement with the
        // wildcard and no condition would open the bus to every AWS account on earth —
        // which is exactly what the reference implementation did.
        const s = JSON.parse(buildBusPolicyDocument(BUS_ARN, ['111111111111'])).Statement[0];
        expect(s.Principal).toBe('*');
        expect(s.Condition?.StringEquals?.['aws:PrincipalAccount']).toBeDefined();
        expect(Object.keys(s.Condition)).not.toHaveLength(0);
    });

    it('scopes the resource to one bus, never "*"', () => {
        const s = JSON.parse(buildBusPolicyDocument(BUS_ARN, ['111111111111'])).Statement[0];
        expect(s.Resource).not.toBe('*');
    });

    it('is valid JSON and stable in account order', () => {
        const ids = ['333333333333', '111111111111', '222222222222'];
        const s = JSON.parse(buildBusPolicyDocument(BUS_ARN, ids)).Statement[0];
        // The caller sorts (SELECT ... ORDER BY); the builder must not reorder, so a
        // reconcile that changes nothing produces a byte-identical document and does
        // not churn the bus policy.
        expect(s.Condition.StringEquals['aws:PrincipalAccount']).toEqual(ids);
    });

    it('fits well over 600 accounts inside the 10240-char EventBridge limit', () => {
        // The sizing claim the design rests on. Per-account cost is ~15 chars
        // ("123456789012",) against a ~276-char fixed part.
        const doc = buildBusPolicyDocument(BUS_ARN, accounts(600));
        expect(doc.length).toBeLessThan(10_240);
    });

    it('demonstrates the per-account cost is ~15 chars', () => {
        const base = buildBusPolicyDocument(BUS_ARN, accounts(10)).length;
        const more = buildBusPolicyDocument(BUS_ARN, accounts(110)).length;
        const perAccount = (more - base) / 100;
        expect(perAccount).toBeGreaterThan(12);
        expect(perAccount).toBeLessThan(18);
    });

    it('shows the rejected per-statement shape would cap out around 45 accounts', () => {
        // Documents WHY option (a) was chosen over one PutPermission statement per
        // account. If this ever stops holding, the trade-off should be revisited.
        const perStatement = JSON.stringify({
            Sid: 'NucleusSpotGuard111111111111',
            Effect: 'Allow',
            Principal: { AWS: 'arn:aws:iam::111111111111:root' },
            Action: 'events:PutEvents',
            Resource: BUS_ARN,
        }).length + 1; // + comma
        const capacity = Math.floor((10_240 - 40) / perStatement);
        expect(capacity).toBeLessThan(60);
        // And the chosen shape is comfortably an order of magnitude better.
        expect(600).toBeGreaterThan(capacity * 5);
    });
});
