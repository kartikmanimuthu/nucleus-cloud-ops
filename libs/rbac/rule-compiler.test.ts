import { createMongoAbility } from '@casl/ability';
import { packRules, unpackRules } from '@casl/ability/extra';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { buildActionAliasMap, compileRules } from './rule-compiler';
import type {
    RbacActionRow,
    RbacModuleRow,
    RbacRoleRuleRow,
    RbacSubjectAttributeRow,
    RbacSubjectRow,
    RegistrySnapshot,
} from './registry-types';
import type { AbilityPrincipal, AppAbility } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function module_(id: string, key: string, enabled = true): RbacModuleRow {
    return {
        id,
        tenantId: null,
        key,
        label: key,
        description: null,
        icon: null,
        navPath: null,
        sortOrder: 100,
        isSystem: true,
        enabled,
    };
}

function action_(id: string, key: string, aliasOfKey: string | null = null): RbacActionRow {
    return {
        id,
        tenantId: null,
        key,
        label: key,
        description: null,
        aliasOfKey,
        isDangerous: false,
        sortOrder: 100,
        isSystem: true,
    };
}

function subject_(id: string, key: string): RbacSubjectRow {
    return { id, tenantId: null, key, label: key, kind: 'resource', navPath: null, sortOrder: 100, isSystem: true };
}

function attribute_(subjectId: string, path: string, valueType: RbacSubjectAttributeRow['valueType'] = 'string'): RbacSubjectAttributeRow {
    return {
        tenantId: null,
        subjectId,
        path,
        label: path,
        valueType,
        operators: ['$eq', '$ne', '$in', '$nin'],
        enumValues: [],
    };
}

/**
 * Two modules: Schedules {Schedule, SpotGuard}, Inventory {Resource}.
 * Actions: CRUD, plus `approve` aliased to `update`, plus `manage`.
 */
function makeRegistry(patch: Partial<RegistrySnapshot> = {}): RegistrySnapshot {
    const base: RegistrySnapshot = {
        tenantId: 't1',
        modules: [module_('m-sched', 'Schedules'), module_('m-inv', 'Inventory')],
        actions: [
            action_('a-create', 'create'),
            action_('a-read', 'read'),
            action_('a-update', 'update'),
            action_('a-delete', 'delete'),
            action_('a-approve', 'approve', 'update'),
            action_('a-manage', 'manage'),
        ],
        subjects: [subject_('s-sched', 'Schedule'), subject_('s-spot', 'SpotGuard'), subject_('s-res', 'Resource')],
        subjectModules: [
            { tenantId: null, subjectId: 's-sched', moduleId: 'm-sched' },
            { tenantId: null, subjectId: 's-spot', moduleId: 'm-sched' },
            { tenantId: null, subjectId: 's-res', moduleId: 'm-inv' },
        ],
        moduleActions: ['a-create', 'a-read', 'a-update', 'a-delete'].flatMap((actionId) => [
            { tenantId: null, moduleId: 'm-sched', actionId, grantable: true },
            { tenantId: null, moduleId: 'm-inv', actionId, grantable: true },
        ]),
        subjectAttributes: [
            attribute_('s-sched', 'accountId'),
            attribute_('s-spot', 'accountId'),
            attribute_('s-res', 'accountId'),
        ],
        principalAttributes: [
            { tenantId: null, key: 'user.id', label: 'User', valueType: 'string', source: 'builtin' },
            { tenantId: null, key: 'user.email', label: 'Email', valueType: 'string', source: 'builtin' },
            {
                tenantId: null,
                key: 'user.allowedAccountIds',
                label: 'Allowed accounts',
                valueType: 'string[]',
                source: 'user',
            },
        ],
    };
    return { ...base, ...patch };
}

let ruleSeq = 0;
function rule_(patch: Partial<RbacRoleRuleRow> = {}): RbacRoleRuleRow {
    return {
        id: patch.id ?? `r${++ruleSeq}`,
        tenantId: null,
        roleId: 'role-1',
        actionId: 'a-update',
        moduleId: null,
        subjectId: null,
        conditions: null,
        fields: [],
        inverted: false,
        reason: null,
        ...patch,
    };
}

