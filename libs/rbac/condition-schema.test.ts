import { describe, expect, it } from 'vitest';

import { assertValidCondition, collectVarPaths, MAX_NODES, validateCondition } from './condition-schema';
import type { ConditionContext } from './condition-schema';
import type { RbacPrincipalAttributeRow, RbacSubjectAttributeRow } from './registry-types';

const subjectAttributes: RbacSubjectAttributeRow[] = [
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
        path: 'active',
        label: 'Active',
        valueType: 'boolean',
        operators: ['$eq', '$ne'],
        enumValues: [],
    },
    {
        tenantId: null,
        subjectId: 's-sched',
        path: 'createdAt',
        label: 'Created',
        valueType: 'date',
        operators: ['$gt', '$lt', '$eq'],
        enumValues: [],
    },
];

const principalAttributes: RbacPrincipalAttributeRow[] = [
    { tenantId: null, key: 'user.email', label: 'Email', valueType: 'string', source: 'builtin' },
    {
        tenantId: null,
        key: 'user.allowedAccountIds',
        label: 'Allowed accounts',
        valueType: 'string[]',
        source: 'user',
    },
];

const ctx: ConditionContext = { subjectAttributes, principalAttributes };

function issues(ast: unknown): string[] {
    const result = validateCondition(ast, ctx);
    return result.ok ? [] : result.issues;
}

describe('condition schema — accepted shapes', () => {
    it('accepts a literal shorthand', () => {
        expect(validateCondition({ accountId: 'dev-1' }, ctx).ok).toBe(true);
    });

    it('accepts an explicit operator', () => {
        expect(validateCondition({ accountId: { $ne: 'prod-1' } }, ctx).ok).toBe(true);
    });

    it('accepts a $var of matching list type with $in', () => {
        expect(
            validateCondition({ accountId: { $in: { $var: 'user.allowedAccountIds' } } }, ctx).ok
        ).toBe(true);
    });

    it('accepts a top-level $var shorthand on an attribute, equivalent to $eq', () => {
        expect(validateCondition({ accountId: { $var: 'user.email' } }, ctx).ok).toBe(true);
        expect(issues({ accountId: { $var: 'user.smuggled' } }).join(' ')).toMatch(
            /not a declared principal attribute/
        );
    });

    it('accepts logical grouping', () => {
        const ast = {
            $and: [{ accountId: { $in: { $var: 'user.allowedAccountIds' } } }, { active: { $eq: true } }],
        };
        expect(validateCondition(ast, ctx).ok).toBe(true);
    });
});

describe('condition schema — code execution and ReDoS operators', () => {
    it.each([
        ['$where', 'executes JavaScript'],
        ['$function', 'executes JavaScript'],
        ['$expr', 'evaluates arbitrary expressions'],
        ['$regex', 'ReDoS'],
    ])('rejects %s', (operator) => {
        const nested = issues({ accountId: { [operator]: 'anything' } });
        const topLevel = issues({ [operator]: 'anything' });

        expect(nested.join(' ')).toMatch(new RegExp(`\\${operator}.*forbidden`));
        expect(topLevel.join(' ')).toMatch(new RegExp(`\\${operator}.*forbidden`));
    });
});

describe('condition schema — registry-aware checks', () => {
    it('rejects an attribute the subject does not declare', () => {
        expect(issues({ secretColumn: 'x' }).join(' ')).toMatch(/not declared for this subject/);
    });

    it('rejects an operator outside the attribute whitelist', () => {
        // 'active' permits only $eq/$ne
        expect(issues({ active: { $in: [true] } }).join(' ')).toMatch(/not permitted on attribute 'active'/);
    });

    it('rejects a $var that is not a declared principal attribute', () => {
        expect(issues({ accountId: { $eq: { $var: 'user.smuggled' } } }).join(' ')).toMatch(
            /not a declared principal attribute/
        );
    });

    it('rejects a scalar operand for $in', () => {
        expect(issues({ accountId: { $in: 'dev-1' } }).join(' ')).toMatch(/requires an array or a \$var of list type/);
    });

    it('rejects a $var of scalar type used with $in', () => {
        expect(issues({ accountId: { $in: { $var: 'user.email' } } }).join(' ')).toMatch(/needs a list/);
    });

    it('rejects an ordered operator on a string attribute', () => {
        expect(issues({ accountId: { $gt: 5 } }).join(' ')).toMatch(/not permitted on attribute 'accountId'/);
    });

    it('rejects a string operand for an ordered operator', () => {
        expect(issues({ createdAt: { $gt: 'not-a-date' } }).join(' ')).toMatch(/requires a number or a date/);
    });

    it('rejects an unknown operator', () => {
        expect(issues({ accountId: { $bogus: 1 } }).join(' ')).toMatch(/unknown operator/);
    });
});

