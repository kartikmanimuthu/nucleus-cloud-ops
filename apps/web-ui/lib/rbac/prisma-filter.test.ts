/**
 * Gate 3 — row filtering.
 *
 * The property under test is NOT "the filter is correct" (that is the compiler's
 * job) but "the filter cannot escape the tenant". The failure this file exists to
 * catch is a CASL filter REPLACING the tenant predicate instead of intersecting
 * with it — a silent cross-tenant read that no type checks and no 403 would
 * reveal, because the request is authorized; it just returns other people's rows.
 *
 * Everything below therefore runs the REAL pipeline end to end:
 *   compiled ability
 *     -> accessibleBy(...).ofType()          @casl/prisma, unmocked
 *     -> readFilterFor()                     the translator
 *     -> andWhere()                          the composition helper
 *     -> applyTenantScope()                  the actual tenant-extension rewrite
 *                                            lifted verbatim out of getTenantClient()
 * and assert on the args that would reach the Prisma engine.
 */

import { createMongoAbility } from '@casl/ability';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { andWhere, applyTenantScope } from '@/lib/db/pg-config';
import type { AppAbility } from '@nucleus/rbac';

import {
    isUnrestricted,
    readFilterFor,
    unmappedAttributePaths,
    UntranslatableFilterError,
} from './prisma-filter';

const TENANT = 'tenant-a';
const OTHER_TENANT = 'tenant-b';

type Rule = Parameters<typeof createMongoAbility>[0][number];

const abilityOf = (rules: Rule[]): AppAbility => createMongoAbility(rules) as AppAbility;

