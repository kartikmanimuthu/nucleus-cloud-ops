// workers/src/jobs/spot-guard/services/account-resolver.test.ts
//
// The security-critical pure logic: ARN/account cross-checking and acting-tenant
// election. These are the checks that stop one customer's spoke from directing Nucleus
// at another customer's ECS service, so they get explicit adversarial cases.
import { describe, it, expect, beforeEach } from 'vitest';
import {
    accountFromArn,
    findArnAccountMismatch,
    resolveActingTenant,
    shouldLogUnregistered,
    __resetUnregisteredLogState,
} from './account-resolver.js';
import type { EcsEventEnvelope, SpokeBinding } from '../types.js';

const binding = (tenantId: string): SpokeBinding => ({
    tenantId,
    accountId: '111111111111',
    roleArn: `arn:aws:iam::111111111111:role/NucleusAccess-hub`,
    externalId: 'ext',
    regions: ['ap-south-1'],
});

describe('accountFromArn', () => {
    it('extracts the account from segment 5', () => {
        expect(accountFromArn('arn:aws:ecs:ap-south-1:111111111111:cluster/c1')).toBe('111111111111');
    });

    it('returns null for shapes it does not recognise', () => {
        expect(accountFromArn('not-an-arn')).toBeNull();
        expect(accountFromArn('arn:aws:ecs')).toBeNull();
        expect(accountFromArn('')).toBeNull();
    });

    it('returns null for a service-scoped ARN with an empty account segment', () => {
        // e.g. S3-style ARNs omit account. Not a mismatch, just unknown.
        expect(accountFromArn('arn:aws:s3:::my-bucket')).toBeNull();
    });
});

describe('findArnAccountMismatch', () => {
    const ok: EcsEventEnvelope = {
        account: '111111111111',
        resources: ['arn:aws:ecs:ap-south-1:111111111111:task/c1/abc'],
        detail: {
            clusterArn: 'arn:aws:ecs:ap-south-1:111111111111:cluster/c1',
            taskArn: 'arn:aws:ecs:ap-south-1:111111111111:task/c1/abc',
        },
    };

    it('passes when every ARN matches the attributed account', () => {
        expect(findArnAccountMismatch(ok)).toBeNull();
    });

    it('CATCHES a spoke naming another account clusterArn', () => {
        // The core attack: spoke 111... claims a cluster in 999.... Without this check
        // we would resolve 999...'s tenant, assume its role, and mutate its service.
        const evil: EcsEventEnvelope = {
            ...ok,
            detail: { ...ok.detail, clusterArn: 'arn:aws:ecs:ap-south-1:999999999999:cluster/victim' },
        };
        expect(findArnAccountMismatch(evil)).toBe('arn:aws:ecs:ap-south-1:999999999999:cluster/victim');
    });

    it('catches a foreign ARN hidden in resources[] while detail looks clean', () => {
        const evil: EcsEventEnvelope = {
            ...ok,
            resources: ['arn:aws:ecs:ap-south-1:999999999999:service/victim/api'],
        };
        expect(findArnAccountMismatch(evil)).toContain('999999999999');
    });

    it('catches a foreign taskArn', () => {
        const evil: EcsEventEnvelope = {
            ...ok,
            detail: { ...ok.detail, taskArn: 'arn:aws:ecs:ap-south-1:999999999999:task/c/x' },
        };
        expect(findArnAccountMismatch(evil)).toContain('999999999999');
    });

    it('tolerates a malformed ARN rather than treating it as an attack', () => {
        // An unrecognised shape carries no ownership claim. Only a well-formed,
        // DIFFERENT account is a signal — otherwise a harmless format change upstream
        // would start dropping every event.
        const odd: EcsEventEnvelope = { ...ok, resources: ['garbage'], detail: { clusterArn: 'also-garbage' } };
        expect(findArnAccountMismatch(odd)).toBeNull();
    });

    it('passes an envelope with no ARNs at all', () => {
        expect(findArnAccountMismatch({ account: '111111111111', detail: {} })).toBeNull();
    });
});

describe('resolveActingTenant', () => {
    it('elects the lexicographically first tenant, deterministically', () => {
        // Determinism is the whole point: two replicas processing duplicate deliveries
        // of the same event must independently pick the SAME acting tenant, with no
        // coordination, or both would mutate.
        const sorted = [binding('tenant-a'), binding('tenant-b'), binding('tenant-c')];
        expect(resolveActingTenant(sorted)?.tenantId).toBe('tenant-a');
        // Same set, and the caller's ORDER BY guarantees this ordering.
        expect(resolveActingTenant([...sorted])?.tenantId).toBe('tenant-a');
    });

    it('returns null when nothing resolved', () => {
        expect(resolveActingTenant([])).toBeNull();
    });

    it('returns the sole binding in the single-tenant case', () => {
        expect(resolveActingTenant([binding('only')])?.tenantId).toBe('only');
    });
});

describe('shouldLogUnregistered', () => {
    beforeEach(() => __resetUnregisteredLogState());

    it('logs the first drop and suppresses repeats inside the window', () => {
        expect(shouldLogUnregistered('999999999999', 1_000_000)).toBe(true);
        expect(shouldLogUnregistered('999999999999', 1_000_500)).toBe(false);
        expect(shouldLogUnregistered('999999999999', 1_030_000)).toBe(false);
    });

    it('logs again once the window has passed', () => {
        expect(shouldLogUnregistered('999999999999', 1_000_000)).toBe(true);
        expect(shouldLogUnregistered('999999999999', 1_061_000)).toBe(true);
    });

    it('rate limits per account, not globally', () => {
        expect(shouldLogUnregistered('111111111111', 1_000_000)).toBe(true);
        expect(shouldLogUnregistered('222222222222', 1_000_000)).toBe(true);
    });

    it('bounds its memo so a flood of spoofed accounts cannot grow it forever', () => {
        // The log flood IS the attack, so the defence must not itself be unbounded.
        for (let i = 0; i < 1200; i++) shouldLogUnregistered(`acct-${i}`, 1_000_000);
        // Far in the future: every entry is stale, so the next call prunes.
        expect(shouldLogUnregistered('acct-new', 5_000_000)).toBe(true);
    });
});