function principal_(patch: Partial<AbilityPrincipal> = {}): AbilityPrincipal {
    return {
        userId: 'u1',
        email: 'a@example.com',
        tenantId: 't1',
        roleId: 'role-1',
        roleName: 'Ops',
        level: 2,
        isSuperAdmin: false,
        attributes: {},
        ...patch,
    };
}

function abilityFrom(result: { rules: unknown[] }): AppAbility {
    return createMongoAbility(result.rules as never);
}

// ─────────────────────────────────────────────────────────────────────────────

describe('buildActionAliasMap', () => {
    it('resolves an action with no alias to itself', () => {
        expect(buildActionAliasMap([action_('a-read', 'read')])).toEqual({ read: 'read' });
    });

    it('resolves an alias chain to its terminal key', () => {
        const map = buildActionAliasMap([
            action_('a-update', 'update'),
            action_('a-approve', 'approve', 'update'),
            action_('a-signoff', 'signoff', 'approve'),
        ]);
        expect(map).toEqual({ update: 'update', approve: 'update', signoff: 'update' });
    });

    it('resolves an alias cycle to whichever key is reached at cycle-detection, rather than throwing', () => {
        // Check-time lookups must never 500 a request — unlike compileRules'
        // resolveAlias, this tolerates a malformed registry instead of throwing.
        const map = buildActionAliasMap([action_('a-x', 'x', 'y'), action_('a-y', 'y', 'x')]);
        expect(map).toEqual({ x: 'y', y: 'x' });
    });

    it('resolves a chain deeper than MAX_ALIAS_DEPTH to the last-reached key, rather than throwing', () => {
        const map = buildActionAliasMap([
            action_('a-1', 'k1', 'k2'),
            action_('a-2', 'k2', 'k3'),
            action_('a-3', 'k3', 'k4'),
            action_('a-4', 'k4', 'k5'),
            action_('a-5', 'k5', 'k6'),
            action_('a-6', 'k6', 'k7'),
            action_('a-7', 'k7'),
        ]);
        // MAX_ALIAS_DEPTH=4 hops from k1: k1->k2->k3->k4->k5, stopping short of k6/k7.
        expect(map.k1).toBe('k5');
    });
});

describe('compileRules — expansion', () => {
    it('expands a module rule to every subject in the module', () => {
        const result = compileRules(makeRegistry(), [rule_({ moduleId: 'm-sched' })], principal_());
        const ability = abilityFrom(result);

        expect(ability.can('update', 'Schedule')).toBe(true);
        expect(ability.can('update', 'SpotGuard')).toBe(true);
        // ...and nothing outside the module
        expect(ability.can('update', 'Resource')).toBe(false);
    });

    it('contributes nothing for a disabled module', () => {
        const registry = makeRegistry({ modules: [module_('m-sched', 'Schedules', false), module_('m-inv', 'Inventory')] });
        const result = compileRules(registry, [rule_({ moduleId: 'm-sched' })], principal_());

        expect(result.rules).toEqual([]);
        expect(result.dropped[0]?.reason).toBe('module-disabled');
    });

    it('emits a subject rule for that subject only', () => {
        const result = compileRules(makeRegistry(), [rule_({ subjectId: 's-spot' })], principal_());
        const ability = abilityFrom(result);

        expect(ability.can('update', 'SpotGuard')).toBe(true);
        expect(ability.can('update', 'Schedule')).toBe(false);
    });
});

describe('compileRules — precise beats broad', () => {
    // The ordering guarantee matters: rows come back from Postgres in whatever
    // order the planner chose, so suppression must not depend on it.
    const cases: Array<[string, RbacRoleRuleRow[]]> = [
        [
            'module rule first',
            [rule_({ id: 'mod', moduleId: 'm-sched' }), rule_({ id: 'sub', subjectId: 's-spot', inverted: true })],
        ],
        [
            'subject rule first',
            [rule_({ id: 'sub', subjectId: 's-spot', inverted: true }), rule_({ id: 'mod', moduleId: 'm-sched' })],
        ],
    ];

    it.each(cases)('a subject-level rule suppresses its module rule — %s', (_label, rules) => {
        const ability = abilityFrom(compileRules(makeRegistry(), rules, principal_()));

        expect(ability.can('update', 'Schedule')).toBe(true);
        expect(ability.can('update', 'SpotGuard')).toBe(false);
    });
});

