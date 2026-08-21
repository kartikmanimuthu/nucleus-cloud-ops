/**
 * THE MIGRATION GUARANTEE.
 *
 * Proves that the compiled CASL ability answers identically to the legacy
 * hardcoded matrix, for every combination that exists in this codebase. Nothing
 * about anyone's access changes on release day; the rebuild is behaviour-neutral
 * by construction, and this suite is the construction.
 *
 * Deleted in Workstream J, together with the legacy matrix it compares against —
 * which is precisely why J is gated on a clean parity soak in production and is
 * the one irreversible step.
 *
 * ── On circularity ─────────────────────────────────────────────────────────────
 * The registry fixture below is built from the same constants the migration's
 * seed was generated from (ROLE_PERMISSIONS, SUBJECT_TO_MODULE, ACTION_MAP), so
 * on its own it would only prove the compiler self-consistent. The other half of
 * the chain is checked separately: a script parses the migration SQL and asserts
 * its 61 preset grant rows are identical to ROLE_PERMISSIONS, module for module
 * and action for action. Together:
 *      migration SQL  ≡  ROLE_PERMISSIONS  ≡  compiled ability
 * which is the property that matters.
 */

import { createMongoAbility } from '@casl/ability';
import { buildActionAliasMap, compileRules } from '@nucleus/rbac';
import type {
    AbilityPrincipal,
    RbacActionRow,
    RbacModuleRow,
    RbacRoleRuleRow,
    RbacSubjectRow,
    RegistrySnapshot,
} from '@nucleus/rbac';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import { hasPermission } from './permissions';
import { ACTION_MAP, SUBJECT_TO_MODULE, type Action, type Module, type PredefinedRole } from './types';

const PRESET_ROLES: PredefinedRole[] = ['Owner', 'Admin', 'Member', 'Viewer'];
const MODULES: Module[] = ['Accounts', 'Schedules', 'AIOps', 'Inventory', 'Settings', 'Dashboard', 'IAM'];
const CRUD: Action[] = ['create', 'read', 'update', 'delete'];

/**
 * Subjects the registry seeds. Everything in SUBJECT_TO_MODULE except the `all`
 * wildcard, plus the module-named subjects that call sites pass where the legacy
 * code fell through `SUBJECT_TO_MODULE[x] ?? (x as Module)`.
 */
const MODULE_NAMED_SUBJECTS: Record<string, Module> = { AIOps: 'AIOps', Settings: 'Settings', IAM: 'IAM' };

function subjectToModule(): Record<string, Module> {
    const map: Record<string, Module> = { ...MODULE_NAMED_SUBJECTS };
    for (const [subject, module] of Object.entries(SUBJECT_TO_MODULE)) {
        if (subject === 'all') continue;
        map[subject] = module;
    }
    return map;
}

function buildRegistry(): RegistrySnapshot {
    const modules: RbacModuleRow[] = MODULES.map((key, index) => ({
        id: `m-${key}`,
        tenantId: null,
        key,
        label: key,
        description: null,
        icon: null,
        navPath: `/app/${key.toLowerCase()}`,
        sortOrder: (index + 1) * 10,
        isSystem: true,
        enabled: true,
    }));

    // CRUD, plus every aliased verb registered as data so ACTION_MAP's behaviour
    // is reproduced by the registry rather than by code.
    const actions: RbacActionRow[] = [
        ...CRUD.map((key) => ({ key, aliasOfKey: null })),
        { key: 'execute', aliasOfKey: 'update' },
        { key: 'approve', aliasOfKey: 'update' },
        { key: 'export', aliasOfKey: 'read' },
        { key: 'validate', aliasOfKey: 'read' },
        { key: 'use', aliasOfKey: 'read' },
        { key: 'manage', aliasOfKey: null },
    ].map(({ key, aliasOfKey }) => ({
        id: `a-${key}`,
        tenantId: null,
        key,
        label: key,
        description: null,
        aliasOfKey,
        isDangerous: false,
        sortOrder: 100,
        isSystem: true,
    }));

    const mapping = subjectToModule();
    const subjects: RbacSubjectRow[] = Object.keys(mapping).map((key) => ({
        id: `s-${key}`,
        tenantId: null,
        key,
        label: key,
        kind: 'resource',
        isSystem: true,
    }));

    return {
        tenantId: 't1',
        modules,
        actions,
        subjects,
        subjectModules: Object.entries(mapping).map(([subject, module]) => ({
            tenantId: null,
            subjectId: `s-${subject}`,
            moduleId: `m-${module}`,
        })),
        // All four CRUD per module, except Dashboard which is read-only for
        // everyone — reproducing role-dialog.tsx's allowedActions as data.
        moduleActions: MODULES.flatMap((module) =>
            (module === 'Dashboard' ? (['read'] as Action[]) : CRUD).map((action) => ({
                tenantId: null,
                moduleId: `m-${module}`,
                actionId: `a-${action}`,
                grantable: true,
            }))
        ),
        subjectAttributes: [],
        principalAttributes: [],
    };
}

