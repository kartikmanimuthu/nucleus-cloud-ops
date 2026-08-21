/**
 * The rule compiler. Pure, synchronous, no I/O, no framework imports.
 *
 * Rows in, CASL raw rules out. This is the ONLY place rules are produced: the
 * server ability, the packed client rules, the agent's tool ability and the
 * Prisma row filters all come from one call to this function with the same rows.
 * A disagreement between the UI and the API is therefore a bug in this file, not
 * a synchronisation problem — which is what makes the system reviewable.
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║ THE CASL v7 TRAP THIS FILE IS BUILT AROUND                               ║
 * ║                                                                          ║
 * ║ CASL v7 treats "a condition that semantically matches everything" as     ║
 * ║ EQUIVALENT TO NO CONDITION. So a rule emitted as                         ║
 * ║     { accountId: { $in: undefined } }                                    ║
 * ║ does not deny — it GRANTS UNCONDITIONALLY.                               ║
 * ║                                                                          ║
 * ║ An unresolved `$var` is therefore a privilege-escalation primitive, not  ║
 * ║ a no-op, and the failure is silent and total. Three defences, all        ║
 * ║ mandatory, all present below:                                            ║
 * ║   1. Step 5 DROPS the rule; it never emits `undefined`.                  ║
 * ║   2. rule-compiler.test.ts asserts an unresolvable $var yields NO rule.  ║
 * ║   3. assertNoUndefined() throws at the end — in production, not only in  ║
 * ║      tests. Refusing to serve beats serving something too permissive.    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

import type { RawRuleOf } from '@casl/ability';

import { validateCondition } from './condition-schema';
import type {
    RbacActionRow,
    RbacModuleRow,
    RbacRoleRuleRow,
    RbacSubjectAttributeRow,
    RbacSubjectRow,
    RegistrySnapshot,
} from './registry-types';
import type { AbilityPrincipal, AppAbility, ConditionAst, DroppedRule } from './types';

/** Alias chains deeper than this are a registry authoring mistake, not a use case. */
export const MAX_ALIAS_DEPTH = 4;

export interface CompileResult {
    rules: RawRuleOf<AppAbility>[];
    /**
     * Rules that were deliberately not emitted. Surfaced in the admin UI and
     * logged, because a silently dropped rule is a permission that mysteriously
     * does not work.
     */
    dropped: DroppedRule[];
}

/** An expanded, alias-resolved grant, before conditions are substituted. */
interface ExpandedRule {
    ruleId: string;
    action: string;
    subject: string;
    conditions: unknown | null;
    inverted: boolean;
    reason: string | null;
    /** Subject-level rules beat module-level ones for the same (action, subject). */
    precise: boolean;
}

class AliasCycleError extends Error {
    constructor(chain: string[]) {
        super(`RBAC action alias cycle: ${chain.join(' -> ')}`);
        this.name = 'AliasCycleError';
    }
}

class AliasDepthError extends Error {
    constructor(chain: string[]) {
        super(`RBAC action alias chain deeper than ${MAX_ALIAS_DEPTH}: ${chain.join(' -> ')}`);
        this.name = 'AliasDepthError';
    }
}

/**
 * Maps every registered action key to the terminal action it resolves to.
 *
 * Needed at CHECK time, not just compile time: rules are compiled with terminal
 * verbs, so `authorize('execute', 'Schedule')` must ask CASL about `update` or it
 * would find no matching rule and deny — silently revoking every route that uses
 * an aliased verb. This is the data-driven equivalent of the legacy ACTION_MAP.
 *
 * Unknown keys map to themselves. Cycles and over-deep chains resolve to the last
 * key reached rather than throwing, because a check-time lookup must not be able
 * to 500 a request; compileRules() throws on the same registry and that is where
 * the fault surfaces.
 */
export function buildActionAliasMap(actions: RbacActionRow[]): Record<string, string> {
    const byKey = new Map(actions.map((a) => [a.key, a]));
    const resolved: Record<string, string> = {};

    for (const action of actions) {
        const seen = new Set<string>([action.key]);
        let current = action.key;

        for (let depth = 0; depth < MAX_ALIAS_DEPTH; depth++) {
            const next = byKey.get(current)?.aliasOfKey;
            if (!next || seen.has(next)) break;
            seen.add(next);
            current = next;
        }
        resolved[action.key] = current;
    }

    return resolved;
}

function stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Defence 3. Walks an emitted condition and throws if `undefined` appears at any
 * depth. Deliberately active in production: a compiler that refuses to answer is
 * strictly safer than one that answers "yes" to everything.
 */
function assertNoUndefined(condition: unknown, path: string, ruleId: string): void {
    if (condition === undefined) {
        throw new Error(
            `RBAC compiler emitted \`undefined\` at ${path} in rule ${ruleId}. ` +
                `Under CASL v7 this would match everything and grant unconditionally. Refusing to serve.`
        );
    }
    if (Array.isArray(condition)) {
        condition.forEach((item, index) => assertNoUndefined(item, `${path}[${index}]`, ruleId));
        return;
    }
    if (isPlainObject(condition)) {
        for (const [key, value] of Object.entries(condition)) {
            assertNoUndefined(value, `${path}.${key}`, ruleId);
        }
    }
}

interface ResolvedConditions {
    ok: boolean;
    value?: Record<string, unknown>;
    detail?: string;
}

/**
 * Step 5. Substitutes `{"$var": path}` nodes by ASSIGNMENT from the principal's
 * attributes. Never string interpolation — see condition-schema.ts.
 *
 * An unresolvable path fails the WHOLE rule rather than the single node, because
 * a partially-resolved condition is exactly the "matches everything" shape.
 */
function resolveConditions(
    ast: unknown,
    principal: AbilityPrincipal,
    declaredVarPaths: Set<string>
): ResolvedConditions {
    let failure: string | null = null;

    const walk = (node: unknown): unknown => {
        if (failure) return undefined;

        if (Array.isArray(node)) return node.map(walk);

        if (isPlainObject(node)) {
            // A $var node substitutes as a value, structure untouched.
            if (Object.keys(node).length === 1 && typeof node.$var === 'string') {
                const path = node.$var;
                if (!declaredVarPaths.has(path)) {
                    failure = `'$var: ${path}' is not a declared principal attribute`;
                    return undefined;
                }
                const value = principal.attributes[path];
                if (value === undefined) {
                    failure = `'$var: ${path}' has no value for this principal`;
                    return undefined;
                }
                return value;
            }

            const out: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(node)) {
                out[key] = walk(value);
                if (failure) return undefined;
            }
            return out;
        }

        return node;
    };

    const resolved = walk(ast);
    if (failure) return { ok: false, detail: failure };
    if (!isPlainObject(resolved)) return { ok: false, detail: 'condition did not resolve to an object' };
    if (Object.keys(resolved).length === 0) {
        // Would match everything, i.e. silently become unconditional.
        return { ok: false, detail: 'condition resolved to an empty object' };
    }
    return { ok: true, value: resolved };
}

/**
 * Compiles a role's stored rules into CASL raw rules for one principal.
 *
 * @throws AliasCycleError / AliasDepthError on a malformed registry — caught by
 *         rbac:sync in CI, and fail-closed at runtime (the caller denies).
 * @throws if an emitted condition contains `undefined` (see assertNoUndefined).
 */