describe('compileRules — aliases', () => {
    it('resolves an alias to its terminal action', () => {
        const result = compileRules(makeRegistry(), [rule_({ actionId: 'a-approve', moduleId: 'm-sched' })], principal_());
        const ability = abilityFrom(result);

        // 'approve' aliases 'update', reproducing today's ACTION_MAP as data.
        expect(ability.can('update', 'Schedule')).toBe(true);
        expect(result.rules.every((r) => r.action !== 'approve')).toBe(true);
    });

    it('resolves a multi-hop alias chain', () => {
        const registry = makeRegistry({
            actions: [
                action_('a-update', 'update'),
                action_('a-approve', 'approve', 'update'),
                action_('a-signoff', 'signoff', 'approve'),
            ],
        });
        const ability = abilityFrom(
            compileRules(registry, [rule_({ actionId: 'a-signoff', subjectId: 's-sched' })], principal_())
        );

        expect(ability.can('update', 'Schedule')).toBe(true);
    });

    it('throws on an alias cycle rather than degrading silently', () => {
        const registry = makeRegistry({
            actions: [action_('a-x', 'x', 'y'), action_('a-y', 'y', 'x')],
        });

        expect(() => compileRules(registry, [rule_({ actionId: 'a-x', subjectId: 's-sched' })], principal_())).toThrow(
            /alias cycle/i
        );
    });

    it('throws when an alias chain is deeper than the cap', () => {
        const registry = makeRegistry({
            actions: [
                action_('a-1', 'k1', 'k2'),
                action_('a-2', 'k2', 'k3'),
                action_('a-3', 'k3', 'k4'),
                action_('a-4', 'k4', 'k5'),
                action_('a-5', 'k5', 'k6'),
                action_('a-6', 'k6', 'k7'),
                action_('a-7', 'k7'),
            ],
        });

        expect(() => compileRules(registry, [rule_({ actionId: 'a-1', subjectId: 's-sched' })], principal_())).toThrow(
            /deeper than/i
        );
    });
});

describe('compileRules — manage', () => {
    it('expands to the module grantable actions, not to the CASL wildcard', () => {
        const result = compileRules(makeRegistry(), [rule_({ actionId: 'a-manage', moduleId: 'm-sched' })], principal_());
        const ability = abilityFrom(result);

        for (const action of ['create', 'read', 'update', 'delete']) {
            expect(ability.can(action, 'Schedule')).toBe(true);
        }
        // The literal 'manage' wildcard must never be emitted — if it were, a
        // future action would be granted retroactively.
        expect(result.rules.some((r) => r.action === 'manage')).toBe(false);
        expect(ability.can('read', 'Resource')).toBe(false);
    });

    it('does NOT retroactively widen when a new action is added to the registry later', () => {
        const before = makeRegistry();
        const manageRule = [rule_({ actionId: 'a-manage', moduleId: 'm-sched' })];

        // A new grantable action appears, but nobody re-granted anything.
        const after = makeRegistry({
            actions: [...before.actions, action_('a-export', 'export')],
            // deliberately NOT added to moduleActions — it is not grantable yet
        });

        const ability = abilityFrom(compileRules(after, manageRule, principal_()));
        expect(ability.can('export', 'Schedule')).toBe(false);
    });
});

describe('compileRules — inverted rules', () => {
    it('emits every `can` before every `cannot`', () => {
        const result = compileRules(
            makeRegistry(),
            [rule_({ subjectId: 's-spot', inverted: true }), rule_({ subjectId: 's-sched' })],
            principal_()
        );

        const firstInverted = result.rules.findIndex((r) => r.inverted);
        const lastPlain = result.rules.map((r) => Boolean(r.inverted)).lastIndexOf(false);
        expect(firstInverted).toBeGreaterThan(lastPlain);
    });

    it('a cannot always beats an overlapping can', () => {
        const ability = abilityFrom(
            compileRules(
                makeRegistry(),
                [rule_({ id: 'a', subjectId: 's-sched' }), rule_({ id: 'b', subjectId: 's-sched', inverted: true })],
                principal_()
            )
        );

        expect(ability.can('update', 'Schedule')).toBe(false);
    });
});

