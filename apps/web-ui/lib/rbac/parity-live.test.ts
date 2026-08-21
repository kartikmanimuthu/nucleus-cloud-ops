/**
 * THE MIGRATION GUARANTEE, PART TWO — against real data.
 *
 * parity.test.ts proves legacy ≡ CASL for the four PRESET roles, using a fixture
 * registry built from ROLE_PERMISSIONS. That is deterministic and CI-safe, but by
 * construction it cannot see a tenant's own custom roles: those live only as
 * `custom_roles.permissions` JSON on the legacy side and as `rbac_role_rules` rows
 * on the CASL side, and nothing had ever compared the two.
 *
 * A custom role is where the engines are most likely to drift, because the two
 * representations are populated by different code paths — the roles UI writes the
 * JSON, the backfill writes the rules. This suite closes that gap: for EVERY role
 * in the database, preset or custom, the grant sets must be identical.
 *
 * ── Why this test reads the database ──────────────────────────────────────────
 * The property under test is about data that exists only at runtime, so a fixture
 * would test nothing. It therefore SKIPS cleanly when the database is unreachable
 * so CI stays green offline — but it must not skip silently when data IS present,
 * which is why `describe.skipIf` is keyed on connectivity alone and the suite
 * asserts it found roles before comparing.
 *
 * READ-ONLY. This suite must never write to the database.
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';

import {
    filterToLegacyModules,
    LEGACY_MODULES,
    normalizeGrants,
    resolveSubjectModuleMap,
    type RuleTarget,
    type SubjectModuleRow,
} from './parity-normalize';
import { ROLE_PERMISSIONS } from './permissions';
import { ACTION_MAP, type Action, type Module, type PredefinedRole } from './types';

const PRESET_NAMES = new Set(['Owner', 'Admin', 'Member', 'Viewer']);

const prisma = new PrismaClient();

/** Legacy shape: `custom_roles.permissions` is Record<Module, Action[]>. */
type LegacyMatrix = Partial<Record<Module, Action[]>>;

interface RoleRow {
    id: string;
    name: string;
    type: string;
    permissions: unknown;
}

interface RuleRow {
    roleId: string;
    action: string;
    moduleKey: string | null;
    subjectKey: string | null;
    inverted: boolean;
}

/**
 * Connectivity probe. Resolved once so every `skipIf` sees the same answer, and
 * so an unreachable database costs one failed connection rather than one per test.
 */
const reachable = await prisma
    .$queryRawUnsafe('select 1')
    .then(() => true)
    .catch(() => false);

const roles: RoleRow[] = reachable
    ? await prisma.$queryRawUnsafe<RoleRow[]>(
          `select id, name, type, permissions from custom_roles order by name`,
      )
    : [];

const rules: RuleRow[] = reachable
    ? await prisma.$queryRawUnsafe<RuleRow[]>(
          `select rr."roleId" as "roleId",
                  a.key       as action,
                  m.key       as "moduleKey",
                  s.key       as "subjectKey",
                  rr.inverted as inverted
             from rbac_role_rules rr
             join rbac_actions a  on a.id = rr."actionId"
             left join rbac_modules  m on m.id = rr."moduleId"
             left join rbac_subjects s on s.id = rr."subjectId"`,
      )
    : [];

/**
 * Subject → module links, both global and tenant-local. Precedence is resolved
 * by resolveSubjectModuleMap(), not by SQL ordering.
 */
const subjectModules: SubjectModuleRow[] = reachable
    ? await prisma.$queryRawUnsafe<SubjectModuleRow[]>(
          `select s.key           as "subjectKey",
                  m.key           as "moduleKey",
                  sm."tenantId"   as "tenantId"
             from rbac_subject_modules sm
             join rbac_subjects s on s.id = sm."subjectId"
             join rbac_modules  m on m.id = sm."moduleId"`,
      )
    : [];

const moduleKeyBySubjectKey = resolveSubjectModuleMap(subjectModules);

afterAll(async () => {
    await prisma.$disconnect();
});

/**
 * Resolve a role's legacy grants the way production does.
 *
 * This split is load-bearing and easy to get wrong: the four preset rows carry
 * `permissions = '{}'` in the database — their real grants live in code, in
 * ROLE_PERMISSIONS, and `authorize()` reads them from there. Only custom roles
 * are resolved from the stored JSON (via getCustomRolePermissions). Comparing a
 * preset against its DB JSON therefore compares against an empty set and reports
 * the entire preset as a CASL over-grant, which is a bug in the comparison, not
 * in the engine.
 */
function legacyMatrixFor(role: RoleRow): LegacyMatrix {
    if (role.type === 'preset' && PRESET_NAMES.has(role.name)) {
        return ROLE_PERMISSIONS[role.name as PredefinedRole] as LegacyMatrix;
    }
    return (role.permissions ?? {}) as LegacyMatrix;
}

