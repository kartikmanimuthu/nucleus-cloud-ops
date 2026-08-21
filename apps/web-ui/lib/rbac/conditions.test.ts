/**
 * Conditions end to end (Workstream F).
 *
 * The property under test is the one the whole ABAC half exists for: the SAME
 * role, the SAME action, the SAME subject — allowed on one row and refused on
 * another, decided only by the row's attributes and the principal's.
 *
 * This exercises the real compiler and a real CASL ability. Only the registry
 * rows are fixtures.
 */

import { createMongoAbility, subject as tagSubject } from '@casl/ability';
import { compileRules } from '@nucleus/rbac';
import type { AbilityPrincipal, RbacRoleRuleRow, RegistrySnapshot } from '@nucleus/rbac';
import { describe, expect, it } from 'vitest';

function registry(): RegistrySnapshot {
    return {
        tenantId: 't1',
        modules: [
            {
                id: 'm-sched',
                tenantId: null,
                key: 'Schedules',
                label: 'Schedules',
                description: null,
                icon: null,
                navPath: null,
                sortOrder: 10,
                isSystem: true,
                enabled: true,
            },
        ],
        actions: [
            {
                id: 'a-update',
                tenantId: null,
                key: 'update',
                label: 'update',
                description: null,
                aliasOfKey: null,
                isDangerous: false,
                sortOrder: 10,
                isSystem: true,
            },
        ],
        subjects: [
            { id: 's-sched', tenantId: null, key: 'Schedule', label: 'Schedule', kind: 'resource', isSystem: true },
        ],
        subjectModules: [{ tenantId: null, subjectId: 's-sched', moduleId: 'm-sched' }],
        moduleActions: [{ tenantId: null, moduleId: 'm-sched', actionId: 'a-update', grantable: true }],
        subjectAttributes: [
            {
                tenantId: null,
                subjectId: 's-sched',
                path: 'accountId',
                label: 'Account',
                valueType: 'string',
                operators: ['$eq', '$ne', '$in', '$nin'],
                enumValues: [],
            },
            {
                tenantId: null,
                subjectId: 's-sched',
                path: 'tags.Environment',
                label: 'Environment',
                valueType: 'string',
                operators: ['$eq', '$ne', '$in', '$nin'],
                enumValues: [],
            },
        ],
        principalAttributes: [
            {
                tenantId: null,
                key: 'user.allowedAccountIds',
                label: 'Allowed accounts',
                valueType: 'string[]',
                source: 'user',
            },
        ],
    };
}

function rule(conditions: unknown): RbacRoleRuleRow {
    return {
        id: 'r-cond',
        tenantId: null,
        roleId: 'role-ops',
        actionId: 'a-update',
        moduleId: 'm-sched',
        subjectId: null,
        conditions,
        fields: [],
        inverted: false,
        reason: 'Restricted to your assigned accounts',
    };
}

function principal(attributes: Record<string, unknown>): AbilityPrincipal {
    return {
        userId: 'u1',
        email: 'ops@example.com',
        tenantId: 't1',
        roleId: 'role-ops',
        roleName: 'Ops',
        level: 2,
        isSuperAdmin: false,
        attributes,
    };
}

function abilityFor(conditions: unknown, attributes: Record<string, unknown>) {
    const compiled = compileRules(registry(), [rule(conditions)], principal(attributes));
    return { ability: createMongoAbility(compiled.rules as never), dropped: compiled.dropped };
}

/** CASL needs the subject type attached for conditions to be evaluated. */
const schedule = (data: Record<string, unknown>) => tagSubject('Schedule', data) as never;

