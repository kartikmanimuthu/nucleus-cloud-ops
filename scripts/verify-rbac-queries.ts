// Executes the exact query SHAPES used by lockout.ts and role-rule-sync.ts
// against the real database. Unit tests stub Prisma, so an invalid shape (a null
// inside `in`) passes there and only fails at runtime. Read-only.
import { PrismaClient } from '../node_modules/.prisma/client';
const prisma = new PrismaClient();
const tenantId = process.argv[2];
if (!tenantId) { console.error('usage: bun run scripts/verify-rbac-queries.ts <tenantId>'); process.exit(1); }
const scope = { OR: [{ tenantId }, { tenantId: null }] };
try {
    const modules = await prisma.rbacModule.findMany({ where: { ...scope, enabled: true }, select: { id: true, key: true, tenantId: true } });
    const actions = await prisma.rbacAction.findMany({ where: scope, select: { id: true, key: true, tenantId: true } });
    const settings = await prisma.rbacModule.findMany({ where: { ...scope, key: 'Settings', enabled: true }, select: { id: true, tenantId: true } });
    console.log(JSON.stringify({ modules: modules.length, actions: actions.length, settingsRows: settings.length }, null, 2));
} finally { await prisma.$disconnect(); }
