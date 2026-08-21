/**
 * backfill-rbac.ts — one-shot, run manually against production after the
 * 20260730000000_dynamic_abac migration has applied.
 *
 *   cd apps/web-ui && tsx scripts/backfill-rbac.ts --dry-run   # inspect, write nothing
 *   cd apps/web-ui && tsx scripts/backfill-rbac.ts             # apply, archive the output
 *
 * What it does:
 *   1. For every CustomRole, reads the legacy `permissions` JSON blob and inserts
 *      one module-level rule per (module, action) into rbac_role_rules.
 *   2. Sets an explicit `level` from the value getAutoLevel() derives today, so no
 *      role's assignment rights change on release day (D-8 removes the derivation,
 *      and canAssignRole() depends on the value).
 *   3. Leaves `permissions` untouched as a shadow copy. Workstream J drops it.
 *   4. ROUND-TRIP ASSERTION — reads the rules back, reconstructs a PermissionSet
 *      from them, and deep-compares it to the source blob for every role. Any
 *      difference rolls the whole transaction back and exits non-zero.
 *
 * Step 4 is the entire safety argument for this migration. Non-negotiable.
 *
 * ┌── SCOPE NOTE, read before reviewing ──────────────────────────────────────┐
 * │ The plan specifies step 4 as "recompile and compare can() vs             │
 * │ hasCustomPermission()". That comparison needs the rule compiler, which    │
 * │ does not exist until Workstream C — B → C is the plan's own build order.  │
 * │ So the assertion here proves the necessary half that IS checkable now:    │
 * │ the ROWS reproduce the legacy PermissionSet exactly, losslessly, both     │
 * │ ways. The compiled-ability half — that CASL's can() agrees with the old   │
 * │ matrix for every (role, module, action) triple — is parity.test.ts in     │
 * │ Workstream C, and this script should be re-run once C has landed.         │
 * │ Neither half alone is sufficient; together they are the plan's intent.    │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

// Same import style as libs/prisma/seed.ts: reach the generated client directly
// rather than through lib/db/pg-config, which is written for the Next runtime and
// its `@/` alias.
import { PrismaClient } from '../../../node_modules/.prisma/client';
import { getAutoLevel } from '../lib/rbac/permissions';
import type { Action, Module, PermissionSet } from '../lib/rbac/types';

const CRUD: readonly Action[] = ['create', 'read', 'update', 'delete'];

const prisma = new PrismaClient();
const DRY_RUN = process.argv.includes('--dry-run');

interface Mismatch {
    roleId: string;
    roleName: string;
    module: string;
    expected: string[];
    actual: string[];
}

function normalise(actions: readonly string[]): string[] {
    return [...new Set(actions)].sort();
}

/** Legacy blob → the (module, action) pairs it grants, ignoring unknown keys. */
function readPermissionSet(raw: unknown): Map<string, string[]> {
    const out = new Map<string, string[]>();
    if (!raw || typeof raw !== 'object') return out;
    for (const [moduleKey, actions] of Object.entries(raw as PermissionSet)) {
        if (!Array.isArray(actions)) continue;
        const valid = actions.filter((a): a is Action => CRUD.includes(a as Action));
        if (valid.length > 0) out.set(moduleKey, normalise(valid));
    }
    return out;
}

