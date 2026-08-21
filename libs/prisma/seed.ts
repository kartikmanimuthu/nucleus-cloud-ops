/**
 * Prisma seed script — upserts 4 global preset roles (tenantId=null, type=preset).
 *
 * Preset roles are global singletons. Tenant creation no longer duplicates them per-tenant.
 * Run: cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/multitenancy && npx prisma db seed
 */
// Import from the generated output path (schema `client` generator output = "../../node_modules/.prisma/client",
// relative to libs/prisma/schema.prisma -> workspace root node_modules/.prisma/client)
import { PrismaClient } from '../../node_modules/.prisma/client';
import { ROLE_PERMISSIONS, ROLE_LEVELS } from '../../apps/web-ui/lib/rbac/permissions';

const prisma = new PrismaClient();

async function main() {
    const presets = [
        { name: 'Owner' as const, level: ROLE_LEVELS.Owner },
        { name: 'Admin' as const, level: ROLE_LEVELS.Admin },
        { name: 'Member' as const, level: ROLE_LEVELS.Member },
        { name: 'Viewer' as const, level: ROLE_LEVELS.Viewer },
    ];

    for (const p of presets) {
        await prisma.customRole.upsert({
            where: { id: `preset-${p.name.toLowerCase()}` },
            update: { permissions: ROLE_PERMISSIONS[p.name] as object, level: p.level },
            create: {
                id: `preset-${p.name.toLowerCase()}`,
                tenantId: null,
                type: 'preset',
                name: p.name,
                permissions: ROLE_PERMISSIONS[p.name] as object,
                level: p.level,
                createdBy: 'system',
            },
        });
    }
    console.log('Seed: 4 preset roles upserted (tenantId=null, type=preset).');

    await assertRbacRegistrySeeded();
}

/**
 * The RBAC registry is seeded by 20260730000000_dynamic_abac/migration.sql, NOT
 * here — enforcement depends on those rows existing, and the container runs
 * `prisma migrate deploy` without ever running this seed.
 *
 * It is deliberately not duplicated into this file. Both apps run
 * `prisma migrate deploy` in their `predev`/`prestart` hooks, so a local database
 * already has the registry by the time anyone runs the seed; a second copy of ~200
 * INSERT statements would add no local capability and would drift from the
 * migration, which is the copy that actually runs in production.
 *
 * This check exists so that a developer whose database predates the migration
 * gets told exactly that, instead of watching every permission check fail closed.
 */
async function assertRbacRegistrySeeded() {
    const [modules, actions, subjects, rules] = await Promise.all([
        prisma.rbacModule.count({ where: { tenantId: null } }),
        prisma.rbacAction.count({ where: { tenantId: null } }),
        prisma.rbacSubject.count({ where: { tenantId: null } }),
        prisma.rbacRoleRule.count({ where: { tenantId: null } }),
    ]);

    if (modules === 0 || actions === 0 || subjects === 0) {
        console.error(
            '\nSeed: RBAC registry is EMPTY.\n' +
                '  The system registry ships inside 20260730000000_dynamic_abac/migration.sql.\n' +
                '  Run:  cd apps/web-ui && bun run db:migrate:deploy\n'
        );
        throw new Error('RBAC registry not seeded — run the migrations first.');
    }

    console.log(
        `Seed: RBAC registry present (${modules} modules, ${actions} actions, ` +
            `${subjects} subjects, ${rules} preset rules) — seeded by the migration.`
    );
}

main().catch(console.error).finally(() => prisma.$disconnect());
