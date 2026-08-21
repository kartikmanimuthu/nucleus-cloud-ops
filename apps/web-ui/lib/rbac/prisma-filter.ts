/**
 * Gate 3 — row filtering. Turns a compiled CASL ability into a Prisma `where`
 * fragment so a LIST endpoint returns only the rows the caller may read.
 *
 * Gate 2 (`authorize()`) answers "may you read Schedules at all". On a list
 * endpoint that is the wrong question: a role granted `read Schedule` only
 * `{accountId: {$in: [...]}}` passes Gate 2 and then receives every schedule in
 * the tenant, because there is no single row to evaluate the condition against.
 * This file is the answer to the right question — "which Schedules" — pushed
 * down into SQL rather than filtered in application code, so pagination and
 * counts stay correct.
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║ WHY THIS FILE EXISTS AT ALL, RATHER THAN A ONE-LINE accessibleBy() CALL  ║
 * ║                                                                          ║
 * ║ `@casl/prisma` does NOT translate conditions. `accessibleBy().ofType()`  ║
 * ║ combines the matching rules into an `{OR|AND|NOT}` envelope and passes   ║
 * ║ each rule's `conditions` object through VERBATIM — it assumes the        ║
 * ║ ability was built with `createPrismaAbility()`, i.e. that the conditions ║
 * ║ are already written in Prisma syntax.                                    ║
 * ║                                                                          ║
 * ║ Ours are not. The registry stores MongoDB-syntax conditions (`$in`,      ║
 * ║ `$eq`, `$and`, … — see libs/rbac/condition-schema.ts) because the same   ║
 * ║ conditions must also be evaluated IN MEMORY by `ability.can(action,      ║
 * ║ subject(type, row))` in authorize.ts, which needs the mongo matcher.     ║
 * ║ Handing `{accountId: {$in: [...]}}` straight to Prisma throws            ║
 * ║ `Unknown argument $in`.                                                  ║
 * ║                                                                          ║
 * ║ So: accessibleBy() is used for what it is genuinely good at (rule        ║
 * ║ selection, OR/AND/NOT combination, and the fail-closed `{OR: []}` for    ║
 * ║ "no matching rule"), and this file translates the leaves.                ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * FAIL-CLOSED, LOUDLY. A condition this file cannot translate exactly throws
 * rather than being dropped. Dropping a conjunct WIDENS the result set, which is
 * the one outcome an authorization filter must never produce; and translating it
 * to "match nothing" would silently show an empty list with no explanation. The
 * compiler makes the same trade in assertNoUndefined() — refusing to serve beats
 * serving something too permissive.
 *
 * The filter this file produces is always INTERSECTED with the tenant predicate,
 * never substituted for it — see `andWhere()` in lib/db/pg-config.ts.
 */

import { accessibleBy } from '@casl/prisma';
import type { AppAbility } from '@nucleus/rbac';

import type { PrismaRowFilter } from '@/lib/db/pg-config';

/** Raised when a rule cannot be expressed as a Prisma `where` without loss. */
export class UntranslatableFilterError extends Error {
    constructor(
        readonly subjectType: string,
        detail: string
    ) {
        super(`[rbac] cannot push down a '${subjectType}' read rule into SQL: ${detail}`);
        this.name = 'UntranslatableFilterError';
    }
}

/**
 * How a registry attribute path maps onto the backing Prisma model.
 *
 *   column — a plain scalar column.
 *   json   — a path inside a Json column (`tags.Environment` -> tags->>'Environment').
 */
type FieldMapping =
    | { kind: 'column'; column: string }
    | { kind: 'json'; column: string; path: string[] };

/**
 * Subject -> attribute path -> Prisma field. The registry's
 * `rbac_subject_attributes` rows say WHICH paths a condition may reference; this
 * says WHERE each one lives in the schema, which the registry deliberately does
 * not know (it is storage-agnostic and shared with the client bundle).
 *
 * An attribute absent from here is not translatable and throws. That is a
 * deliberate allowlist: silently guessing that a registry path equals a column
 * name would, on a typo, produce a Prisma error at best and a wrong filter at
 * worst.
 */