describe('compileRules — SuperAdmin', () => {
    it('short-circuits to manage all', () => {
        const result = compileRules(makeRegistry(), [], principal_({ isSuperAdmin: true }));

        expect(result.rules).toEqual([{ action: 'manage', subject: 'all' }]);
        expect(abilityFrom(result).can('delete', 'AnythingAtAll')).toBe(true);
    });
});

describe('compileRules — malformed registry links are skipped, not fatal', () => {
    it('ignores a subjectModules link pointing at a subject not in the registry', () => {
        const registry = makeRegistry({
            subjectModules: [
                { tenantId: null, subjectId: 'ghost-subject', moduleId: 'm-sched' },
                { tenantId: null, subjectId: 's-sched', moduleId: 'm-sched' },
            ],
        });
        const ability = abilityFrom(compileRules(registry, [rule_({ moduleId: 'm-sched' })], principal_()));

        expect(ability.can('update', 'Schedule')).toBe(true);
        // SpotGuard's link was dropped along with the ghost link, so only
        // Schedule is targeted by the module expansion.
        expect(ability.can('update', 'SpotGuard')).toBe(false);
    });

    it('excludes a moduleActions link marked not grantable', () => {
        const registry = makeRegistry({
            moduleActions: [
                { tenantId: null, moduleId: 'm-sched', actionId: 'a-update', grantable: false },
                { tenantId: null, moduleId: 'm-sched', actionId: 'a-create', grantable: true },
            ],
        });
        const ability = abilityFrom(
            compileRules(registry, [rule_({ actionId: 'a-manage', moduleId: 'm-sched' })], principal_())
        );

        expect(ability.can('create', 'Schedule')).toBe(true);
        expect(ability.can('update', 'Schedule')).toBe(false);
    });

    it('ignores a moduleActions link pointing at an action not in the registry', () => {
        const registry = makeRegistry({
            moduleActions: [
                { tenantId: null, moduleId: 'm-sched', actionId: 'ghost-action', grantable: true },
                { tenantId: null, moduleId: 'm-sched', actionId: 'a-create', grantable: true },
            ],
        });
        const ability = abilityFrom(
            compileRules(registry, [rule_({ actionId: 'a-manage', moduleId: 'm-sched' })], principal_())
        );

        expect(ability.can('create', 'Schedule')).toBe(true);
    });

    it('emits nothing for a module rule when the module has zero linked subjects', () => {
        const base = makeRegistry();
        const registry = makeRegistry({ modules: [...base.modules, module_('m-empty', 'Empty')] });
        const result = compileRules(registry, [rule_({ moduleId: 'm-empty' })], principal_());

        expect(result.rules).toEqual([]);
        expect(result.dropped).toEqual([]);
    });
});

