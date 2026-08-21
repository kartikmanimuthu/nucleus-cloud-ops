/**
 * backfill-modules.ts — one-shot script to seed new global rbac_modules rows
 * (plus their action grid and subject links) now that the Modules admin
 * screen has been removed. Fill in SEED_MODULES below with the real data
 * before running for real.
 *
 * Does NOT create subjects — every subjectKey must already exist in
 * rbac_subjects; this script only links existing subjects to a new module.
 *
 *   cd apps/web-ui && tsx scripts/backfill-modules.ts --dry-run   # inspect, write nothing
 *   cd apps/web-ui && tsx scripts/backfill-modules.ts             # apply
 *
 * Known limitations:
 * - Run backfill-permissions.ts first if a seed module's actionKeys
 *   references a permission only that script would create.
 * - Re-running after editing an already-created row's
 *   actionKeys/subjectKeys does not add the new links — it silently no-ops
 *   for that key. Delete the row (or its links) manually first if you need
 *   to change an already-applied entry.
 * - These scripts write rows nothing in the app can delete afterward
 *   (global system rows are unconditionally undeletable through the API) —
 *   double-check SEED_ACTIONS/SEED_MODULES before a real run, --dry-run
 *   first.
 * - A version bump now runs automatically when anything is inserted, so
 *   warm app processes will see new rows without a restart.
 */

import { PrismaClient } from '../../../node_modules/.prisma/client';

const prisma = new PrismaClient();
const DRY_RUN = process.argv.includes('--dry-run');

interface SeedModule {
    key: string;
    label: string;
    description?: string;
    icon?: string;
    navPath?: string;
    sortOrder?: number;
    enabled?: boolean;
    actionKeys: string[];
    subjectKeys: string[];
}

const SEED_MODULES: SeedModule[] = [
    // filled in with the real business data before this runs for real
];

const MODULE_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/;