/** ROLE_PERMISSIONS materialised as module-level rules — what the migration seeds. */
function rulesForRole(role: PredefinedRole): RbacRoleRuleRow[] {
    const rules: RbacRoleRuleRow[] = [];
    for (const module of MODULES) {
        for (const action of CRUD) {
            if (!hasPermission(role, action, module)) continue;
            rules.push({
                id: `r-${role}-${module}-${action}`,
                tenantId: null,
                roleId: `preset-${role.toLowerCase()}`,
                actionId: `a-${action}`,
                moduleId: `m-${module}`,
                subjectId: null,
                conditions: null,
                fields: [],
                inverted: false,
                reason: null,
            });
        }
    }
    return rules;
}

function principalFor(role: PredefinedRole): AbilityPrincipal {
    return {
        userId: 'u1',
        email: 'u1@example.com',
        tenantId: 't1',
        roleId: `preset-${role.toLowerCase()}`,
        roleName: role,
        level: 1,
        isSuperAdmin: false,
        attributes: {},
    };
}

const registry = buildRegistry();
const aliasMap = buildActionAliasMap(registry.actions);
const mapping = subjectToModule();

const abilities = new Map(
    PRESET_ROLES.map((role) => {
        const compiled = compileRules(registry, rulesForRole(role), principalFor(role));
        expect(compiled.dropped, `role ${role} dropped rules`).toEqual([]);
        return [role, createMongoAbility(compiled.rules as never)] as const;
    })
);

/** The legacy decision, replicated exactly as authorize() computed it pre-CASL. */
function legacyAllows(role: PredefinedRole, action: string, subjectType: string): boolean {
    const module: Module = SUBJECT_TO_MODULE[subjectType] ?? (subjectType as Module);
    const mapped = ACTION_MAP[action];
    const actionsToCheck: Action[] = Array.isArray(mapped) ? mapped : [mapped ?? (action as Action)];
    return actionsToCheck.some((a) => hasPermission(role, a, module));
}

function caslAllows(role: PredefinedRole, action: string, subjectType: string): boolean {
    const ability = abilities.get(role)!;
    return ability.can(aliasMap[action] ?? action, subjectType);
}

// ─────────────────────────────────────────────────────────────────────────────

describe('parity — every (role, module, action) triple', () => {
    it('grants a module action on exactly the subjects that module owns', () => {
        const mismatches: string[] = [];

        for (const role of PRESET_ROLES) {
            for (const module of MODULES) {
                for (const action of CRUD) {
                    const expected = hasPermission(role, action, module);
                    const subjectsInModule = Object.entries(mapping)
                        .filter(([, m]) => m === module)
                        .map(([s]) => s);

                    for (const subjectKey of subjectsInModule) {
                        const actual = caslAllows(role, action, subjectKey);
                        if (actual !== expected) {
                            mismatches.push(
                                `${role} / ${module} / ${action} / subject=${subjectKey}: legacy=${expected} casl=${actual}`
                            );
                        }
                    }
                }
            }
        }

        expect(mismatches, mismatches.join('\n')).toEqual([]);
    });
});