describe('compileRules — dropped rule reasons', () => {
    it('drops a rule whose actionId is not in the registry', () => {
        const result = compileRules(
            makeRegistry(),
            [rule_({ id: 'r-ghost-action', actionId: 'ghost-action', moduleId: 'm-sched' })],
            principal_()
        );

        expect(result.rules).toEqual([]);
        expect(result.dropped).toEqual([
            { ruleId: 'r-ghost-action', reason: 'unknown-action', detail: 'action ghost-action is not in the registry' },
        ]);
    });

    it('drops a rule whose moduleId is not in the registry', () => {
        const result = compileRules(makeRegistry(), [rule_({ id: 'r-ghost-mod', moduleId: 'ghost-module' })], principal_());

        expect(result.rules).toEqual([]);
        expect(result.dropped).toEqual([
            { ruleId: 'r-ghost-mod', reason: 'unknown-module', detail: 'module ghost-module is not in the registry' },
        ]);
    });

    it('drops a rule whose subjectId is not in the registry', () => {
        const result = compileRules(
            makeRegistry(),
            [rule_({ id: 'r-ghost-subj', subjectId: 'ghost-subject' })],
            principal_()
        );

        expect(result.rules).toEqual([]);
        expect(result.dropped).toEqual([
            { ruleId: 'r-ghost-subj', reason: 'unknown-subject', detail: 'subject ghost-subject is not in the registry' },
        ]);
    });

    it('fails closed when a rule has neither a module nor a subject target', () => {
        const result = compileRules(makeRegistry(), [rule_({ id: 'r-untargeted' })], principal_());

        expect(result.rules).toEqual([]);
        expect(result.dropped).toEqual([
            { ruleId: 'r-untargeted', reason: 'unknown-subject', detail: 'rule has neither a module nor a subject target' },
        ]);
    });

    it('drops a subject rule when its owning module is disabled', () => {
        const registry = makeRegistry({
            modules: [module_('m-sched', 'Schedules', false), module_('m-inv', 'Inventory')],
        });
        const result = compileRules(registry, [rule_({ id: 'r-disabled', subjectId: 's-sched' })], principal_());

        expect(result.rules).toEqual([]);
        expect(result.dropped).toEqual([
            {
                ruleId: 'r-disabled',
                reason: 'module-disabled',
                detail: "subject 'Schedule' belongs to disabled module 'Schedules'",
            },
        ]);
    });

    it('emits a subject rule for an orphan subject with no owning module', () => {
        const base = makeRegistry();
        const registry = makeRegistry({ subjects: [...base.subjects, subject_('s-orphan', 'Orphan')] });
        const ability = abilityFrom(compileRules(registry, [rule_({ subjectId: 's-orphan' })], principal_()));

        expect(ability.can('update', 'Orphan')).toBe(true);
    });

    it('drops a manage rule targeting an orphan subject as expanding to no grantable actions', () => {
        const base = makeRegistry();
        const registry = makeRegistry({ subjects: [...base.subjects, subject_('s-orphan', 'Orphan')] });
        const result = compileRules(
            registry,
            [rule_({ id: 'r-manage-orphan', actionId: 'a-manage', subjectId: 's-orphan' })],
            principal_()
        );

        expect(result.rules).toEqual([]);
        expect(result.dropped).toEqual([
            { ruleId: 'r-manage-orphan', reason: 'unknown-action', detail: "'manage' expanded to no grantable actions" },
        ]);
    });

    it('fails condition validation cleanly when the subject has zero declared attributes', () => {
        const base = makeRegistry();
        const registry = makeRegistry({ subjects: [...base.subjects, subject_('s-bare', 'Bare')] });
        const result = compileRules(
            registry,
            [rule_({ subjectId: 's-bare', conditions: { accountId: 'dev-1' } })],
            principal_()
        );

        expect(result.rules).toEqual([]);
        expect(result.dropped[0]).toMatchObject({ reason: 'condition-invalid' });
    });

    it('accumulates multiple declared attributes for the same subject', () => {
        const base = makeRegistry();
        const registry = makeRegistry({
            subjectAttributes: [...base.subjectAttributes, attribute_('s-sched', 'region')],
        });
        const ability = abilityFrom(
            compileRules(
                registry,
                [rule_({ subjectId: 's-sched', conditions: { accountId: 'dev-1', region: 'us-east' } })],
                principal_()
            )
        );

        expect(ability.can('update', subjectWith('Schedule', { accountId: 'dev-1', region: 'us-east' }))).toBe(true);
        expect(ability.can('update', subjectWith('Schedule', { accountId: 'dev-1', region: 'eu-west' }))).toBe(false);
    });

    it('resolves a purely literal condition with no $var references at all', () => {
        const ability = abilityFrom(
            compileRules(
                makeRegistry(),
                [rule_({ subjectId: 's-sched', conditions: { accountId: 'dev-1' } })],
                principal_()
            )
        );

        expect(ability.can('update', subjectWith('Schedule', { accountId: 'dev-1' }))).toBe(true);
        expect(ability.can('update', subjectWith('Schedule', { accountId: 'prod-1' }))).toBe(false);
    });

    it('keeps walking every array item after an earlier item fails to resolve, not just later object keys', () => {
        // resolveConditions' walk() short-circuits sibling OBJECT keys via the
        // `if (failure) return` right after each assignment, but Array.prototype.map
        // does not self-abort — every array item is still walked once `failure`
        // is set. This asserts that doesn't change the outcome: the whole rule
        // is still dropped, not partially resolved.
        const result = compileRules(
            makeRegistry(),
            [
                rule_({
                    subjectId: 's-sched',
                    conditions: {
                        $and: [
                            { accountId: { $in: { $var: 'user.allowedAccountIds' } } },
                            { accountId: { $ne: { $var: 'user.id' } } },
                        ],
                    },
                }),
            ],
            principal_({ attributes: {} })
        );

        expect(result.rules).toEqual([]);
        expect(result.dropped[0]).toMatchObject({ reason: 'condition-unresolvable' });
    });
});