/** `Module:action` pairs the legacy matrix grants, normalised through ACTION_MAP. */
function legacyGrants(matrix: LegacyMatrix): Set<string> {
    const out = new Set<string>();
    for (const [mod, actions] of Object.entries(matrix ?? {})) {
        for (const action of (actions ?? []) as Action[]) {
            const terminal = ACTION_MAP[action] ?? action;
            // ACTION_MAP maps 'manage' to an array; every other verb to one action.
            for (const t of Array.isArray(terminal) ? terminal : [terminal]) {
                out.add(`${mod}:${t}`);
            }
        }
    }
    return out;
}

/** Every grant this role holds, normalised onto module keys and split by scope. */
function caslGrants(roleId: string) {
    const targets: RuleTarget[] = rules
        .filter((rule) => rule.roleId === roleId)
        .map((rule) => ({
            action: rule.action,
            moduleKey: rule.moduleKey,
            subjectKey: rule.subjectKey,
            inverted: rule.inverted,
        }));

    return normalizeGrants(targets, moduleKeyBySubjectKey);
}

describe.skipIf(!reachable)('parity (live) — every role in the database', () => {
    it('found roles to compare', () => {
        // Guards against the suite passing vacuously if the tables are empty.
        expect(roles.length, 'no rows in custom_roles — nothing was actually compared').toBeGreaterThan(0);
    });

    it('every role has at least one compiled rule', () => {
        const ruleless = roles
            .filter((r) => {
                const grants = caslGrants(r.id);
                return grants.inScope.size === 0 && grants.outOfScope.length === 0;
            })
            .map((r) => `${r.name} (${r.type})`);
        // A role with grants in JSON but no rules compiles to nothing and fails
        // closed — i.e. it silently revokes access that works today.
        expect(ruleless, `roles with no rbac_role_rules: ${ruleless.join(', ')}`).toEqual([]);
    });

    it.each(roles.map((r) => [r.name, r.type, r.id] as const))(
        '%s (%s) — legacy and CASL agree within the legacy module taxonomy',
        (name, type, id) => {
            const role = roles.find((r) => r.id === id)!;

            // Both sides restricted to the six modules the legacy matrix can
            // express. Outside that taxonomy the legacy matrix has no opinion, so
            // there is nothing to compare — see the header of parity-normalize.ts.
            const legacy = filterToLegacyModules(legacyGrants(legacyMatrixFor(role)));
            const casl = caslGrants(id);

            // A subject with no module link would vanish from the comparison
            // entirely, which is the one failure mode this rewrite could introduce.
            expect(
                casl.unmappedSubjects,
                `${name}: subject-level rules whose subject has no module link — ` +
                    `these are excluded from the comparison: ${casl.unmappedSubjects.join(', ')}`,
            ).toEqual([]);

            const missingInCasl = [...legacy].filter((g) => !casl.inScope.has(g)).sort();
            const extraInCasl = [...casl.inScope].filter((g) => !legacy.has(g)).sort();

            // Extra grants in CASL are the dangerous direction: the new engine would
            // permit something the legacy matrix denies today.
            expect(
                extraInCasl,
                `${name}: CASL grants what legacy does not — ${extraInCasl.join(', ')}`,
            ).toEqual([]);

            // Missing grants are the silent-revocation direction.
            expect(
                missingInCasl,
                `${name}: legacy grants what CASL does not — ${missingInCasl.join(', ')}`,
            ).toEqual([]);
        },
    );

    it('reports grants outside the legacy module taxonomy', () => {
        // Not a failure — these are modules an administrator added, which the
        // closed LegacyModule union cannot express. Asserted only to keep them
        // VISIBLE: if the gate stops covering something, that must be stated in the
        // test output rather than discovered later.
        const byRole = roles
            .map((role) => ({ role: role.name, grants: caslGrants(role.id).outOfScope }))
            .filter((entry) => entry.grants.length > 0);

        for (const entry of byRole) {
            console.log(
                `[parity] ${entry.role}: outside the legacy taxonomy — ${entry.grants.join(', ')}`,
            );
        }

        // Every out-of-scope grant must be on a module genuinely outside the legacy
        // six. A legacy module leaking in here would mean normalizeGrants() had
        // stopped comparing something it should compare.
        const leaked = byRole
            .flatMap((entry) => entry.grants)
            .filter((key) => LEGACY_MODULES.some((m) => key.startsWith(`${m}:`)));

        expect(leaked, `legacy modules escaped the comparison: ${leaked.join(', ')}`).toEqual([]);
    });
});

describe.skipIf(!reachable)('parity (live) — conditional rules', () => {
    it('records how many live rules carry conditions', async () => {
        const [{ conditional }] = await prisma.$queryRawUnsafe<{ conditional: number }[]>(
            `select count(*)::int as conditional from rbac_role_rules where conditions is not null`,
        );

        // Not an assertion about the right number — it is a tripwire. While this is
        // zero, the set-equality comparison above is exact and total. The moment a
        // conditional rule exists, that comparison is no longer sufficient: CASL may
        // allow the action while restricting rows, which legacy cannot express. This
        // test failing is the signal to extend the harness with narrowing semantics
        // BEFORE trusting parity for a cutover.
        expect(
            conditional,
            'a rule now carries conditions — set-equality parity is no longer sufficient; ' +
                'extend this harness to assert conditions only narrow, never widen',
        ).toBe(0);
    });
});
