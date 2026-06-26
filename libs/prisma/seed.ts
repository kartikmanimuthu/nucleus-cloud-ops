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
}

main().catch(console.error).finally(() => prisma.$disconnect());
