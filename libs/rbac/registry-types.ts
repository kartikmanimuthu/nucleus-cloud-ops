// =============================================================================
// Registry row types + the snapshot the compiler consumes.
//
// Framework-free: these mirror the rbac_* tables structurally but do not import
// Prisma, so libs/rbac stays consumable by the web-ui client bundle and by the
// workers process without dragging a database client along.
// =============================================================================

export interface RbacModuleRow {
    id: string;
    tenantId: string | null;
    key: string;
    label: string;
    description: string | null;
    icon: string | null;
    navPath: string | null;
    sortOrder: number;
    isSystem: boolean;
    enabled: boolean;
}

export interface RbacActionRow {
    id: string;
    tenantId: string | null;
    key: string;
    label: string;
    description: string | null;
    /** Follow to a terminal action at compile time. Depth cap 4; cycles throw. */
    aliasOfKey: string | null;
    isDangerous: boolean;
    sortOrder: number;
    isSystem: boolean;
}

export type RbacSubjectKind = 'resource' | 'capability';

export interface RbacSubjectRow {
    id: string;
    tenantId: string | null;
    key: string;
    label: string;
    kind: RbacSubjectKind;
    /** Destination this subject owns, or null when it has no page. */
    navPath: string | null;
    sortOrder: number;
    isSystem: boolean;
}

export interface RbacSubjectModuleRow {
    tenantId: string | null;
    subjectId: string;
    moduleId: string;
}

export interface RbacModuleActionRow {
    tenantId: string | null;
    moduleId: string;
    actionId: string;
    grantable: boolean;
}

export type RbacValueType = 'string' | 'number' | 'boolean' | 'string[]' | 'date';

export interface RbacSubjectAttributeRow {
    tenantId: string | null;
    subjectId: string;
    path: string;
    label: string;
    valueType: RbacValueType;
    /** Per-attribute operator whitelist; the validator rejects anything outside it. */
    operators: string[];
    enumValues: string[];
}

export interface RbacPrincipalAttributeRow {
    tenantId: string | null;
    key: string;
    label: string;
    valueType: RbacValueType;
    source: 'user' | 'builtin';
}

/** One grant. Exactly one of moduleId / subjectId is set (DB CHECK enforces it). */
export interface RbacRoleRuleRow {
    id: string;
    tenantId: string | null;
    roleId: string;
    actionId: string;
    moduleId: string | null;
    subjectId: string | null;
    conditions: unknown | null;
    fields: string[];
    inverted: boolean;
    reason: string | null;
}

/**
 * Everything the compiler needs to expand and resolve a role's rules, already
 * merged across the global (tenantId NULL) and tenant-local row sets.
 */
export interface RegistrySnapshot {
    tenantId: string;
    modules: RbacModuleRow[];
    actions: RbacActionRow[];
    subjects: RbacSubjectRow[];
    subjectModules: RbacSubjectModuleRow[];
    moduleActions: RbacModuleActionRow[];
    subjectAttributes: RbacSubjectAttributeRow[];
    principalAttributes: RbacPrincipalAttributeRow[];
}