describe('condition schema — limits', () => {
    it('rejects nesting deeper than the cap', () => {
        let ast: Record<string, unknown> = { accountId: 'x' };
        for (let i = 0; i < 8; i++) ast = { $not: ast };
        expect(issues(ast).join(' ')).toMatch(/nests deeper/);
    });

    it('rejects more nodes than the cap', () => {
        const entries = Array.from({ length: MAX_NODES + 20 }, () => ({ accountId: 'x' }));
        expect(issues({ $and: entries }).join(' ')).toMatch(/exceeds the maximum/);
    });
});

describe('condition schema — malformed top-level input', () => {
    it('rejects a non-object top-level ast', () => {
        expect(issues('not-an-object').join(' ')).toMatch(/condition must be an object/);
        expect(issues(null).join(' ')).toMatch(/condition must be an object/);
        expect(issues([1, 2]).join(' ')).toMatch(/condition must be an object/);
    });

    it('rejects an unknown operator at the top level', () => {
        expect(issues({ $bogus: 'x' }).join(' ')).toMatch(/unknown operator '\$bogus' at the top level/);
    });
});

describe('condition schema — logical operator shape errors', () => {
    it('rejects $not with a non-object value', () => {
        expect(issues({ $not: 'oops' }).join(' ')).toMatch(/'\$not' takes a condition object/);
    });

    it('rejects $and/$or with a non-array value', () => {
        expect(issues({ $and: 'oops' }).join(' ')).toMatch(/'\$and' takes an array of condition objects/);
    });

    it('rejects a non-object entry inside $and/$or', () => {
        expect(issues({ $and: ['oops', { accountId: 'x' }] }).join(' ')).toMatch(
            /'\$and' entries must be condition objects/
        );
    });

    it('rejects a logical operator used directly on an attribute', () => {
        expect(issues({ accountId: { $and: [{}] } }).join(' ')).toMatch(
            /'\$and' cannot be used directly on attribute 'accountId'/
        );
    });
});

describe('condition schema — attribute value shape errors', () => {
    it('rejects a bare array on an attribute', () => {
        expect(issues({ accountId: ['dev-1', 'dev-2'] }).join(' ')).toMatch(/cannot take a bare array/);
    });

    it('rejects an unsupported value type on an attribute', () => {
        expect(issues({ accountId: undefined }).join(' ')).toMatch(/has an unsupported value/);
    });
});

describe('condition schema — operator-specific operand checks', () => {
    it('reports "none" when an attribute permits no operators at all', () => {
        const noOpAttributes: RbacSubjectAttributeRow[] = [
            {
                tenantId: null,
                subjectId: 's-sched',
                path: 'locked',
                label: 'Locked',
                valueType: 'boolean',
                operators: [],
                enumValues: [],
            },
        ];
        const noOpCtx: ConditionContext = { subjectAttributes: noOpAttributes, principalAttributes };
        const result = validateCondition({ locked: true }, noOpCtx);
        expect(result.ok).toBe(false);
        expect(!result.ok && result.issues.join(' ')).toMatch(/\(allowed: none\)/);
    });

    it('validates $exists requires a boolean operand', () => {
        expect(issues({ active: { $exists: 'nope' } }).join(' ')).toMatch(/'\$exists' on 'active' requires a boolean/);
        expect(issues({ active: { $exists: true } }).join(' ')).not.toMatch(/requires a boolean/);
    });

    it('validates $size requires a number operand', () => {
        expect(issues({ active: { $size: 'nope' } }).join(' ')).toMatch(/'\$size' on 'active' requires a number/);
        expect(issues({ active: { $size: 3 } }).join(' ')).not.toMatch(/requires a number/);
    });

    it('rejects a non-literal, non-$var operand for $eq/$ne', () => {
        expect(issues({ accountId: { $eq: { arbitrary: 'object' } } }).join(' ')).toMatch(
            /'\$eq' on 'accountId' requires a literal value or a \$var node/
        );
    });

    it('validates array-operand items individually: $var, literal, and invalid item', () => {
        const result = issues({
            accountId: { $in: [{ $var: 'user.allowedAccountIds' }, 'literal-1', { bogus: 1 }] },
        });
        expect(result.join(' ')).toMatch(/accepts only literals or \$var nodes/);
    });
});

describe('condition schema — $var operand on an ordered operator', () => {
    it('rejects a $var of non-ordered principal type used with an ordered operator', () => {
        expect(issues({ createdAt: { $gt: { $var: 'user.email' } } }).join(' ')).toMatch(
            /needs a number or date, but '\$var: user\.email' is declared string/
        );
    });
});