export function compileRules(
    registry: RegistrySnapshot,
    rules: RbacRoleRuleRow[],
    principal: AbilityPrincipal
): CompileResult {
    // ── Step 1. SuperAdmin short-circuit ─────────────────────────────────────
    if (principal.isSuperAdmin) {
        return { rules: [{ action: 'manage', subject: 'all' }], dropped: [] };
    }

    const dropped: DroppedRule[] = [];

    const moduleById = new Map<string, RbacModuleRow>(registry.modules.map((m) => [m.id, m]));
    const actionById = new Map<string, RbacActionRow>(registry.actions.map((a) => [a.id, a]));
    const actionByKey = new Map<string, RbacActionRow>(registry.actions.map((a) => [a.key, a]));
    const subjectById = new Map<string, RbacSubjectRow>(registry.subjects.map((s) => [s.id, s]));

    const subjectsByModuleId = new Map<string, RbacSubjectRow[]>();
    const moduleIdBySubjectId = new Map<string, string>();
    for (const link of registry.subjectModules) {
        const subject = subjectById.get(link.subjectId);
        if (!subject) continue;
        moduleIdBySubjectId.set(link.subjectId, link.moduleId);
        const bucket = subjectsByModuleId.get(link.moduleId);
        if (bucket) bucket.push(subject);
        else subjectsByModuleId.set(link.moduleId, [subject]);
    }

    const grantableByModuleId = new Map<string, string[]>();
    for (const link of registry.moduleActions) {
        if (!link.grantable) continue;
        const action = actionById.get(link.actionId);
        if (!action) continue;
        const bucket = grantableByModuleId.get(link.moduleId);
        if (bucket) bucket.push(action.key);
        else grantableByModuleId.set(link.moduleId, [action.key]);
    }

    const attributesBySubjectId = new Map<string, RbacSubjectAttributeRow[]>();
    for (const attribute of registry.subjectAttributes) {
        const bucket = attributesBySubjectId.get(attribute.subjectId);
        if (bucket) bucket.push(attribute);
        else attributesBySubjectId.set(attribute.subjectId, [attribute]);
    }

    const declaredVarPaths = new Set(registry.principalAttributes.map((p) => p.key));

    /**
     * Step 4 (partial). Follows `aliasOfKey` to a terminal action.
     *
     * `manage` is handled separately by the caller: it expands to the module's
     * grantable actions, deliberately NOT to CASL's built-in `manage` wildcard, so
     * that adding an action to the registry later does not retroactively widen
     * every existing `manage` grant.
     */
    const resolveAlias = (startKey: string): string => {
        const chain: string[] = [startKey];
        let current = startKey;

        for (let depth = 0; depth < MAX_ALIAS_DEPTH; depth++) {
            const row = actionByKey.get(current);
            const next = row?.aliasOfKey;
            if (!next) return current;
            if (chain.includes(next)) throw new AliasCycleError([...chain, next]);
            chain.push(next);
            current = next;
        }
        throw new AliasDepthError(chain);
    };

    // ── Steps 2–4. Expand targets, resolve aliases ───────────────────────────
    const expanded: ExpandedRule[] = [];

    for (const rule of rules) {
        const action = actionById.get(rule.actionId);
        if (!action) {
            dropped.push({
                ruleId: rule.id,
                reason: 'unknown-action',
                detail: `action ${rule.actionId} is not in the registry`,
            });
            continue;
        }

        // Determine the target subjects and the module they hang off.
        let targets: RbacSubjectRow[];
        let moduleIdForGrantable: string | undefined;
        let precise: boolean;

        if (rule.moduleId) {
            const module = moduleById.get(rule.moduleId);
            if (!module) {
                dropped.push({
                    ruleId: rule.id,
                    reason: 'unknown-module',
                    detail: `module ${rule.moduleId} is not in the registry`,
                });
                continue;
            }
            if (!module.enabled) {
                // A disabled module contributes nothing at all.
                dropped.push({
                    ruleId: rule.id,
                    reason: 'module-disabled',
                    detail: `module '${module.key}' is disabled`,
                });
                continue;
            }
            targets = subjectsByModuleId.get(module.id) ?? [];
            moduleIdForGrantable = module.id;
            precise = false;
        } else if (rule.subjectId) {
            const subject = subjectById.get(rule.subjectId);
            if (!subject) {
                dropped.push({
                    ruleId: rule.id,
                    reason: 'unknown-subject',
                    detail: `subject ${rule.subjectId} is not in the registry`,
                });
                continue;
            }
            const owningModuleId = moduleIdBySubjectId.get(subject.id);
            const owningModule = owningModuleId ? moduleById.get(owningModuleId) : undefined;
            if (owningModule && !owningModule.enabled) {
                dropped.push({
                    ruleId: rule.id,
                    reason: 'module-disabled',
                    detail: `subject '${subject.key}' belongs to disabled module '${owningModule.key}'`,
                });
                continue;
            }
            targets = [subject];
            moduleIdForGrantable = owningModuleId;
            precise = true;
        } else {
            // The DB CHECK makes this unreachable; fail closed if it ever is not.
            dropped.push({
                ruleId: rule.id,
                reason: 'unknown-subject',
                detail: 'rule has neither a module nor a subject target',
            });
            continue;
        }

        // 'manage' expands to the module's grantable actions; everything else
        // follows its alias chain to a terminal verb.
        // A cycle or an over-deep chain is a malformed registry, i.e. a build-time
        // bug that rbac:sync should have caught. It propagates rather than being
        // recorded in `dropped`, because silently degrading every role that
        // touches the action would hide the fault. The caller denies and alarms
        // (see the fail-closed contract in section 8.7).
        let actionKeys: string[];
        if (action.key === 'manage') {
            const grantable = moduleIdForGrantable ? grantableByModuleId.get(moduleIdForGrantable) : undefined;
            actionKeys = [...new Set(grantable ?? [])].map(resolveAlias);
        } else {
            actionKeys = [resolveAlias(action.key)];
        }

        if (actionKeys.length === 0) {
            dropped.push({
                ruleId: rule.id,
                reason: 'unknown-action',
                detail: `'manage' expanded to no grantable actions`,
            });
            continue;
        }

        for (const actionKey of actionKeys) {
            for (const subject of targets) {
                expanded.push({
                    ruleId: rule.id,
                    action: actionKey,
                    subject: subject.key,
                    conditions: rule.conditions ?? null,
                    inverted: rule.inverted,
                    reason: rule.reason,
                    precise,
                });
            }
        }
    }

    // ── Step 3. Precise beats broad, regardless of insertion order ───────────
    // Comparison happens on the TERMINAL action key, so a subject-level `approve`
    // rule correctly suppresses a module-level `update` rule once both have
    // resolved to `update`.
    const preciseKeys = new Set(
        expanded.filter((e) => e.precise).map((e) => `${e.action} ${e.subject}`)
    );
    const surviving = expanded.filter((e) => e.precise || !preciseKeys.has(`${e.action} ${e.subject}`));

    // ── Step 5. Resolve conditions ───────────────────────────────────────────
    const resolved: Array<ExpandedRule & { finalConditions: Record<string, unknown> | null }> = [];

    for (const entry of surviving) {
        if (entry.conditions === null || entry.conditions === undefined) {
            resolved.push({ ...entry, finalConditions: null });
            continue;
        }

        const subject = registry.subjects.find((s) => s.key === entry.subject);
        const subjectAttributes = subject ? attributesBySubjectId.get(subject.id) ?? [] : [];

        // Re-validated at compile time: write-time validation alone is
        // insufficient because a direct database edit bypasses it.
        const validation = validateCondition(entry.conditions, {
            subjectAttributes,
            principalAttributes: registry.principalAttributes,
        });
        if (!validation.ok) {
            dropped.push({
                ruleId: entry.ruleId,
                reason: 'condition-invalid',
                detail: `${entry.action} ${entry.subject}: ${validation.issues.join('; ')}`,
            });
            continue;
        }

        const substituted = resolveConditions(entry.conditions as ConditionAst, principal, declaredVarPaths);
        if (!substituted.ok || !substituted.value) {
            dropped.push({
                ruleId: entry.ruleId,
                reason: 'condition-unresolvable',
                detail: `${entry.action} ${entry.subject}: ${substituted.detail ?? 'unresolvable'}`,
            });
            continue;
        }

        resolved.push({ ...entry, finalConditions: substituted.value });
    }

    // ── Step 6. Order: every `can`, then every `cannot` ──────────────────────
    // CASL gives LATER rules precedence, so emitting inverted rules last is what
    // makes `cannot` reliably beat an overlapping `can`.
    //
    // Within each partition the order is sorted, not source order. Postgres makes
    // no ordering promise, so without this the compiled output — and therefore
    // `relevantRuleFor()`, which powers the 403 reason and the simulator — would
    // vary run to run for identical inputs.
    const sortKey = (entry: (typeof resolved)[number]): string =>
        `${entry.action} ${entry.subject} ${stableStringify(entry.finalConditions)}`;
    const bySortKey = (a: (typeof resolved)[number], b: (typeof resolved)[number]): number =>
        sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0;

    const ordered = [
        ...resolved.filter((r) => !r.inverted).sort(bySortKey),
        ...resolved.filter((r) => r.inverted).sort(bySortKey),
    ];

    // ── Step 7. Dedupe on (action, subject, conditions, inverted) ────────────
    const seen = new Set<string>();
    const output: RawRuleOf<AppAbility>[] = [];

    for (const entry of ordered) {
        const fingerprint = `${entry.action} ${entry.subject} ${entry.inverted} ${stableStringify(
            entry.finalConditions
        )}`;
        if (seen.has(fingerprint)) continue;
        seen.add(fingerprint);

        const rule: RawRuleOf<AppAbility> = { action: entry.action, subject: entry.subject };
        if (entry.finalConditions) {
            assertNoUndefined(entry.finalConditions, 'conditions', entry.ruleId); // defence 3
            rule.conditions = entry.finalConditions as never;
        }
        if (entry.inverted) rule.inverted = true;
        if (entry.reason) rule.reason = entry.reason;

        output.push(rule);
    }

    return { rules: output, dropped };
}
