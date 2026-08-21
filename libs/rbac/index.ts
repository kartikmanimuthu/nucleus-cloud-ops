// Public surface of @nucleus/rbac.
//
// Framework-free by contract — see types.ts. Consumed by the web-ui server, the
// web-ui client bundle, the workers process and the agent tool factory.

export type {
    HttpMethod,
    RouteAuthz,
    RouteAuthzEntry,
    RouteAuthzSource,
    RouteManifest,
    RouteManifestEntry,
    RouteManifestMethod,
} from './types';

export type {
    AbilityPrincipal,
    AppAbility,
    ConditionAst,
    ConditionValue,
    ConditionVarNode,
    DroppedRule,
} from './types';

export { buildActionAliasMap, compileRules, MAX_ALIAS_DEPTH } from './rule-compiler';
export type { CompileResult } from './rule-compiler';

export {
    ALLOWED_OPERATORS,
    assertValidCondition,
    collectVarPaths,
    FORBIDDEN_OPERATORS,
    MAX_DEPTH,
    MAX_NODES,
    validateCondition,
} from './condition-schema';
export type { ConditionContext, ValidationResult } from './condition-schema';

export type {
    RbacActionRow,
    RbacModuleActionRow,
    RbacModuleRow,
    RbacPrincipalAttributeRow,
    RbacRoleRuleRow,
    RbacSubjectAttributeRow,
    RbacSubjectKind,
    RbacSubjectModuleRow,
    RbacSubjectRow,
    RbacValueType,
    RegistrySnapshot,
} from './registry-types';

export { resolveNavOwner } from './nav-resolver';
export type { NavOwner, NavPathRow } from './nav-resolver';