const SUBJECT_FIELDS: Record<string, Record<string, FieldMapping>> = {
    // model Account.
    //
    // The registry declares THREE attributes for this subject — `accountId`,
    // `alias`, and `tags.Environment` — but only `accountId` exists on the model.
    // Account has no `alias` column (the nearest is `name`) and no `tags` column
    // at all, so the other two are seeded registry rows with nothing behind them.
    // They are deliberately left unmapped: a rule referencing them throws, which
    // is correct, because guessing `alias → name` would silently filter on a
    // different field than the author asked for.
    //
    // Worth fixing at the source — either drop those two registry rows or add the
    // columns — rather than papering over here.
    Account: {
        accountId: { kind: 'column', column: 'accountId' },
    },
    // model Schedule
    Schedule: {
        accountId: { kind: 'column', column: 'accountId' },
        active: { kind: 'column', column: 'active' },
        timezone: { kind: 'column', column: 'timezone' },
    },
    // model InventoryResource
    Resource: {
        accountId: { kind: 'column', column: 'accountId' },
        resourceType: { kind: 'column', column: 'resourceType' },
        region: { kind: 'column', column: 'region' },
        'tags.Environment': { kind: 'json', column: 'tags', path: ['Environment'] },
    },
    // model SpotGuardService
    SpotGuard: {
        accountId: { kind: 'column', column: 'accountId' },
        clusterArn: { kind: 'column', column: 'clusterArn' },
    },
    // model RightSizingRecommendation. The registry declares no subject
    // attributes for RightSizing yet, so no rule can reference these today; they
    // are mapped now so that adding the registry rows is a data change rather
    // than a code change.
    RightSizing: {
        accountId: { kind: 'column', column: 'accountId' },
        region: { kind: 'column', column: 'region' },
        resourceType: { kind: 'column', column: 'resourceType' },
    },
    // model Certificate.
    //
    // `accountId` is declared in the registry for this subject but is NOT mapped
    // here, on purpose. A certificate has no account column: the linkage lives in
    // `certificate_deployments`, which schema.prisma models WITHOUT a Prisma
    // relation (the FK is app-enforced), so there is no `some:` filter to write.
    // The legacy `associatedAccountIds` array is no longer populated — filtering
    // on it would match nothing and look like data loss. So an account-scoped
    // Certificate rule throws here instead of being quietly approximated.
    Certificate: {
        domain: { kind: 'column', column: 'domainName' },
    },
};

/** Subjects this file can produce a row filter for. */
export const ROW_FILTERED_SUBJECTS = Object.keys(SUBJECT_FIELDS);

/** A subject attribute the registry declares as referenceable in a condition. */
export interface DeclaredAttribute {
    subjectKey: string;
    path: string;
}

/**
 * Declared attribute paths that have no Prisma field mapping.
 *
 * THE INVARIANT THIS EXISTS TO ENFORCE: a path in `rbac_subject_attributes` is
 * a path an administrator may reference in a condition, and `validateCondition`
 * will accept it precisely because it is declared. If the same path has no entry
 * in SUBJECT_FIELDS, the rule passes write-time validation and then throws
 * UntranslatableFilterError the first time a list endpoint evaluates it. The two
 * tables must therefore be added to together, and this is the check that makes
 * forgetting one a test failure rather than a production 500.
 */
