/**
 * Condition AST validation — the boundary that keeps admin-authored rules from
 * becoming an injection or denial-of-service vector.
 *
 * Two properties this file exists to guarantee:
 *
 *   1. NOTHING ATTACKER-INFLUENCED IS EVER PARSED. Conditions are structured
 *      objects with `{"$var": path}` nodes, and the compiler substitutes values
 *      by ASSIGNMENT. The pattern in wide circulation —
 *          JSON.parse(stored.replace(/\$\{user\.id\}/g, user.id))
 *      — lets a value containing `"` or `}` rewrite the rule's STRUCTURE, and
 *      emails are attacker-influenceable through the invitation flow. Injection
 *      here is structurally impossible rather than filtered against.
 *
 *   2. NO OPERATOR CAN EXECUTE OR BACKTRACK. `$where`, `$function` and `$expr`
 *      run code. `$regex` is an admin-supplied pattern evaluated on every single
 *      authorization check, which is a ReDoS vector aimed at the hottest path in
 *      the app. All four are rejected.
 *
 * Validation runs at WRITE time and again at COMPILE time. Write-time alone is
 * insufficient because a direct database edit bypasses it entirely.
 *
 * Zod 4 note: use `.issues`, not `.errors`; `z.record()` needs both key and value.
 */

import { z } from 'zod';

import type { ConditionAst, ConditionValue } from './types';
import type { RbacPrincipalAttributeRow, RbacSubjectAttributeRow, RbacValueType } from './registry-types';

/** Operators an administrator may use. Anything outside this set is rejected. */
export const ALLOWED_OPERATORS = [
    '$eq',
    '$ne',
    '$in',
    '$nin',
    '$lt',
    '$lte',
    '$gt',
    '$gte',
    '$exists',
    '$all',
    '$size',
    '$and',
    '$or',
    '$not',
] as const;

/**
 * Explicitly named so the rejection message can say WHY, and so a reviewer can
 * see that the dangerous set was considered rather than merely omitted.
 */
export const FORBIDDEN_OPERATORS: Record<string, string> = {
    $where: 'executes JavaScript',
    $function: 'executes JavaScript',
    $expr: 'evaluates arbitrary expressions',
    $regex: 'an admin-supplied pattern evaluated on every authorization check is a ReDoS vector',
};

const LOGICAL_OPERATORS = new Set(['$and', '$or', '$not']);
const ARRAY_OPERAND_OPERATORS = new Set(['$in', '$nin', '$all']);
const ORDERED_OPERAND_OPERATORS = new Set(['$lt', '$lte', '$gt', '$gte']);

export const MAX_DEPTH = 5;
export const MAX_NODES = 50;

/** Structural layer. The semantic layer below does the registry-aware checks. */
const varNodeSchema = z.object({ $var: z.string().min(1) }).strict();

const literalSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export interface ConditionContext {
    /** Attributes declared for the subject this condition is attached to. */
    subjectAttributes: RbacSubjectAttributeRow[];
    /** The $var allowlist. A path absent from here is not resolvable, by design. */
    principalAttributes: RbacPrincipalAttributeRow[];
}

export type ValidationResult = { ok: true } | { ok: false; issues: string[] };