/** The full pipeline a list endpoint runs, ending at the engine-bound args. */
function composedWhere(
    ability: AppAbility,
    subject: string,
    model: string,
    baseWhere: Record<string, unknown>,
    tenantId = TENANT
): Record<string, unknown> {
    const filter = readFilterFor(ability, subject);
    const scoped = andWhere(baseWhere, isUnrestricted(filter) ? null : filter);
    const args = applyTenantScope(model, 'findMany', { where: scoped }, tenantId);
    return args.where as Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Translation
// ─────────────────────────────────────────────────────────────────────────────

describe('readFilterFor — mongo conditions to Prisma where', () => {
    it('returns an empty filter for an unconditional grant (nothing to narrow)', () => {
        const filter = readFilterFor(abilityOf([{ action: 'read', subject: 'Schedule' }]), 'Schedule');
        expect(filter).toEqual({});
        expect(isUnrestricted(filter)).toBe(true);
    });

    it('returns an empty filter for SuperAdmin (manage all)', () => {
        expect(readFilterFor(abilityOf([{ action: 'manage', subject: 'all' }]), 'Schedule')).toEqual({});
    });

    it('returns a match-nothing filter when no rule grants read (fail closed)', () => {
        // accessibleBy()'s {OR: []} must survive translation verbatim — an empty
        // OR is what makes the query return zero rows. Losing it would turn "no
        // grant" into "no filter", i.e. every row in the tenant.
        expect(readFilterFor(abilityOf([]), 'Schedule')).toEqual({ OR: [] });
        expect(readFilterFor(abilityOf([{ action: 'update', subject: 'Schedule' }]), 'Schedule')).toEqual({
            OR: [],
        });
        expect(isUnrestricted({ OR: [] })).toBe(false);
    });

    it('translates $in to Prisma `in`, not passing mongo syntax through', () => {
        const filter = readFilterFor(
            abilityOf([
                { action: 'read', subject: 'Schedule', conditions: { accountId: { $in: ['a', 'b'] } } },
            ]),
            'Schedule'
        );
        expect(filter).toEqual({ OR: [{ accountId: { in: ['a', 'b'] } }] });
        expect(JSON.stringify(filter)).not.toContain('$in');
    });

    it('translates the whole comparison operator set', () => {
        const filter = readFilterFor(
            abilityOf([
                {
                    action: 'read',
                    subject: 'RightSizing',
                    conditions: {
                        accountId: { $ne: 'x' },
                        region: { $nin: ['eu-west-1'] },
                        resourceType: { $eq: 'ec2_instances' },
                    },
                },
            ]),
            'RightSizing'
        );
        expect(filter).toEqual({
            OR: [
                {
                    AND: [
                        { accountId: { not: 'x' } },
                        { region: { notIn: ['eu-west-1'] } },
                        { resourceType: { equals: 'ec2_instances' } },
                    ],
                },
            ],
        });
    });

    it('treats a bare literal as $eq', () => {
        expect(readFilterFor(abilityOf([{ action: 'read', subject: 'Schedule', conditions: { active: true } }]), 'Schedule')).toEqual(
            { OR: [{ active: { equals: true } }] }
        );
    });

    it('unions multiple matching rules and keeps an inverted rule as NOT', () => {
        const filter = readFilterFor(
            abilityOf([
                { action: 'read', subject: 'Schedule', conditions: { accountId: 'a' } },
                { action: 'read', subject: 'Schedule', inverted: true, conditions: { active: false } },
            ]),
            'Schedule'
        );
        expect(filter).toEqual({
            OR: [{ AND: [{ accountId: { equals: 'a' } }, { NOT: { active: { equals: false } } }] }],
        });
    });

    it('maps a registry path onto a differently-named column', () => {
        // Certificate.domain lives in the `domainName` column.
        expect(
            readFilterFor(
                abilityOf([{ action: 'read', subject: 'Certificate', conditions: { domain: 'x.example.com' } }]),
                'Certificate'
            )
        ).toEqual({ OR: [{ domainName: { equals: 'x.example.com' } }] });
    });

    it('translates a Json path attribute', () => {
        expect(
            readFilterFor(
                abilityOf([
                    {
                        action: 'read',
                        subject: 'Resource',
                        conditions: { 'tags.Environment': { $in: ['prod', 'stage'] } },
                    },
                ]),
                'Resource'
            )
        ).toEqual({
            OR: [
                {
                    OR: [
                        { tags: { path: ['Environment'], equals: 'prod' } },
                        { tags: { path: ['Environment'], equals: 'stage' } },
                    ],
                },
            ],
        });
    });

    it('translates mongo $or/$and/$not logical operators', () => {
        expect(
            readFilterFor(
                abilityOf([
                    {
                        action: 'read',
                        subject: 'Resource',
                        conditions: { $or: [{ region: 'us-east-1' }, { $not: { accountId: '1' } }] },
                    },
                ]),
                'Resource'
            )
        ).toEqual({
            OR: [{ OR: [{ region: { equals: 'us-east-1' } }, { NOT: { accountId: { equals: '1' } } }] }],
        });
    });

    // ── Fail closed, never partially ────────────────────────────────────────
    it('throws rather than dropping an attribute it cannot map to a column', () => {
        // Certificate/accountId IS declared in the registry but has no column on
        // the certificates table (linkage lives in certificate_deployments, with
        // no Prisma relation). Dropping the conjunct would return every
        // certificate in the tenant to a caller scoped to one account.
        expect(() =>
            readFilterFor(
                abilityOf([{ action: 'read', subject: 'Certificate', conditions: { accountId: '111' } }]),
                'Certificate'
            )
        ).toThrow(UntranslatableFilterError);
    });

    /**
     * NARROWED from "any unmapped subject throws" to "an unmapped subject throws
     * once a rule actually references an attribute on it".
     *
     * The blanket version made an unconditional grant on a subject with nothing
     * to push down throw, which 500'd every list endpoint whose subject has no
     * filterable attributes. The safety it was protecting is intact and proven
     * below: a typo'd or unknown subject never reaches the unrestricted branch,
     * because no rule matches it and accessibleBy() returns `{OR: []}` — a
     * deny-all — instead.
     */
    it('throws on an unknown subject once a rule references an attribute on it', () => {
        expect(() =>
            readFilterFor(
                abilityOf([{ action: 'read', subject: 'Nope', conditions: { anything: 'x' } }]),
                'Nope'
            )
        ).toThrow(UntranslatableFilterError);
    });

    it('fails closed for a subject no rule grants, rather than returning unrestricted', () => {
        const filter = readFilterFor(abilityOf([{ action: 'read', subject: 'Schedule' }]), 'Nope');

        expect(isUnrestricted(filter)).toBe(false);
        expect(JSON.stringify(filter)).toContain('"OR":[]');
    });

    it('throws on an operator with no exact Prisma equivalent on a Json path', () => {
        expect(() =>
            readFilterFor(
                abilityOf([
                    { action: 'read', subject: 'Resource', conditions: { 'tags.Environment': { $exists: true } } },
                ]),
                'Resource'
            )
        ).toThrow(UntranslatableFilterError);
    });

    it('translates $exists on a scalar column to IS NULL / IS NOT NULL', () => {
        const present = readFilterFor(
            abilityOf([{ action: 'read', subject: 'Schedule', conditions: { accountId: { $exists: true } } }]),
            'Schedule',
        );
        expect(present).toEqual({ OR: [{ accountId: { not: null } }] });

        const absent = readFilterFor(
            abilityOf([{ action: 'read', subject: 'Schedule', conditions: { accountId: { $exists: false } } }]),
            'Schedule',
        );
        expect(absent).toEqual({ OR: [{ accountId: { equals: null } }] });
    });

    it('throws on a scalar operator with no Prisma equivalent', () => {
        expect(() =>
            readFilterFor(
                abilityOf([{ action: 'read', subject: 'Schedule', conditions: { accountId: { $size: 1 } } }]),
                'Schedule',
            ),
        ).toThrow(UntranslatableFilterError);
    });

    it('translates a bare (non-operator) Json path value as $eq', () => {
        const filter = readFilterFor(
            abilityOf([{ action: 'read', subject: 'Resource', conditions: { 'tags.Environment': 'prod' } }]),
            'Resource',
        );
        expect(filter).toEqual({ OR: [{ tags: { path: ['Environment'], equals: 'prod' } }] });
    });

    it('translates $eq and $ne on a Json path', () => {
        const filter = readFilterFor(
            abilityOf([{ action: 'read', subject: 'Resource', conditions: { 'tags.Environment': { $eq: 'prod' } } }]),
            'Resource',
        );
        expect(filter).toEqual({ OR: [{ tags: { path: ['Environment'], equals: 'prod' } }] });

        const neFilter = readFilterFor(
            abilityOf([{ action: 'read', subject: 'Resource', conditions: { 'tags.Environment': { $ne: 'prod' } } }]),
            'Resource',
        );
        expect(neFilter).toEqual({ OR: [{ NOT: { tags: { path: ['Environment'], equals: 'prod' } } }] });
    });

    it('translates $nin on a Json path to a negated union', () => {
        const filter = readFilterFor(
            abilityOf([
                { action: 'read', subject: 'Resource', conditions: { 'tags.Environment': { $nin: ['prod', 'stage'] } } },
            ]),
            'Resource',
        );
        expect(filter).toEqual({
            OR: [{
                NOT: {
                    OR: [
                        { tags: { path: ['Environment'], equals: 'prod' } },
                        { tags: { path: ['Environment'], equals: 'stage' } },
                    ],
                },
            }],
        });
    });

    it('wraps multiple operators on the same Json path in an AND', () => {
        const filter = readFilterFor(
            abilityOf([{
                action: 'read', subject: 'Resource',
                conditions: { 'tags.Environment': { $ne: 'dev', $in: ['prod', 'stage'] } },
            }]),
            'Resource',
        );
        expect(filter).toEqual({
            OR: [{
                AND: [
                    { NOT: { tags: { path: ['Environment'], equals: 'dev' } } },
                    {
                        OR: [
                            { tags: { path: ['Environment'], equals: 'prod' } },
                            { tags: { path: ['Environment'], equals: 'stage' } },
                        ],
                    },
                ],
            }],
        });
    });

    it('throws when $in/$nin on a Json path is not given an array', () => {
        expect(() =>
            readFilterFor(
                abilityOf([{ action: 'read', subject: 'Resource', conditions: { 'tags.Environment': { $in: 'prod' } } }]),
                'Resource',
            ),
        ).toThrow(UntranslatableFilterError);
        expect(() =>
            readFilterFor(
                abilityOf([{ action: 'read', subject: 'Resource', conditions: { 'tags.Environment': { $nin: 'prod' } } }]),
                'Resource',
            ),
        ).toThrow(UntranslatableFilterError);
    });

    it('throws when a Json path condition carries no operators at all', () => {
        expect(() =>
            readFilterFor(
                abilityOf([{ action: 'read', subject: 'Resource', conditions: { 'tags.Environment': {} } }]),
                'Resource',
            ),
        ).toThrow(UntranslatableFilterError);
    });

    it('throws when a condition node nests deeper than the compiler could ever produce', () => {
        // MAX_DEPTH=5 is enforced at compile time; this constructs a hand-built
        // rule bypassing that cap to prove the translator's own defense-in-depth.
        let deep: Record<string, unknown> = { accountId: 'x' };
        for (let i = 0; i < 13; i++) deep = { $and: [deep] };
        expect(() =>
            readFilterFor(abilityOf([{ action: 'read', subject: 'Schedule', conditions: deep }]), 'Schedule'),
        ).toThrow(UntranslatableFilterError);
    });

    it('throws when a condition node is not an object at all', () => {
        expect(() =>
            readFilterFor(
                abilityOf([{ action: 'read', subject: 'Schedule', conditions: { $not: 'not-an-object' } }]),
                'Schedule',
            ),
        ).toThrow(UntranslatableFilterError);
    });

    it('throws when AND/OR (the accessibleBy envelope shape) is not an array', () => {
        expect(() =>
            readFilterFor(
                abilityOf([{ action: 'read', subject: 'Schedule', conditions: { AND: 'not-an-array' } as any }]),
                'Schedule',
            ),
        ).toThrow(UntranslatableFilterError);
    });

    it('throws when $and/$or (mongo-style) is not an array', () => {
        expect(() =>
            readFilterFor(
                abilityOf([{ action: 'read', subject: 'Schedule', conditions: { $and: 'not-an-array' } as any }]),
                'Schedule',
            ),
        ).toThrow(UntranslatableFilterError);
    });

    it('throws on an unrecognized $-prefixed operator at the condition level', () => {
        expect(() =>
            readFilterFor(
                abilityOf([{ action: 'read', subject: 'Schedule', conditions: { $foo: 'x' } as any }]),
                'Schedule',
            ),
        ).toThrow(UntranslatableFilterError);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// The composition invariant — this is the point of the workstream
// ─────────────────────────────────────────────────────────────────────────────

describe('andWhere + tenant scope — the CASL filter intersects, never replaces', () => {
    it('keeps the tenant predicate at the top level of the query Prisma receives', () => {
        const ability = abilityOf([
            { action: 'read', subject: 'Schedule', conditions: { accountId: { $in: ['a'] } } },
        ]);

        const where = composedWhere(ability, 'Schedule', 'Schedule', { tenantId: TENANT, active: true });

        // The predicate that stops a cross-tenant read.
        expect(where.tenantId).toBe(TENANT);
        // …and it is a top-level conjunct, not buried in an OR where it could be
        // satisfied by the other branch.
        expect(Object.keys(where)).toContain('tenantId');
        // The CASL filter is present, and only under AND.
        expect(where.AND).toEqual([{ OR: [{ accountId: { in: ['a'] } }] }]);
    });

    it('survives a deny-all filter — still tenant scoped, still matches nothing', () => {
        const where = composedWhere(abilityOf([]), 'Schedule', 'Schedule', { tenantId: TENANT });
        expect(where.tenantId).toBe(TENANT);
        expect(where.AND).toEqual([{ OR: [] }]);
    });

    it('does NOT let the CASL filter clobber the repository search clause', () => {
        // The bug a naive `{...where, ...filter}` merge would introduce: both
        // sides use OR at the top level, so one silently deletes the other. If
        // the repository's OR won, the authorization filter would vanish.
        const ability = abilityOf([
            { action: 'read', subject: 'SpotGuard', conditions: { accountId: { $in: ['a'] } } },
        ]);
        const repoWhere = {
            tenantId: TENANT,
            OR: [{ serviceName: { contains: 'api', mode: 'insensitive' } }],
        };

        const where = composedWhere(ability, 'SpotGuard', 'SpotGuardService', repoWhere);

        expect(where.OR).toEqual(repoWhere.OR); // search clause intact
        expect(where.AND).toEqual([{ OR: [{ accountId: { in: ['a'] } }] }]); // filter intact
        expect(where.tenantId).toBe(TENANT);
    });

    it('a row filter carrying its own tenantId cannot re-home the query', () => {
        // The attack shape: a rule condition that names another tenant. It is
        // nested under AND, and applyTenantScope() spreads the real tenantId in
        // LAST at the top level, so the result is `tenant-a AND tenant-b` —
        // empty — never `tenant-b`.
        const hostile = { tenantId: OTHER_TENANT };
        const scoped = andWhere({ tenantId: TENANT }, hostile);
        const where = applyTenantScope('Schedule', 'findMany', { where: scoped }, TENANT).where;

        expect(where.tenantId).toBe(TENANT);
        expect(where.AND).toEqual([{ tenantId: OTHER_TENANT }]);
    });

    it('applies to count() as well as findMany() — pagination totals stay filtered', () => {
        const ability = abilityOf([
            { action: 'read', subject: 'Certificate', conditions: { domain: 'x.example.com' } },
        ]);
        const filter = readFilterFor(ability, 'Certificate');
        const scoped = andWhere({ tenantId: TENANT }, filter);

        for (const operation of ['findMany', 'count']) {
            const where = applyTenantScope('Certificate', operation, { where: scoped }, TENANT).where;
            expect(where.tenantId).toBe(TENANT);
            expect(where.AND).toEqual([{ OR: [{ domainName: { equals: 'x.example.com' } }] }]);
        }
    });

    it('andWhere appends to an existing AND rather than overwriting it', () => {
        expect(andWhere({ AND: [{ a: 1 }] }, { b: 2 })).toEqual({ AND: [{ a: 1 }, { b: 2 }] });
        expect(andWhere({ AND: { a: 1 } }, { b: 2 })).toEqual({ AND: [{ a: 1 }, { b: 2 }] });
    });

    it('andWhere is a no-op for an empty or absent filter', () => {
        expect(andWhere({ tenantId: TENANT }, null)).toEqual({ tenantId: TENANT });
        expect(andWhere({ tenantId: TENANT }, {})).toEqual({ tenantId: TENANT });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Properties
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Evaluates the subset of Prisma `where` this pipeline can emit.
 *
 * Deliberately small: `equals | not | in | notIn` on scalars, plus AND/OR/NOT and
 * top-level scalar shorthand. It exists so the monotonicity property below is a
 * statement about ROWS rather than about object shapes.
 */
function matches(where: Record<string, unknown>, row: Record<string, unknown>): boolean {
    return Object.entries(where).every(([key, value]) => {
        if (key === 'AND') return (value as Record<string, unknown>[]).every((w) => matches(w, row));
        if (key === 'OR') return (value as Record<string, unknown>[]).some((w) => matches(w, row));
        if (key === 'NOT') return !matches(value as Record<string, unknown>, row);

        const actual = row[key];
        if (value === null || typeof value !== 'object') return actual === value;

        return Object.entries(value as Record<string, unknown>).every(([op, operand]) => {
            switch (op) {
                case 'equals':
                    return actual === operand;
                case 'not':
                    return actual !== operand;
                case 'in':
                    return (operand as unknown[]).includes(actual);
                case 'notIn':
                    return !(operand as unknown[]).includes(actual);
                default:
                    throw new Error(`test evaluator does not model operator '${op}'`);
            }
        });
    });
}

const accountIdArb = fc.constantFrom('acc-1', 'acc-2', 'acc-3');

/** Arbitrary read rules for Schedule — conditional, unconditional and inverted. */
const scheduleRulesArb = fc.array(
    fc.oneof(
        fc.record({
            action: fc.constant('read'),
            subject: fc.constant('Schedule'),
        }),
        fc.record({
            action: fc.constant('read'),
            subject: fc.constant('Schedule'),
            conditions: fc.oneof(
                fc.record({ accountId: accountIdArb }),
                fc.record({ accountId: fc.record({ $in: fc.array(accountIdArb, { maxLength: 3 }) }) }),
                fc.record({ active: fc.boolean() }),
                fc.record({ accountId: fc.record({ $ne: accountIdArb }) })
            ),
        }),
        fc.record({
            action: fc.constant('read'),
            subject: fc.constant('Schedule'),
            inverted: fc.constant(true),
            conditions: fc.record({ accountId: accountIdArb }),
        }),
        // Rules that must contribute nothing to a `read Schedule` filter.
        fc.record({ action: fc.constant('update'), subject: fc.constant('Schedule') }),
        fc.record({ action: fc.constant('read'), subject: fc.constant('Account') })
    ),
    { maxLength: 5 }
);

const rowArb = fc.record({
    tenantId: fc.constantFrom(TENANT, OTHER_TENANT),
    accountId: accountIdArb,
    active: fc.boolean(),
});

describe('property: the composed filter never widens beyond the tenant', () => {
    it('every row the composed query matches belongs to the caller tenant', () => {
        fc.assert(
            fc.property(scheduleRulesArb, fc.array(rowArb, { maxLength: 25 }), (rules, rows) => {
                const where = composedWhere(abilityOf(rules as Rule[]), 'Schedule', 'Schedule', {
                    tenantId: TENANT,
                });

                for (const row of rows) {
                    if (matches(where, row)) {
                        expect(row.tenantId).toBe(TENANT);
                    }
                }
            }),
            { numRuns: 300 }
        );
    });

    it('adding the row filter can only ever remove rows, never add them', () => {
        // Monotonicity: tenant-only is the upper bound. Whatever the registry
        // says, `tenant ∧ casl` ⊆ `tenant`.
        fc.assert(
            fc.property(scheduleRulesArb, fc.array(rowArb, { maxLength: 25 }), (rules, rows) => {
                const tenantOnly = applyTenantScope('Schedule', 'findMany', { where: {} }, TENANT)
                    .where as Record<string, unknown>;
                const withFilter = composedWhere(abilityOf(rules as Rule[]), 'Schedule', 'Schedule', {
                    tenantId: TENANT,
                });

                const before = rows.filter((r) => matches(tenantOnly, r));
                const after = rows.filter((r) => matches(withFilter, r));

                expect(after.length).toBeLessThanOrEqual(before.length);
                for (const row of after) expect(before).toContain(row);
            }),
            { numRuns: 300 }
        );
    });

    it('the tenant predicate is structurally intact for any ability and any base where', () => {
        const baseArb = fc.record(
            {
                tenantId: fc.constant(TENANT),
                OR: fc.option(fc.constant([{ name: { contains: 'x' } }]), { nil: undefined }),
                AND: fc.option(fc.constant([{ active: true }]), { nil: undefined }),
                accountId: fc.option(accountIdArb, { nil: undefined }),
            },
            { noNullPrototype: true }
        );

        fc.assert(
            fc.property(scheduleRulesArb, baseArb, (rules, rawBase) => {
                const base = Object.fromEntries(
                    Object.entries(rawBase).filter(([, v]) => v !== undefined)
                ) as Record<string, unknown>;

                const where = composedWhere(abilityOf(rules as Rule[]), 'Schedule', 'Schedule', { ...base });

                // 1. The tenant predicate is a top-level conjunct with the right value.
                expect(where.tenantId).toBe(TENANT);

                // 2. Every key the repository put in the base survives untouched —
                //    the filter is additive, so it cannot delete a narrowing clause
                //    (which would widen the result) nor the tenant one.
                for (const [key, value] of Object.entries(base)) {
                    if (key === 'AND') continue; // legitimately extended, checked below
                    expect(where[key]).toEqual(value);
                }

                // 3. The filter only ever lands inside AND.
                if (Array.isArray(base.AND)) {
                    expect((where.AND as unknown[]).slice(0, base.AND.length)).toEqual(base.AND);
                }
            }),
            { numRuns: 300 }
        );
    });
});

/**
 * Regression: an UNCONDITIONAL grant on a subject with no Prisma field map must
 * translate, not throw.
 *
 * SUBJECT_FIELDS is a deliberate allowlist, but it was consulted at the top of
 * translateNode rather than at the point of use — so a subject with nothing to
 * push down failed before discovering there was nothing to push down. Wiring the
 * row filter into the remaining list endpoints turned that into a 500 on every
 * one of them (`Account` was the first to surface it).
 *
 * The allowlist must keep its teeth for rules that DO reference an attribute.
 */
describe('readFilterFor — subjects with no Prisma field map', () => {
    it('translates an unconditional grant instead of throwing', () => {
        const ability = abilityOf([{ action: 'read', subject: 'Account' }]);

        const filter = readFilterFor(ability, 'Account');

        // Nothing to narrow by: the tenant predicate from getTenantClient() is
        // still applied separately, so "unrestricted" here is correct, not a leak.
        expect(isUnrestricted(filter)).toBe(true);
    });

    it('still fails closed when no rule grants the subject at all', () => {
        const ability = abilityOf([{ action: 'read', subject: 'Schedule' }]);

        // accessibleBy() yields `{OR: []}` — matches nothing — and that must
        // survive translation verbatim rather than degrading to unrestricted.
        const filter = readFilterFor(ability, 'Account');

        expect(isUnrestricted(filter)).toBe(false);
        expect(JSON.stringify(filter)).toContain('"OR":[]');
    });

    it('translates the one Account attribute that maps to a real column', () => {
        const ability = abilityOf([
            { action: 'read', subject: 'Account', conditions: { accountId: 'acct-1' } },
        ]);

        expect(JSON.stringify(readFilterFor(ability, 'Account'))).toContain('acct-1');
    });

    it('still throws on an Account attribute the model cannot support', () => {
        // The registry declares `alias` and `tags.Environment` for Account, but
        // the model has neither column. This is the case the allowlist exists
        // for: mapping `alias` onto `name` would silently filter a different
        // field than the rule author asked for.
        for (const conditions of [{ alias: 'prod' }, { 'tags.Environment': 'prod' }]) {
            const ability = abilityOf([{ action: 'read', subject: 'Account', conditions }]);
            expect(() => readFilterFor(ability, 'Account')).toThrow(UntranslatableFilterError);
        }
    });
});

describe('unmappedAttributePaths', () => {
    it('returns nothing when every declared path is mapped', () => {
        expect(
            unmappedAttributePaths([
                { subjectKey: 'Schedule', path: 'accountId' },
                { subjectKey: 'Schedule', path: 'active' },
            ]),
        ).toEqual([]);
    });

    it('flags a declared path with no field mapping on a mapped subject', () => {
        expect(unmappedAttributePaths([{ subjectKey: 'Account', path: 'alias' }])).toEqual([
            'Account.alias',
        ]);
    });

    it('flags every declared path on a subject with no field map at all', () => {
        expect(
            unmappedAttributePaths([
                { subjectKey: 'Memory', path: 'category' },
                { subjectKey: 'Skill', path: 'slug' },
            ]),
        ).toEqual(['Memory.category', 'Skill.slug']);
    });

    it('returns violations sorted and deduplicated', () => {
        expect(
            unmappedAttributePaths([
                { subjectKey: 'Zeta', path: 'b' },
                { subjectKey: 'Alpha', path: 'a' },
                { subjectKey: 'Zeta', path: 'b' },
            ]),
        ).toEqual(['Alpha.a', 'Zeta.b']);
    });
});

describe('unmapped subjects do not break unconditional grants', () => {
    it('returns an empty filter for an unconditional grant on a subject with no field map', () => {
        // Regression guard. An earlier version looked SUBJECT_FIELDS up before
        // inspecting the conditions, so a grant with nothing to narrow threw and
        // 500'd every list endpoint whose subject has no mapped attributes. The
        // lookup is deliberately deferred into the attribute-path branch; this
        // test is what keeps it there.
        const ability = abilityOf([{ action: 'read', subject: 'Memory' }]);

        expect(readFilterFor(ability, 'Memory')).toEqual({});
    });

    it('still throws when a rule actually references an attribute on such a subject', () => {
        const ability = abilityOf([
            { action: 'read', subject: 'Memory', conditions: { category: 'ops' } },
        ]);

        expect(() => readFilterFor(ability, 'Memory')).toThrow(UntranslatableFilterError);
    });
});