describe('compileRules — dedup and reason', () => {
    it('deduplicates two separate rule rows that resolve to the identical (action, subject, conditions, inverted) fingerprint', () => {
        const result = compileRules(
            makeRegistry(),
            [rule_({ id: 'r1', subjectId: 's-sched' }), rule_({ id: 'r2', subjectId: 's-sched' })],
            principal_()
        );

        expect(result.rules).toHaveLength(1);
        expect(result.rules[0]).toEqual({ action: 'update', subject: 'Schedule' });
    });

    it('carries the reason field through to the emitted rule', () => {
        const result = compileRules(
            makeRegistry(),
            [rule_({ subjectId: 's-sched', reason: 'because policy X' })],
            principal_()
        );

        expect(result.rules[0]).toMatchObject({ reason: 'because policy X' });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// The highest-stakes behaviour in the whole plan.
//
// CASL v7 treats a condition matching everything as NO condition, so a rule
// emitted with an unresolved $var does not deny — it grants unconditionally.
// ─────────────────────────────────────────────────────────────────────────────

describe('compileRules — unresolvable $var (CASL v7 escalation trap)', () => {
    const conditionalRule = rule_({
        subjectId: 's-sched',
        conditions: { accountId: { $in: { $var: 'user.allowedAccountIds' } } },
    });

    it('produces NO rule when the principal lacks the attribute — not a broad one', () => {
        const result = compileRules(makeRegistry(), [conditionalRule], principal_({ attributes: {} }));

        expect(result.rules).toEqual([]);
        expect(result.dropped).toHaveLength(1);
        expect(result.dropped[0].reason).toBe('condition-unresolvable');

        // The assertion that actually matters: no access, rather than total access.
        expect(abilityFrom(result).can('update', 'Schedule')).toBe(false);
    });

    it('emits a working conditional rule when the attribute IS present', () => {
        const ability = abilityFrom(
            compileRules(
                makeRegistry(),
                [conditionalRule],
                principal_({ attributes: { 'user.allowedAccountIds': ['dev-1', 'dev-2'] } })
            )
        );

        expect(ability.can('update', subjectWith('Schedule', { accountId: 'dev-1' }))).toBe(true);
        expect(ability.can('update', subjectWith('Schedule', { accountId: 'prod-9' }))).toBe(false);
    });

    it('drops the rule when the $var is not a declared principal attribute', () => {
        const result = compileRules(
            makeRegistry(),
            [rule_({ subjectId: 's-sched', conditions: { accountId: { $in: { $var: 'user.smuggled' } } } })],
            principal_({ attributes: { 'user.smuggled': ['x'] } })
        );

        expect(result.rules).toEqual([]);
        expect(result.dropped[0].reason).toBe('condition-invalid');
    });

    it('drops rather than emitting an empty condition object', () => {
        const result = compileRules(makeRegistry(), [rule_({ subjectId: 's-sched', conditions: {} })], principal_());
        expect(result.rules).toEqual([]);
    });
});

/** CASL needs the subject type attached to a plain object for conditions to apply. */
function subjectWith(type: string, data: Record<string, unknown>) {
    return { ...data, __caslSubjectType__: type } as never;
}

describe('compileRules — no undefined ever reaches CASL', () => {
    it('never emits undefined at any depth, over generated principals', () => {
        const conditions = {
            accountId: { $in: { $var: 'user.allowedAccountIds' } },
            $and: [{ accountId: { $ne: { $var: 'user.id' } } }],
        };

        fc.assert(
            fc.property(
                fc.record({
                    'user.allowedAccountIds': fc.option(fc.array(fc.string()), { nil: undefined }),
                    'user.id': fc.option(fc.string(), { nil: undefined }),
                }),
                (attributes) => {
                    const result = compileRules(
                        makeRegistry(),
                        [rule_({ subjectId: 's-sched', conditions })],
                        principal_({ attributes })
                    );

                    const json = JSON.stringify(result.rules);
                    // JSON.stringify drops undefined in objects, so check structurally too.
                    expect(json).not.toContain('undefined');
                    for (const emitted of result.rules) {
                        if (emitted.conditions) expectNoUndefined(emitted.conditions);
                    }
                    return true;
                }
            ),
            { numRuns: 200 }
        );
    });
});

function expectNoUndefined(value: unknown): void {
    if (value === undefined) throw new Error('found undefined in an emitted condition');
    if (Array.isArray(value)) return value.forEach(expectNoUndefined);
    if (typeof value === 'object' && value !== null) Object.values(value).forEach(expectNoUndefined);
}

describe('module grant with a subject deny', () => {
    it('emits the module expansion plus a trailing inverted rule', () => {
        const registry: RegistrySnapshot = {
            tenantId: 't1',
            modules: [
                { id: 'm-aiops', tenantId: null, key: 'AIOps', label: 'AI Ops', description: null, icon: null, navPath: '/app/agent', sortOrder: 40, isSystem: true, enabled: true },
            ],
            actions: [
                { id: 'a-read', tenantId: null, key: 'read', label: 'Read', description: null, aliasOfKey: null, isDangerous: false, sortOrder: 20, isSystem: true },
            ],
            subjects: [
                { id: 's-agent', tenantId: null, key: 'Agent', label: 'Agent', kind: 'resource', navPath: '/app/agent', sortOrder: 10, isSystem: true },
                { id: 's-provider', tenantId: null, key: 'Provider', label: 'Provider', kind: 'resource', navPath: '/app/agent-ops/providers', sortOrder: 70, isSystem: true },
            ],
            subjectModules: [
                { tenantId: null, subjectId: 's-agent', moduleId: 'm-aiops' },
                { tenantId: null, subjectId: 's-provider', moduleId: 'm-aiops' },
            ],
            moduleActions: [{ tenantId: null, moduleId: 'm-aiops', actionId: 'a-read', grantable: true }],
            subjectAttributes: [],
            principalAttributes: [],
        };

        const { rules, dropped } = compileRules(
            registry,
            [
                { id: 'r1', tenantId: 't1', roleId: 'role-1', actionId: 'a-read', moduleId: 'm-aiops', subjectId: null, conditions: null, fields: [], inverted: false, reason: null },
                { id: 'r2', tenantId: 't1', roleId: 'role-1', actionId: 'a-read', moduleId: null, subjectId: 's-provider', conditions: null, fields: [], inverted: true, reason: null },
            ],
            { userId: 'u1', email: 'u@example.com', tenantId: 't1', roleId: null, roleName: 'Custom', level: 5, isSuperAdmin: false, attributes: {} }
        );

        expect(dropped).toEqual([]);
        // Two rules, not three. `preciseKeys` (rule-compiler.ts:403) does NOT
        // check `inverted`, so ANY subject-level rule SUPPRESSES the module's
        // expanded rule for that (action, subject) — the module's `read
        // Provider` is dropped outright rather than being outvoted later.
        //
        // So suppression is the mechanism, and the `cannot`-last ordering
        // (step 6) is a second line of defence, not the thing doing the work.
        // Both are load-bearing for DIFFERENT cases: ordering still matters
        // when a deny must beat a grant it did not suppress.
        expect(rules).toEqual([
            { action: 'read', subject: 'Agent' },
            { action: 'read', subject: 'Provider', inverted: true },
        ]);
    });
});

describe('compileRules — packing round trip', () => {
    it('survives packRules -> unpackRules -> createMongoAbility unchanged', () => {
        const result = compileRules(
            makeRegistry(),
            [
                rule_({ moduleId: 'm-sched' }),
                rule_({
                    subjectId: 's-res',
                    actionId: 'a-read',
                    conditions: { accountId: { $in: { $var: 'user.allowedAccountIds' } } },
                }),
            ],
            principal_({ attributes: { 'user.allowedAccountIds': ['dev-1'] } })
        );

        const server = createMongoAbility(result.rules as never);
        const client = createMongoAbility(unpackRules(packRules(result.rules as never)) as never);

        // The one-compiler invariant: the browser and the server must answer
        // identically, or a hidden button and a 403 disagree.
        for (const [action, subject] of [
            ['update', 'Schedule'],
            ['update', 'SpotGuard'],
            ['read', 'Resource'],
            ['delete', 'Resource'],
        ] as const) {
            expect(client.can(action, subject)).toBe(server.can(action, subject));
        }
        expect(client.can('read', subjectWith('Resource', { accountId: 'dev-1' }))).toBe(true);
        expect(client.can('read', subjectWith('Resource', { accountId: 'prod-1' }))).toBe(false);
    });
});

describe('compileRules — properties', () => {
    const allSubjects = ['Schedule', 'SpotGuard', 'Resource'];
    const allActions = ['create', 'read', 'update', 'delete'];

    it('never grants a pair that no rule targets', () => {
        fc.assert(
            fc.property(
                fc.subarray(['m-sched', 'm-inv'], { minLength: 0 }),
                fc.constantFrom('a-create', 'a-read', 'a-update', 'a-delete'),
                (moduleIds, actionId) => {
                    const rules = moduleIds.map((moduleId) => rule_({ moduleId, actionId }));
                    const ability = abilityFrom(compileRules(makeRegistry(), rules, principal_()));

                    const grantedModules = new Set(moduleIds);
                    const subjectModule: Record<string, string> = {
                        Schedule: 'm-sched',
                        SpotGuard: 'm-sched',
                        Resource: 'm-inv',
                    };
                    const actionKey = actionId.replace('a-', '');

                    for (const subject of allSubjects) {
                        for (const action of allActions) {
                            const shouldAllow = action === actionKey && grantedModules.has(subjectModule[subject]);
                            if (ability.can(action, subject) !== shouldAllow) return false;
                        }
                    }
                    return true;
                }
            ),
            { numRuns: 100 }
        );
    });

    it('adding an inverted rule never widens the allowed set', () => {
        fc.assert(
            fc.property(fc.constantFrom('s-sched', 's-spot', 's-res'), (subjectId) => {
                const base = [rule_({ moduleId: 'm-sched' }), rule_({ moduleId: 'm-inv' })];
                const withDeny = [...base, rule_({ subjectId, inverted: true })];

                const a = abilityFrom(compileRules(makeRegistry(), base, principal_()));
                const b = abilityFrom(compileRules(makeRegistry(), withDeny, principal_()));

                for (const subject of allSubjects) {
                    for (const action of allActions) {
                        if (b.can(action, subject) && !a.can(action, subject)) return false;
                    }
                }
                return true;
            }),
            { numRuns: 100 }
        );
    });

    it('is deterministic and independent of input row order', () => {
        const rules = [
            rule_({ id: 'r-a', moduleId: 'm-sched' }),
            rule_({ id: 'r-b', subjectId: 's-res', actionId: 'a-read' }),
            rule_({ id: 'r-c', subjectId: 's-spot', inverted: true }),
        ];

        fc.assert(
            fc.property(fc.shuffledSubarray(rules, { minLength: rules.length }), (shuffled) => {
                const reference = compileRules(makeRegistry(), rules, principal_());
                const permuted = compileRules(makeRegistry(), shuffled, principal_());
                return JSON.stringify(reference.rules) === JSON.stringify(permuted.rules);
            }),
            { numRuns: 50 }
        );
    });
});