describe('condition schema — depth cap enforced past the top-level ast walk', () => {
    it('hits the depth cap while walking into an attribute value', () => {
        let ast: Record<string, unknown> = { accountId: 'x' };
        for (let i = 0; i < 4; i++) ast = { $not: ast };
        expect(issues(ast).join(' ')).toMatch(/nests deeper/);
    });

    it('hits the depth cap while checking an operand', () => {
        let ast: Record<string, unknown> = { createdAt: { $gt: 5 } };
        for (let i = 0; i < 3; i++) ast = { $not: ast };
        expect(issues(ast).join(' ')).toMatch(/nests deeper/);
    });

    it('only reports the depth-exceeded message once across two independently-deep branches', () => {
        const makeDeep = (): Record<string, unknown> => {
            let ast: Record<string, unknown> = { accountId: 'x' };
            for (let i = 0; i < 8; i++) ast = { $not: ast };
            return ast;
        };
        const result = issues({ $and: [makeDeep(), makeDeep()] });
        expect(result.filter((m) => m.startsWith('condition nests'))).toHaveLength(1);
    });

    it('rejects more than the node cap when the excess nodes are array-operand items', () => {
        const items = Array.from({ length: MAX_NODES + 10 }, (_, i) => `v${i}`);
        expect(issues({ accountId: { $in: items } }).join(' ')).toMatch(/exceeds the maximum/);
    });

    it('hits the node cap before processing a second logical operator sibling', () => {
        const bigArray = Array.from({ length: MAX_NODES + 5 }, () => ({ accountId: 'x' }));
        const ast = { $and: bigArray, $or: [{ accountId: 'y' }] };
        expect(issues(ast).join(' ')).toMatch(/exceeds the maximum/);
    });
});

describe('assertValidCondition', () => {
    it('does not throw for a valid condition', () => {
        expect(() => assertValidCondition({ accountId: 'dev-1' }, ctx)).not.toThrow();
    });

    it('throws with the joined issues for an invalid condition', () => {
        expect(() => assertValidCondition({ secretColumn: 'x' }, ctx)).toThrow(/not declared for this subject/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// The regression that justifies the whole {"$var": path} design.
//
// The tutorial approach stores '{"createdBy": "${user.email}"}' and does a
// find-and-replace before JSON.parse. An email containing a quote and a brace
// then REWRITES THE RULE'S STRUCTURE — and emails are attacker-influenceable
// through the invitation flow, so this is reachable, not theoretical.
// ─────────────────────────────────────────────────────────────────────────────

describe('condition schema — injection regression', () => {
    const HOSTILE_EMAIL = 'a"}, "x": {"$gt": ""';

    it('treats a hostile email as one literal string, leaving the structure intact', () => {
        const ast = { accountId: { $eq: { $var: 'user.email' } } };
        expect(validateCondition(ast, ctx).ok).toBe(true);

        // Substitution is by assignment, so the value lands in exactly one slot.
        const resolved = JSON.parse(JSON.stringify(ast).replace('{"$var":"user.email"}', JSON.stringify(HOSTILE_EMAIL)));

        expect(resolved).toEqual({ accountId: { $eq: HOSTILE_EMAIL } });
        expect(Object.keys(resolved)).toEqual(['accountId']);
        expect(Object.keys(resolved.accountId)).toEqual(['$eq']);
        // No '$gt' key was smuggled in anywhere.
        expect(JSON.stringify(resolved)).not.toContain('"$gt":');
    });

    it('demonstrates why string interpolation is unsafe — the rejected approach', () => {
        // Documented so the unsafe pattern is not reintroduced by someone
        // "simplifying" the $var nodes away. This is the shape the payload is
        // built for: the condition nested inside a wrapper object, which is how
        // a stored rule actually looks.
        const stored = '{"conditions": {"createdBy": "${user.email}"}}';

        // The exact bytes of a working payload depend on how many braces the
        // template closes after the injection point — which is precisely why
        // "just escape the quotes" is not a fix. This one is crafted for the
        // template above; the plan quotes a variant aimed at a shallower one.
        const craftedForThisTemplate = 'a"}, "x": {"$gt": "';

        const interpolated = stored.replace('${user.email}', craftedForThisTemplate);
        const parsed = JSON.parse(interpolated) as Record<string, unknown>;

        // The attacker gained a top-level key the admin never wrote, carrying an
        // operator of their choosing — the rule's STRUCTURE changed.
        expect(Object.keys(parsed)).toContain('x');
        expect(parsed.x).toEqual({ $gt: '' });
        expect(Object.keys(parsed).length).toBeGreaterThan(1);
    });
});

describe('collectVarPaths', () => {
    it('finds every $var reference at any depth', () => {
        const paths = collectVarPaths({
            accountId: { $in: { $var: 'user.allowedAccountIds' } },
            $and: [{ createdBy: { $eq: { $var: 'user.email' } } }],
        });
        expect(paths.sort()).toEqual(['user.allowedAccountIds', 'user.email']);
    });

    it('ignores literal leaves that are neither arrays nor objects', () => {
        expect(collectVarPaths({ accountId: 'dev-1', active: true, count: 5 })).toEqual([]);
    });
});