function isVarNode(value: unknown): value is { $var: string } {
    return varNodeSchema.safeParse(value).success;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Does a declared value type satisfy an operator that needs a list? */
function isArrayType(type: RbacValueType): boolean {
    return type === 'string[]';
}

function isOrderedType(type: RbacValueType): boolean {
    return type === 'number' || type === 'date';
}

class Validator {
    private readonly issues: string[] = [];
    private nodes = 0;

    private readonly attributeByPath: Map<string, RbacSubjectAttributeRow>;
    private readonly principalByKey: Map<string, RbacPrincipalAttributeRow>;

    constructor(context: ConditionContext) {
        this.attributeByPath = new Map(context.subjectAttributes.map((a) => [a.path, a]));
        this.principalByKey = new Map(context.principalAttributes.map((p) => [p.key, p]));
    }

    validate(ast: unknown): ValidationResult {
        if (!isPlainObject(ast)) {
            return { ok: false, issues: ['condition must be an object'] };
        }
        this.walkAst(ast, 1);
        return this.issues.length === 0 ? { ok: true } : { ok: false, issues: this.issues };
    }

    private count(): boolean {
        this.nodes += 1;
        if (this.nodes > MAX_NODES) {
            if (!this.issues.some((i) => i.startsWith('condition exceeds'))) {
                this.issues.push(`condition exceeds the maximum of ${MAX_NODES} nodes`);
            }
            return false;
        }
        return true;
    }

    private checkDepth(depth: number): boolean {
        if (depth > MAX_DEPTH) {
            if (!this.issues.some((i) => i.startsWith('condition nests'))) {
                this.issues.push(`condition nests deeper than the maximum of ${MAX_DEPTH}`);
            }
            return false;
        }
        return true;
    }

    /** A condition object: attribute paths and/or logical operators. */
    private walkAst(ast: Record<string, unknown>, depth: number): void {
        if (!this.checkDepth(depth) || !this.count()) return;

        for (const [key, value] of Object.entries(ast)) {
            if (key in FORBIDDEN_OPERATORS) {
                this.issues.push(`operator '${key}' is forbidden — ${FORBIDDEN_OPERATORS[key]}`);
                continue;
            }

            if (LOGICAL_OPERATORS.has(key)) {
                this.walkLogical(key, value, depth);
                continue;
            }

            if (key.startsWith('$')) {
                this.issues.push(`unknown operator '${key}' at the top level of a condition`);
                continue;
            }

            const attribute = this.attributeByPath.get(key);
            if (!attribute) {
                this.issues.push(
                    `attribute '${key}' is not declared for this subject — ` +
                        `add it to rbac_subject_attributes before referencing it in a rule`
                );
                continue;
            }

            this.walkAttributeValue(attribute, value, depth + 1);
        }
    }

    private walkLogical(operator: string, value: unknown, depth: number): void {
        if (!this.count()) return;

        if (operator === '$not') {
            if (!isPlainObject(value)) {
                this.issues.push(`'$not' takes a condition object`);
                return;
            }
            this.walkAst(value, depth + 1);
            return;
        }

        if (!Array.isArray(value)) {
            this.issues.push(`'${operator}' takes an array of condition objects`);
            return;
        }
        for (const entry of value) {
            if (!isPlainObject(entry)) {
                this.issues.push(`'${operator}' entries must be condition objects`);
                continue;
            }
            this.walkAst(entry, depth + 1);
        }
    }

    /** The value attached to an attribute path: a literal, a $var, or an operator map. */
    private walkAttributeValue(attribute: RbacSubjectAttributeRow, value: unknown, depth: number): void {
        if (!this.checkDepth(depth) || !this.count()) return;

        // Shorthand: { accountId: 'x' } means { accountId: { $eq: 'x' } }
        if (literalSchema.safeParse(value).success) {
            this.checkOperatorAllowed(attribute, '$eq');
            return;
        }

        if (isVarNode(value)) {
            this.checkOperatorAllowed(attribute, '$eq');
            this.checkVar(value.$var, attribute, '$eq');
            return;
        }

        if (Array.isArray(value)) {
            this.issues.push(
                `attribute '${attribute.path}' cannot take a bare array — use an explicit operator such as $in`
            );
            return;
        }

        if (!isPlainObject(value)) {
            this.issues.push(`attribute '${attribute.path}' has an unsupported value`);
            return;
        }

        for (const [operator, operand] of Object.entries(value)) {
            if (operator in FORBIDDEN_OPERATORS) {
                this.issues.push(`operator '${operator}' is forbidden — ${FORBIDDEN_OPERATORS[operator]}`);
                continue;
            }
            if (!(ALLOWED_OPERATORS as readonly string[]).includes(operator)) {
                this.issues.push(`unknown operator '${operator}' on attribute '${attribute.path}'`);
                continue;
            }
            if (LOGICAL_OPERATORS.has(operator)) {
                this.issues.push(`'${operator}' cannot be used directly on attribute '${attribute.path}'`);
                continue;
            }

            this.checkOperatorAllowed(attribute, operator);
            this.checkOperand(attribute, operator, operand, depth + 1);
        }
    }

    private checkOperatorAllowed(attribute: RbacSubjectAttributeRow, operator: string): void {
        if (!attribute.operators.includes(operator)) {
            this.issues.push(
                `operator '${operator}' is not permitted on attribute '${attribute.path}' ` +
                    `(allowed: ${attribute.operators.join(', ') || 'none'})`
            );
        }
    }

    private checkOperand(
        attribute: RbacSubjectAttributeRow,
        operator: string,
        operand: unknown,
        depth: number
    ): void {
        if (!this.checkDepth(depth) || !this.count()) return;

        if (isVarNode(operand)) {
            this.checkVar(operand.$var, attribute, operator);
            return;
        }

        if (ARRAY_OPERAND_OPERATORS.has(operator)) {
            if (!Array.isArray(operand)) {
                this.issues.push(`'${operator}' on '${attribute.path}' requires an array or a $var of list type`);
                return;
            }
            for (const item of operand) {
                if (!this.count()) return;
                if (isVarNode(item)) {
                    this.checkVar(item.$var, attribute, '$eq');
                } else if (!literalSchema.safeParse(item).success) {
                    this.issues.push(`'${operator}' on '${attribute.path}' accepts only literals or $var nodes`);
                }
            }
            return;
        }

        if (ORDERED_OPERAND_OPERATORS.has(operator)) {
            const isDateString = typeof operand === 'string' && !Number.isNaN(Date.parse(operand));
            if (typeof operand !== 'number' && !isDateString) {
                this.issues.push(`'${operator}' on '${attribute.path}' requires a number or a date`);
            }
            if (!isOrderedType(attribute.valueType)) {
                this.issues.push(
                    `'${operator}' cannot apply to '${attribute.path}', which is declared ${attribute.valueType}`
                );
            }
            return;
        }

        if (operator === '$exists') {
            if (typeof operand !== 'boolean') {
                this.issues.push(`'$exists' on '${attribute.path}' requires a boolean`);
            }
            return;
        }

        if (operator === '$size') {
            if (typeof operand !== 'number') {
                this.issues.push(`'$size' on '${attribute.path}' requires a number`);
            }
            return;
        }

        // $eq / $ne
        if (!literalSchema.safeParse(operand).success) {
            this.issues.push(`'${operator}' on '${attribute.path}' requires a literal value or a $var node`);
        }
    }

    /**
     * A $var is only legal if the registry declares it. This is what keeps
     * arbitrary database content out of the matcher: the set of referenceable
     * paths is bounded by rbac_principal_attributes, not by whatever happens to
     * be on the principal object at runtime.
     */
    private checkVar(path: string, attribute: RbacSubjectAttributeRow, operator: string): void {
        const declared = this.principalByKey.get(path);
        if (!declared) {
            this.issues.push(
                `'$var: ${path}' is not a declared principal attribute — ` +
                    `add it to rbac_principal_attributes before referencing it`
            );
            return;
        }

        if (ARRAY_OPERAND_OPERATORS.has(operator) && !isArrayType(declared.valueType)) {
            this.issues.push(
                `'${operator}' on '${attribute.path}' needs a list, but '$var: ${path}' is declared ${declared.valueType}`
            );
        }

        if (ORDERED_OPERAND_OPERATORS.has(operator) && !isOrderedType(declared.valueType)) {
            this.issues.push(
                `'${operator}' on '${attribute.path}' needs a number or date, but '$var: ${path}' is declared ${declared.valueType}`
            );
        }
    }
}

/** Validates a condition AST against the registry. Used at write time and compile time. */
export function validateCondition(ast: unknown, context: ConditionContext): ValidationResult {
    return new Validator(context).validate(ast);
}

/** Throwing variant for call sites where an invalid condition is a programming error. */
export function assertValidCondition(ast: unknown, context: ConditionContext): asserts ast is ConditionAst {
    const result = validateCondition(ast, context);
    if (!result.ok) {
        throw new Error(`Invalid condition: ${result.issues.join('; ')}`);
    }
}

/** Collects every `$var` path referenced anywhere in an AST. */
export function collectVarPaths(value: ConditionValue | ConditionAst): string[] {
    const found: string[] = [];
    const walk = (node: unknown): void => {
        if (Array.isArray(node)) {
            node.forEach(walk);
            return;
        }
        if (!isPlainObject(node)) return;
        if (isVarNode(node)) {
            found.push(node.$var);
            return;
        }
        Object.values(node).forEach(walk);
    };
    walk(value);
    return found;
}