async function main(): Promise<void> {
    console.log(`backfill-modules — ${DRY_RUN ? 'DRY RUN (no writes)' : 'APPLYING'}`);

    const [modules, actions, subjects, subjectModules] = await Promise.all([
        prisma.rbacModule.findMany({ where: { tenantId: null }, select: { id: true, key: true } }),
        prisma.rbacAction.findMany({ where: { tenantId: null }, select: { id: true, key: true } }),
        prisma.rbacSubject.findMany({ where: { tenantId: null }, select: { id: true, key: true } }),
        prisma.rbacSubjectModule.findMany({
            where: { tenantId: null },
            select: { subjectId: true, moduleId: true },
        }),
    ]);

    const moduleIdByKey = new Map(modules.map((m) => [m.key, m.id]));
    const actionIdByKey = new Map(actions.map((a) => [a.key, a.id]));
    const subjectIdByKey = new Map(subjects.map((s) => [s.key, s.id]));
    const moduleKeyById = new Map(modules.map((m) => [m.id, m.key]));
    const subjectKeyById = new Map(subjects.map((s) => [s.id, s.key]));

    // subjectKey -> the module key it's already linked to, from existing DB rows.
    const linkedModuleKeyBySubjectKey = new Map<string, string>();
    for (const link of subjectModules) {
        const subjectKey = subjectKeyById.get(link.subjectId);
        const moduleKey = moduleKeyById.get(link.moduleId);
        if (subjectKey && moduleKey) linkedModuleKeyBySubjectKey.set(subjectKey, moduleKey);
    }

    // ── Validate every seed module before writing anything ──────────────────
    const invalidKeys: string[] = [];
    for (const seed of SEED_MODULES) {
        if (!MODULE_KEY_PATTERN.test(seed.key)) {
            invalidKeys.push(`'${seed.key}' is not a valid module key — use letters and digits only, e.g. 'CostControl'`);
        }
        if (!seed.label.trim()) {
            invalidKeys.push(`'${seed.key}' has a blank label`);
        }
        if (seed.actionKeys.length === 0) {
            invalidKeys.push(`'${seed.key}' has no actionKeys — select at least one, or its column has nothing to grant`);
        }
    }

    const unknownActions: string[] = [];
    const unknownSubjects: string[] = [];
    const subjectConflicts = new Set<string>();

    for (const seed of SEED_MODULES) {
        for (const actionKey of seed.actionKeys) {
            if (!actionIdByKey.has(actionKey)) {
                unknownActions.push(`${seed.key} -> actionKey '${actionKey}'`);
            }
        }
        for (const subjectKey of seed.subjectKeys) {
            if (!subjectIdByKey.has(subjectKey)) {
                unknownSubjects.push(`${seed.key} -> subjectKey '${subjectKey}'`);
                continue;
            }
            const linkedTo = linkedModuleKeyBySubjectKey.get(subjectKey);
            if (linkedTo && linkedTo !== seed.key) {
                subjectConflicts.add(
                    `'${subjectKey}' is already linked to module '${linkedTo}', cannot also link it to '${seed.key}'`
                );
            }
        }
        // A subject claimed by two DIFFERENT seed modules in this same list —
        // rbac_subject_modules' global unique index on subjectId alone means
        // only one of them could ever win.
        for (const other of SEED_MODULES) {
            if (other.key === seed.key) continue;
            for (const subjectKey of seed.subjectKeys) {
                if (other.subjectKeys.includes(subjectKey)) {
                    subjectConflicts.add(`'${subjectKey}' is claimed by both seed modules '${seed.key}' and '${other.key}'`);
                }
            }
        }
    }

    if (invalidKeys.length > 0 || unknownActions.length > 0 || unknownSubjects.length > 0 || subjectConflicts.size > 0) {
        console.error('backfill-modules — ABORTED:');
        for (const line of invalidKeys) console.error(`  invalid key/label: ${line}`);
        for (const line of unknownActions) console.error(`  unknown action: ${line}`);
        for (const line of unknownSubjects) console.error(`  unknown subject: ${line}`);
        for (const line of subjectConflicts) console.error(`  subject conflict: ${line}`);
        process.exitCode = 1;
        return;
    }

    const toInsert = SEED_MODULES.filter((m) => !moduleIdByKey.has(m.key));
    const alreadyPresent = SEED_MODULES.length - toInsert.length;

    if (!DRY_RUN) {
        await prisma.$transaction(async (tx) => {
            for (const seed of toInsert) {
                const created = await tx.rbacModule.create({
                    data: {
                        tenantId: null,
                        key: seed.key,
                        label: seed.label,
                        description: seed.description ?? null,
                        icon: seed.icon ?? null,
                        navPath: seed.navPath ?? null,
                        sortOrder: seed.sortOrder ?? 100,
                        enabled: seed.enabled ?? true,
                        isSystem: true,
                        createdBy: 'backfill-modules',
                    },
                    select: { id: true },
                });

                for (const actionKey of seed.actionKeys) {
                    const actionId = actionIdByKey.get(actionKey)!;
                    await tx.rbacModuleAction.create({
                        data: { tenantId: null, moduleId: created.id, actionId, grantable: true },
                    });
                }

                for (const subjectKey of seed.subjectKeys) {
                    const subjectId = subjectIdByKey.get(subjectKey)!;
                    await tx.rbacSubjectModule.create({
                        data: { tenantId: null, subjectId, moduleId: created.id },
                    });
                }
            }

            if (toInsert.length > 0) {
                await tx.rbacGlobalVersion.update({
                    where: { id: 1 },
                    data: { version: { increment: 1 } },
                });
            }
        });
    }

    console.log(
        `backfill-modules — ${toInsert.length} module(s) ${DRY_RUN ? 'would be inserted' : 'inserted'}, ` +
            `${alreadyPresent} already present`
    );
    for (const seed of toInsert) {
        console.log(
            `  ${DRY_RUN ? '[dry-run] would insert' : 'inserted'}: ${seed.key} ` +
                `(${seed.actionKeys.length} action link(s), ${seed.subjectKeys.length} subject link(s))`
        );
    }
}

main()
    .catch((error: unknown) => {
        console.error('backfill-modules — FAILED:', error);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
