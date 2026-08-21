// =============================================================================
// libs/rbac — framework-free shared types
//
// Nothing in libs/rbac may import next/ or react/. These types are consumed by
// the web-ui server, the web-ui client bundle, the workers process and the agent
// tool factory, so they must stay runtime-agnostic.
// =============================================================================

import type { MongoAbility, MongoQuery } from '@casl/ability';

/**
 * The application ability.
 *
 * Subjects and actions are database-driven, so they are `string` at the type
 * level. Compile-time safety comes back via the generated literal unions in
 * generated/system-types.ts (D-12) rather than from hand-maintained unions that
 * would drift from the rows.
 *
 * NOTE — CASL v7: build these with `createMongoAbility()`. `new Ability()` is the
 * v6 API and does NOT wire the mongo condition matcher, so every conditional rule
 * would silently match everything. See section 3.6 of the plan.
 */
export type AppAbility = MongoAbility<[string, string], MongoQuery>;

/** Who the ability is being compiled for. */
export interface AbilityPrincipal {
    userId: string;
    email: string;
    tenantId: string;
    roleId: string | null;
    roleName: string;
    level: number;
    isSuperAdmin: boolean;
    /** rbac_user_attributes merged over the builtins, keyed by principal-attribute key. */
    attributes: Record<string, unknown>;
}

/**
 * A `{"$var": "user.allowedAccountIds"}` node. The value is substituted by
 * ASSIGNMENT during compilation — never by string interpolation, which is a JSON
 * injection hole reachable through the invitation flow (section 8.4).
 */
export interface ConditionVarNode {
    $var: string;
}

export type ConditionValue =
    | string
    | number
    | boolean
    | null
    | ConditionVarNode
    | ConditionValue[]
    | { [operator: string]: ConditionValue };

export type ConditionAst = Record<string, ConditionValue>;

/** Why a rule never made it into the compiled output. */
export interface DroppedRule {
    ruleId: string;
    reason:
        | 'unknown-action'
        | 'unknown-subject'
        | 'unknown-module'
        | 'module-disabled'
        | 'alias-unresolvable'
        | 'condition-invalid'
        | 'condition-unresolvable';
    detail: string;
}

/** HTTP methods a Next.js App Router `route.ts` may export. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

/**
 * The permission a single HTTP handler requires.
 *
 * Declared in the route file itself (`export const authz`) so it is reviewed in
 * the same diff as the handler it guards, and compiled into the committed
 * manifest by `rbac:sync`.
 */
export interface RouteAuthzEntry {
    action: string;
    subject: string;
}

/** `export const authz: RouteAuthz` — one entry per exported HTTP handler. */
export type RouteAuthz = Partial<Record<HttpMethod, RouteAuthzEntry>>;

/** How `rbac:sync` resolved a handler's requirement. */
export type RouteAuthzSource =
    /** read from `export const authz` in the route file */
    | 'declared'
    /** derived from an `authorize(action, Subject)` call inside the handler */
    | 'inferred'
    /** matched an entry in `rbac-allowlist.ts`; no permission required */
    | 'allowlist'
    /** neither declared, inferrable, nor allowlisted — Layer 1 denies this */
    | 'undeclared';

export interface RouteManifestMethod extends Partial<RouteAuthzEntry> {
    source: RouteAuthzSource;
    /** Present on `allowlist` entries — the mandatory justification string. */
    why?: string;
}

export interface RouteManifestEntry {
    /** path-to-regexp pattern, e.g. `/api/schedules/:scheduleId`. */
    pattern: string;
    /** Repo-relative source file, for traceability in review. */
    file: string;
    methods: Partial<Record<HttpMethod, RouteManifestMethod>>;
}

export interface RouteManifest {
    /**
     * No timestamp by design: this file is committed and reviewed in PRs, so it
     * must be byte-stable when nothing about the routes changed.
     */
    version: 1;
    routes: RouteManifestEntry[];
}
