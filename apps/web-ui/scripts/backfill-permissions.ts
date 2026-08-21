/**
 * backfill-permissions.ts — one-shot script to seed new global rbac_actions
 * ("permissions") rows now that the Permissions admin screen has been
 * removed. Fill in SEED_ACTIONS below with the real data before running for
 * real.
 *
 *   cd apps/web-ui && tsx scripts/backfill-permissions.ts --dry-run   # inspect, write nothing
 *   cd apps/web-ui && tsx scripts/backfill-permissions.ts             # apply
 *
 * Known limitations:
 * - Run this script before backfill-modules.ts if a seed module's
 *   actionKeys references a permission only this script would create.
 * - These scripts write rows nothing in the app can delete afterward
 *   (global system rows are unconditionally undeletable through the API) —
 *   double-check SEED_ACTIONS/SEED_MODULES before a real run, --dry-run
 *   first.
 * - A version bump now runs automatically when anything is inserted, so
 *   warm app processes will see new rows without a restart.
 */

// Same import style as backfill-rbac.ts: reach the generated client directly
// rather than through lib/db/pg-config, which is written for the Next
// runtime and its `@/` alias.
import { PrismaClient } from '../../../node_modules/.prisma/client';

const prisma = new PrismaClient();
const DRY_RUN = process.argv.includes('--dry-run');

interface SeedAction {
    key: string;
    label: string;
    description?: string;
    aliasOfKey?: string;
    isDangerous?: boolean;
    sortOrder?: number;
}

const SEED_ACTIONS: SeedAction[] = [
    // filled in with the real business data before this runs for real
];

const ACTION_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;
const RESERVED_ACTION_KEYS: ReadonlySet<string> = new Set(['manage', 'all']);

async function main(): Promise<void> {
    console.log(`backfill-permissions — ${DRY_RUN ? 'DRY RUN (no writes)' : 'APPLYING'}`);

    const existing = await prisma.rbacAction.findMany({
        where: { tenantId: null },
        select: { key: true },
    });
    const existingKeys = new Set(existing.map((a) => a.key));
    const seedKeys = new Set(SEED_ACTIONS.map((a) => a.key));

    // Validate key/label shape before checking aliases — the removed UI
    // enforced this, and a bad row written by this script can never be
    // deleted through the app (deleteAction refuses global rows
    // unconditionally).
    const invalidKeys: string[] = [];
    for (const seed of SEED_ACTIONS) {
        if (!ACTION_KEY_PATTERN.test(seed.key)) {
            invalidKeys.push(`'${seed.key}' is not a valid permission key — use a lowercase identifier such as 'restart'`);
        }
        if (RESERVED_ACTION_KEYS.has(seed.key)) {
            invalidKeys.push(`'${seed.key}' is reserved by the permission engine and cannot be redefined`);
        }
        if (!seed.label.trim()) {
            invalidKeys.push(`'${seed.key}' has a blank label`);
        }
        if (seed.aliasOfKey === seed.key) {
            invalidKeys.push(`'${seed.key}' cannot be an alias of itself`);
        }
    }

    // aliasOfKey must resolve to a key that already exists in the DB or
    // appears elsewhere in this same seed list — an alias to nothing is a
    // dangling reference the CASL alias resolver can't follow.
    const unknownAliases: string[] = [];
    for (const seed of SEED_ACTIONS) {
        if (seed.aliasOfKey && !existingKeys.has(seed.aliasOfKey) && !seedKeys.has(seed.aliasOfKey)) {
            unknownAliases.push(`${seed.key} -> aliasOfKey '${seed.aliasOfKey}'`);
        }
    }
    if (invalidKeys.length > 0 || unknownAliases.length > 0) {
        console.error('backfill-permissions — ABORTED:');
        for (const line of invalidKeys) console.error(`  invalid key/label: ${line}`);
        for (const line of unknownAliases) console.error(`  unknown aliasOfKey: ${line}`);
        process.exitCode = 1;
        return;
    }

    const toInsert = SEED_ACTIONS.filter((a) => !existingKeys.has(a.key));
    const alreadyPresent = SEED_ACTIONS.length - toInsert.length;

    if (!DRY_RUN) {
        await prisma.$transaction(async (tx) => {
            for (const seed of toInsert) {
                await tx.rbacAction.create({
                    data: {
                        tenantId: null,
                        key: seed.key,
                        label: seed.label,
                        description: seed.description ?? null,
                        aliasOfKey: seed.aliasOfKey ?? null,
                        isDangerous: seed.isDangerous ?? false,
                        isSystem: true,
                        sortOrder: seed.sortOrder ?? 100,
                        createdBy: 'backfill-permissions',
                    },
                });
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
        `backfill-permissions — ${toInsert.length} ${DRY_RUN ? 'would be inserted' : 'inserted'}, ` +
            `${alreadyPresent} already present`
    );
    for (const seed of toInsert) {
        console.log(`  ${DRY_RUN ? '[dry-run] would insert' : 'inserted'}: ${seed.key}`);
    }
}

main()
    .catch((error: unknown) => {
        console.error('backfill-permissions — FAILED:', error);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