describe('parity — every (verb, subject) pair the codebase actually uses', () => {
    const manifestPath = path.resolve(__dirname, '..', '..', '..', '..', 'libs', 'rbac', 'generated', 'route-manifest.json');

    /** Pairs harvested from the committed route manifest — the real call sites. */
    function manifestPairs(): Array<{ action: string; subject: string }> {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
            routes: Array<{ methods: Record<string, { action?: string; subject?: string }> }>;
        };
        const seen = new Set<string>();
        const pairs: Array<{ action: string; subject: string }> = [];
        for (const route of manifest.routes) {
            for (const entry of Object.values(route.methods)) {
                if (!entry.action || !entry.subject) continue;
                const key = `${entry.action} ${entry.subject}`;
                if (seen.has(key)) continue;
                seen.add(key);
                pairs.push({ action: entry.action, subject: entry.subject });
            }
        }
        return pairs;
    }

    it('has a manifest to read', () => {
        expect(fs.existsSync(manifestPath), `missing ${manifestPath} — run \`bun run rbac:sync\``).toBe(true);
        expect(manifestPairs().length).toBeGreaterThan(0);
    });

    it('every subject used by a route is registered', () => {
        const unregistered = manifestPairs()
            .map((p) => p.subject)
            .filter((s, i, arr) => arr.indexOf(s) === i)
            .filter((s) => !(s in mapping));

        // An unregistered subject compiles to nothing and fails closed, i.e. it
        // silently revokes access that works today. This is how AIOps and Settings
        // were caught.
        expect(unregistered, `subjects used by routes but absent from the registry: ${unregistered.join(', ')}`).toEqual(
            []
        );
    });

    it('every verb used by a route resolves through the alias map', () => {
        const unknown = manifestPairs()
            .map((p) => p.action)
            .filter((a, i, arr) => arr.indexOf(a) === i)
            .filter((a) => !(a in aliasMap));

        expect(unknown, `verbs used by routes but absent from the registry: ${unknown.join(', ')}`).toEqual([]);
    });

    it('CASL and the legacy matrix agree on every pair, for all four preset roles', () => {
        const mismatches: string[] = [];

        for (const { action, subject } of manifestPairs()) {
            for (const role of PRESET_ROLES) {
                const legacy = legacyAllows(role, action, subject);
                const casl = caslAllows(role, action, subject);
                if (legacy !== casl) {
                    mismatches.push(`${role}: ${action} ${subject} — legacy=${legacy} casl=${casl}`);
                }
            }
        }

        expect(mismatches, `\n${mismatches.join('\n')}\n`).toEqual([]);
    });
});

describe('parity — aliased verbs', () => {
    it.each([
        ['execute', 'update'],
        ['approve', 'update'],
        ['export', 'read'],
        ['validate', 'read'],
        ['use', 'read'],
    ])('%s resolves to %s, matching ACTION_MAP', (verb, terminal) => {
        expect(aliasMap[verb]).toBe(terminal);
        expect(ACTION_MAP[verb]).toBe(terminal);
    });

    it('a role with update on Schedules can execute a Schedule', () => {
        // The concrete regression: rules compile to `update`, so a check for the
        // aliased verb must be translated or every execute route 403s.
        expect(caslAllows('Member', 'execute', 'Schedule')).toBe(true);
        expect(caslAllows('Viewer', 'execute', 'Schedule')).toBe(false);
    });
});

describe('parity — Dashboard stays read-only as data', () => {
    it.each(PRESET_ROLES)('%s cannot write to Dashboard', (role) => {
        expect(caslAllows(role, 'read', 'Dashboard')).toBe(true);
        for (const action of ['create', 'update', 'delete']) {
            expect(caslAllows(role, action, 'Dashboard')).toBe(false);
        }
    });
});