describe('conditions end to end', () => {
    const ACCOUNT_SCOPED = { accountId: { $in: { $var: 'user.allowedAccountIds' } } };

    it('allows a dev-account schedule and denies a prod one, same role and action', () => {
        const { ability } = abilityFor(ACCOUNT_SCOPED, {
            'user.allowedAccountIds': ['dev-1', 'dev-2'],
        });

        expect(ability.can('update', schedule({ accountId: 'dev-1' }))).toBe(true);
        expect(ability.can('update', schedule({ accountId: 'dev-2' }))).toBe(true);
        expect(ability.can('update', schedule({ accountId: 'prod-9' }))).toBe(false);
    });

    it('surfaces the rule reason on a denial, for the 403 body', () => {
        const { ability } = abilityFor(ACCOUNT_SCOPED, { 'user.allowedAccountIds': ['dev-1'] });
        const matched = ability.relevantRuleFor('update', schedule({ accountId: 'dev-1' }));

        expect(matched?.reason).toBe('Restricted to your assigned accounts');
    });

    it('denies EVERYTHING when the principal has an empty account list', () => {
        // `$in: []` matches nothing. Fail-closed, and importantly NOT the same as
        // "no condition" — which under CASL v7 would grant everything.
        const { ability } = abilityFor(ACCOUNT_SCOPED, { 'user.allowedAccountIds': [] });

        expect(ability.can('update', schedule({ accountId: 'dev-1' }))).toBe(false);
        expect(ability.can('update', schedule({ accountId: 'prod-9' }))).toBe(false);
    });

    it('denies when the attribute is missing entirely — the rule is dropped, not widened', () => {
        const { ability, dropped } = abilityFor(ACCOUNT_SCOPED, {});

        expect(dropped).toHaveLength(1);
        expect(dropped[0].reason).toBe('condition-unresolvable');
        expect(ability.can('update', schedule({ accountId: 'dev-1' }))).toBe(false);
    });

    it('evaluates a non-$var condition against the row — "not production"', () => {
        // A dotted attribute path is a NESTED path to the matcher, not a flat key:
        // `tags.Environment` reads row.tags.Environment. Passing a literal
        // "tags.Environment" key would leave the field undefined.
        const { ability } = abilityFor({ 'tags.Environment': { $ne: 'production' } }, {});

        expect(ability.can('update', schedule({ tags: { Environment: 'dev' } }))).toBe(true);
        expect(ability.can('update', schedule({ tags: { Environment: 'production' } }))).toBe(false);
    });

    it('$ne GRANTS on a row where the attribute is absent — documented, not desired', () => {
        // `undefined !== 'production'` is true, so a "not production" rule allows
        // every untagged row. This is a fail-OPEN direction and the reason the
        // condition builder should prefer `$in` over `$ne` for anything
        // security-relevant. Pinned here so the behaviour cannot change silently.
        const { ability } = abilityFor({ 'tags.Environment': { $ne: 'production' } }, {});

        expect(ability.can('update', schedule({ accountId: 'dev-1' }))).toBe(true);
        expect(ability.can('update', schedule({ tags: {} }))).toBe(true);
    });

    it('combines both sides of ABAC — allowed account AND non-production', () => {
        const { ability } = abilityFor(
            {
                accountId: { $in: { $var: 'user.allowedAccountIds' } },
                'tags.Environment': { $ne: 'production' },
            },
            { 'user.allowedAccountIds': ['dev-1'] }
        );

        expect(ability.can('update', schedule({ accountId: 'dev-1', tags: { Environment: 'dev' } }))).toBe(true);
        // Right account, wrong environment.
        expect(ability.can('update', schedule({ accountId: 'dev-1', tags: { Environment: 'production' } }))).toBe(
            false
        );
        // Right environment, wrong account.
        expect(ability.can('update', schedule({ accountId: 'prod-9', tags: { Environment: 'dev' } }))).toBe(false);
    });

    it('CASL alone ALLOWS a conditional grant checked without a row — the hole authorize() closes', () => {
        // Conditions are evaluated against a subject INSTANCE. Asked about a bare
        // subject type, CASL answers "could this ever be allowed" and returns
        // true — so a call site that forgets the third argument to authorize()
        // would silently turn "only your own accounts" into "all accounts".
        //
        // authorize() detects exactly this (matched rule has conditions, no
        // subjectData supplied) and denies. This test pins the underlying CASL
        // behaviour so the guard is never removed as redundant.
        const { ability } = abilityFor(ACCOUNT_SCOPED, { 'user.allowedAccountIds': ['dev-1'] });

        expect(ability.can('update', 'Schedule')).toBe(true);
        expect(ability.relevantRuleFor('update', 'Schedule')?.conditions).toBeDefined();
    });

    it('rejects a condition referencing an undeclared attribute', () => {
        const { ability, dropped } = abilityFor({ secretColumn: { $eq: 'x' } }, {});

        expect(dropped[0].reason).toBe('condition-invalid');
        expect(ability.can('update', schedule({ secretColumn: 'x' }))).toBe(false);
    });
});
