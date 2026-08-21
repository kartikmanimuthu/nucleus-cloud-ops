import { describe, expect, it } from 'vitest';
import { createMongoAbility } from '@casl/ability';

import { canReadOwner, isExemptPath, pageGuardMode } from './page-authz';

const REGISTRY = {
    subjects: [
        { id: 's1', key: 'Agent', moduleKey: 'AIOps' },
        { id: 's2', key: 'Provider', moduleKey: 'AIOps' },
    ],
};

describe('pageGuardMode', () => {
    it('defaults to shadow', () => {
        delete process.env.RBAC_PAGE_GUARD_MODE;
        expect(pageGuardMode()).toBe('shadow');
    });

    it('accepts enforce and off', () => {
        process.env.RBAC_PAGE_GUARD_MODE = 'enforce';
        expect(pageGuardMode()).toBe('enforce');
        process.env.RBAC_PAGE_GUARD_MODE = 'off';
        expect(pageGuardMode()).toBe('off');
        delete process.env.RBAC_PAGE_GUARD_MODE;
    });

    it('treats an unrecognised value as shadow', () => {
        process.env.RBAC_PAGE_GUARD_MODE = 'yes-please';
        expect(pageGuardMode()).toBe('shadow');
        delete process.env.RBAC_PAGE_GUARD_MODE;
    });
});

describe('isExemptPath', () => {
    // Guarding the denial page itself is an infinite redirect.
    it('exempts the unauthorized page', () => {
        expect(isExemptPath('/app/unauthorized')).toBe(true);
    });

    it('exempts the /app root', () => {
        expect(isExemptPath('/app')).toBe(true);
    });

    it('does not exempt a normal page', () => {
        expect(isExemptPath('/app/agent-ops/providers')).toBe(false);
    });
});

describe('canReadOwner', () => {
    it('asks about the subject key for a subject owner', () => {
        const ability = createMongoAbility([{ action: 'read', subject: 'Agent' }] as never);
        expect(canReadOwner(ability as never, { kind: 'subject', key: 'Agent', navPath: '/app/agent' }, REGISTRY)).toBe(true);
        expect(canReadOwner(ability as never, { kind: 'subject', key: 'Provider', navPath: '/app/x' }, REGISTRY)).toBe(false);
    });

    // A module grant compiles to one rule per SUBJECT and never a rule named
    // after the module, so "can read anything in here" is the only answerable form.
    it('asks about any subject of the module for a module owner', () => {
        const ability = createMongoAbility([{ action: 'read', subject: 'Agent' }] as never);
        expect(canReadOwner(ability as never, { kind: 'module', key: 'AIOps', navPath: '/app/agent' }, REGISTRY)).toBe(true);
    });

    it('denies a module whose subjects are all unreadable', () => {
        const ability = createMongoAbility([] as never);
        expect(canReadOwner(ability as never, { kind: 'module', key: 'AIOps', navPath: '/app/agent' }, REGISTRY)).toBe(false);
    });
});