export function unmappedAttributePaths(declared: DeclaredAttribute[]): string[] {
    const violations = new Set<string>();

    for (const { subjectKey, path } of declared) {
        const fields = SUBJECT_FIELDS[subjectKey];
        if (!fields || !fields[path]) violations.add(`${subjectKey}.${path}`);
    }

    return [...violations].sort();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Mongo comparison operator -> Prisma scalar filter key. */
const SCALAR_OPERATORS: Record<string, string> = {
    $eq: 'equals',
    $ne: 'not',
    $in: 'in',
    $nin: 'notIn',
    $lt: 'lt',
    $lte: 'lte',
    $gt: 'gt',
    $gte: 'gte',
};

function translateScalar(
    subjectType: string,
    path: string,
    column: string,
    value: unknown
): PrismaRowFilter {
    // Shorthand: { accountId: 'x' } means { accountId: { $eq: 'x' } }.
    if (!isPlainObject(value)) {
        return { [column]: { equals: value } };
    }

    const filter: Record<string, unknown> = {};
    for (const [operator, operand] of Object.entries(value)) {
        const prismaKey = SCALAR_OPERATORS[operator];
        if (prismaKey) {
            filter[prismaKey] = operand;
            continue;
        }
        if (operator === '$exists') {
            // Prisma has no `exists`; on a nullable column IS [NOT] NULL is the
            // exact equivalent.
            filter[operand === false ? 'equals' : 'not'] = null;
            continue;
        }
        // $all / $size need a scalar-list column; none of the mapped columns is
        // one, so reaching here means the registry and this map disagree.
        throw new UntranslatableFilterError(
            subjectType,
            `operator '${operator}' on '${path}' has no Prisma equivalent for a scalar column`
        );
    }
    return { [column]: filter };
}

function translateJson(
    subjectType: string,
    attrPath: string,
    column: string,
    path: string[],
    value: unknown
): PrismaRowFilter {
    const eq = (operand: unknown): PrismaRowFilter => ({ [column]: { path, equals: operand } });

    if (!isPlainObject(value)) return eq(value);

    const conjuncts: PrismaRowFilter[] = [];
    for (const [operator, operand] of Object.entries(value)) {
        switch (operator) {
            case '$eq':
                conjuncts.push(eq(operand));
                break;
            case '$ne':
                conjuncts.push({ NOT: eq(operand) });
                break;
            case '$in':
                // Prisma's Json path filter has no `in`; the union spelled out is
                // exactly equivalent.
                if (!Array.isArray(operand)) {
                    throw new UntranslatableFilterError(subjectType, `'$in' on '${attrPath}' needs an array`);
                }
                conjuncts.push({ OR: operand.map(eq) });
                break;
            case '$nin':
                if (!Array.isArray(operand)) {
                    throw new UntranslatableFilterError(subjectType, `'$nin' on '${attrPath}' needs an array`);
                }
                conjuncts.push({ NOT: { OR: operand.map(eq) } });
                break;
            default:
                // $exists in particular: "the JSON key is absent" and "the key is
                // present holding JSON null" are different rows, and Prisma's
                // DbNull/JsonNull distinction makes an exact translation
                // schema-specific. Approximating it would change which rows are
                // returned, so refuse.
                throw new UntranslatableFilterError(
                    subjectType,
                    `operator '${operator}' on the Json path '${attrPath}' has no exact Prisma equivalent`
                );
        }
    }

    if (conjuncts.length === 0) {
        throw new UntranslatableFilterError(subjectType, `'${attrPath}' carried no operators`);
    }
    return conjuncts.length === 1 ? conjuncts[0] : { AND: conjuncts };
}

/**
 * Translates one condition node.
 *
 * Handles both layers in a single walk, because `accessibleBy()` interleaves
 * them: the OUTER envelope it builds uses Prisma-style `AND`/`OR`/`NOT`, while
 * the rule conditions nested inside use mongo-style `$and`/`$or`/`$not`.
 */
function translateNode(subjectType: string, node: unknown, depth: number): PrismaRowFilter {
    if (depth > 12) {
        // The compiler caps authored conditions at MAX_DEPTH=5; anything deeper
        // than the envelope can add is a malformed input, not a use case.
        throw new UntranslatableFilterError(subjectType, 'condition nests too deeply to translate');
    }
    if (!isPlainObject(node)) {
        throw new UntranslatableFilterError(subjectType, `expected a condition object, got ${typeof node}`);
    }

    // The field map is looked up lazily, at the point an attribute path actually
    // needs it (below), NOT here.
    //
    // Checking it up front made an UNCONDITIONAL grant on an unmapped subject
    // throw: accessibleBy() still returns an envelope for it, translateNode was
    // entered, and it failed before ever discovering there was nothing to push
    // down. That broke every list endpoint whose subject has no attributes worth
    // filtering on — the whole `Account` page 500'd — while the allowlist was
    // never actually protecting anything in that case.
    //
    // Deferring costs nothing: `fields` is only read in the attribute-path branch,
    // so a rule that genuinely references an attribute on an unmapped subject
    // still throws, and the deliberate allowlist keeps its teeth.
    const conjuncts: PrismaRowFilter[] = [];

    for (const [key, value] of Object.entries(node)) {
        // ── accessibleBy()'s envelope ────────────────────────────────────────
        if (key === 'AND' || key === 'OR') {
            if (!Array.isArray(value)) {
                throw new UntranslatableFilterError(subjectType, `'${key}' must hold an array`);
            }
            // `{OR: []}` is accessibleBy()'s "no rule matched" — it must survive
            // translation verbatim, because an empty OR is what makes the query
            // return nothing.
            conjuncts.push({ [key]: value.map((entry) => translateNode(subjectType, entry, depth + 1)) });
            continue;
        }
        if (key === 'NOT') {
            conjuncts.push({ NOT: translateNode(subjectType, value, depth + 1) });
            continue;
        }

        // ── mongo logical operators inside a stored condition ────────────────
        if (key === '$and' || key === '$or') {
            if (!Array.isArray(value)) {
                throw new UntranslatableFilterError(subjectType, `'${key}' must hold an array`);
            }
            conjuncts.push({
                [key === '$and' ? 'AND' : 'OR']: value.map((entry) =>
                    translateNode(subjectType, entry, depth + 1)
                ),
            });
            continue;
        }
        if (key === '$not') {
            conjuncts.push({ NOT: translateNode(subjectType, value, depth + 1) });
            continue;
        }
        if (key.startsWith('$')) {
            throw new UntranslatableFilterError(subjectType, `unexpected operator '${key}' at condition level`);
        }

        // ── an attribute path ────────────────────────────────────────────────
        const fields = SUBJECT_FIELDS[subjectType];
        if (!fields) {
            throw new UntranslatableFilterError(
                subjectType,
                `subject has no Prisma field map, so attribute '${key}' cannot be pushed down`
            );
        }
        const mapping = fields[key];
        if (!mapping) {
            throw new UntranslatableFilterError(
                subjectType,
                `attribute '${key}' is not mapped to a column on the backing model`
            );
        }
        conjuncts.push(
            mapping.kind === 'column'
                ? translateScalar(subjectType, key, mapping.column, value)
                : translateJson(subjectType, key, mapping.column, mapping.path, value)
        );
    }

    if (conjuncts.length === 0) return {};
    return conjuncts.length === 1 ? conjuncts[0] : { AND: conjuncts };
}

/**
 * The Prisma `where` fragment describing the rows this ability may read.
 *
 * Returns `{}` when the grant is unconditional (no narrowing needed) and
 * `{OR: []}` when no rule matches at all (matches nothing — the fail-closed
 * default `accessibleBy()` produces).
 *
 * @throws UntranslatableFilterError — never returns a partial filter.
 */
export function readFilterFor(ability: AppAbility, subjectType: string): PrismaRowFilter {
    // `accessibleBy` is typed against a Prisma-conditioned ability; ours is
    // mongo-conditioned by design (see the header). Only rule SELECTION and
    // combination are used from it — the conditions are translated below — so the
    // cast is sound at runtime and the mismatch is purely at the type level.
    const raw = accessibleBy(
        ability as unknown as Parameters<typeof accessibleBy>[0],
        'read'
    ).ofType(subjectType as never) as unknown;

    return translateNode(subjectType, raw, 0);
}

/** True when the filter narrows nothing and can be skipped entirely. */
export function isUnrestricted(filter: PrismaRowFilter | null | undefined): boolean {
    return !filter || Object.keys(filter).length === 0;
}
