/**
 * Prisma seed script — documents default role structure.
 *
 * Default roles (Owner/Admin/Member/Viewer) are seeded per-tenant at creation time
 * via the POST /api/tenants route. This script is a no-op placeholder that can be
 * extended for test fixtures or future reference data.
 *
 * Run: cd web-ui && npm run db:seed
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    console.log('Seed: default roles are seeded per-tenant on creation via POST /api/tenants.');
    console.log('Seed complete.');
}

main().catch(console.error).finally(() => prisma.$disconnect());