async function main(): Promise<void> {
    console.log(`backfill-rbac — ${DRY_RUN ? 'DRY RUN (no writes)' : 'APPLYING'}`);

    const [modules, actions] = await Promise.all([
        prisma.rbacModule.findMany({ where: { tenantId: null }, select: { id: true, key: true } }),
        prisma.rbacAction.findMany({ where: { tenantId: null }, select: { id: true, key: true } }),
    ]);

    if (modules.length === 0 || actions.length === 0) {
        throw new Error(
            'Registry is empty. The 20260730000000_dynamic_abac migration has not applied — ' +
                'its system seed creates these rows. Run `prisma migrate deploy` first.'
        );
    }

    const moduleIdByKey = new Map(modules.map((m) => [m.key, m.id]));
    const actionIdByKey = new Map(actions.map((a) => [a.key, a.id]));
    const moduleKeyById = new Map(modules.map((m) => [m.id, m.key]));
    const actionKeyById = new Map(actions.map((a) => [a.id, a.key]));

    const roles = await prisma.customRole.findMany({
        select: { id: true, name: true, tenantId: true, permissions: true, level: true, isSystem: true },
        orderBy: { id: 'asc' },
    });

    console.log(`backfill-rbac — ${roles.length} roles, ${modules.length} modules, ${actions.length} actions`);

    const mismatches: Mismatch[] = [];
    let rulesInserted = 0;
    let levelsSet = 0;

    await prisma.$transaction(async (tx) => {
        for (const role of roles) {
            const desired = readPermissionSet(role.permissions);

            // Preset roles already have their rules seeded by the migration, and
            // their legacy blob may be '{}' from a fresh install. Verify them, do
            // not rewrite them.
            if (!role.isSystem) {
                for (const [moduleKey, moduleActions] of desired) {
                    const moduleId = moduleIdByKey.get(moduleKey);
                    if (!moduleId) {
                        console.warn(`  ! role ${role.name}: unknown module '${moduleKey}' in permissions blob — skipped`);
                        continue;
                    }
                    for (const action of moduleActions) {
                        const actionId = actionIdByKey.get(action);
                        if (!actionId) {
                            console.warn(`  ! role ${role.name}: unknown action '${action}' — skipped`);
                            continue;
                        }
                        if (DRY_RUN) {
                            rulesInserted++;
                            continue;
                        }
                        const existing = await tx.rbacRoleRule.findFirst({
                            where: { roleId: role.id, actionId, moduleId, subjectId: null },
                            select: { id: true },
                        });
                        if (!existing) {
                            await tx.rbacRoleRule.create({
                                data: {
                                    tenantId: role.tenantId,
                                    roleId: role.id,
                                    actionId,
                                    moduleId,
                                    createdBy: 'backfill-rbac',
                                },
                            });
                            rulesInserted++;
                        }
                    }
                }

                // D-8: pin the level to what the derivation produces today.
                const derived = getAutoLevel(role.permissions as PermissionSet);
                if (derived !== role.level) {
                    if (!DRY_RUN) {
                        await tx.customRole.update({ where: { id: role.id }, data: { level: derived } });
                    }
                    levelsSet++;
                    console.log(`  role ${role.name}: level ${role.level} -> ${derived}`);
                }
            }

            // ── Round trip ───────────────────────────────────────────────────
            // In a dry run there is nothing new to read back, so compare against
            // whatever rules already exist; on a fresh database that correctly
            // reports every module as a mismatch, which is the point of the flag.
            const persisted = await tx.rbacRoleRule.findMany({
                where: { roleId: role.id, subjectId: null, inverted: false },
                select: { moduleId: true, actionId: true },
            });

            const actual = new Map<string, string[]>();
            for (const rule of persisted) {
                if (!rule.moduleId) continue;
                const moduleKey = moduleKeyById.get(rule.moduleId);
                const actionKey = actionKeyById.get(rule.actionId);
                if (!moduleKey || !actionKey) continue;
                actual.set(moduleKey, [...(actual.get(moduleKey) ?? []), actionKey]);
            }

            const expectedSource = role.isSystem ? presetPermissionSet(role.name) : desired;

            for (const moduleKey of new Set([...expectedSource.keys(), ...actual.keys()])) {
                const expected = normalise(expectedSource.get(moduleKey) ?? []);
                const got = normalise(actual.get(moduleKey) ?? []);
                if (expected.join(',') !== got.join(',')) {
                    mismatches.push({
                        roleId: role.id,
                        roleName: role.name,
                        module: moduleKey,
                        expected,
                        actual: got,
                    });
                }
            }
        }

        if (mismatches.length > 0 && !DRY_RUN) {
            // Rolls the whole transaction back — a partial backfill is worse than none.
            throw new Error('ROUND_TRIP_FAILED');
        }

        // Bump each affected tenant's RBAC version so the process-wide ability
        // cache (ability-cache.ts) stops serving the pre-backfill (empty)
        // compiled rules for these roles — a version bump is the only thing
        // that invalidates it. Mirrors withRbacVersionBump() in
        // registry-service.ts, reimplemented inline rather than imported: that
        // module pulls in the `@/` Next-runtime alias this standalone script
        // deliberately avoids (see the import comment above).
        if (!DRY_RUN) {
            const tenantIds = new Set(
                roles.filter((r) => !r.isSystem && r.tenantId).map((r) => r.tenantId as string)
            );
            for (const tenantId of tenantIds) {
                await tx.tenant.update({ where: { id: tenantId }, data: { rbacVersion: { increment: 1 } } });
            }
        }
    });

    console.log(
        `backfill-rbac — ${rulesInserted} rules ${DRY_RUN ? 'would be inserted' : 'inserted'}, ` +
            `${levelsSet} levels ${DRY_RUN ? 'would be set' : 'set'}`
    );

    if (mismatches.length > 0) {
        console.error(`\nROUND-TRIP ASSERTION FAILED — ${mismatches.length} mismatch(es):\n`);
        for (const m of mismatches) {
            console.error(`  ${m.roleName} (${m.roleId}) / ${m.module}`);
            console.error(`    legacy blob : [${m.expected.join(', ')}]`);
            console.error(`    rbac rules  : [${m.actual.join(', ')}]`);
        }
        console.error('\nNothing was committed. Investigate before retrying.');
        process.exitCode = 1;
        return;
    }

    console.log('backfill-rbac — round-trip assertion PASSED. Rules reproduce the legacy matrix exactly.');
}

/**
 * The preset matrix as seeded by the migration. Kept here rather than imported
 * from ROLE_PERMISSIONS so the assertion compares against what the MIGRATION
 * claims to have written, not against the same constant the migration was
 * generated from — otherwise the check is circular.
 */
function presetPermissionSet(roleName: string): Map<string, string[]> {
    const crud = ['create', 'read', 'update', 'delete'];
    const table: Record<string, Record<string, string[]>> = {
        Owner: {
            Accounts: crud, Schedules: crud, AIOps: crud, Inventory: crud, Settings: crud, Dashboard: ['read'], IAM: crud,
        },
        Admin: {
            Accounts: crud, Schedules: crud, AIOps: crud, Inventory: crud,
            Settings: ['create', 'read', 'update'], Dashboard: ['read'], IAM: ['create', 'read', 'update'],
        },
        Member: {
            Accounts: ['create', 'read', 'update'], Schedules: ['create', 'read', 'update'],
            AIOps: ['create', 'read', 'update'], Inventory: ['create', 'read', 'update'],
            Settings: ['read'], Dashboard: ['read'], IAM: ['read'],
        },
        Viewer: {
            Accounts: ['read'], Schedules: ['read'], AIOps: ['read'],
            Inventory: ['read'], Settings: ['read'], Dashboard: ['read'], IAM: ['read'],
        },
    };
    const row = table[roleName];
    if (!row) return new Map();
    return new Map(Object.entries(row).map(([k, v]) => [k, normalise(v)]));
}

main()
    .catch((error: unknown) => {
        if (error instanceof Error && error.message === 'ROUND_TRIP_FAILED') {
            // Already reported above; the transaction rolled back.
            process.exitCode = 1;
            return;
        }
        console.error('backfill-rbac — FAILED:', error);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
