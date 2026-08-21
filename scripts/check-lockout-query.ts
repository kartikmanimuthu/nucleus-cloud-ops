import { PrismaClient, Prisma } from '../node_modules/.prisma/client';
const prisma = new PrismaClient();
const tenantId = process.argv[2];
const m = await prisma.rbacModule.findFirst({ where: { key: 'Settings', OR: [{ tenantId }, { tenantId: null }] }, select: { id: true } });
const a = await prisma.rbacAction.findFirst({ where: { key: 'update', OR: [{ tenantId }, { tenantId: null }] }, select: { id: true } });
const base = { moduleId: m!.id, actionId: a!.id, inverted: false };
const variants: [string, object][] = [
    ['tenantId exact + conditions:{equals:null}', { ...base, tenantId, conditions: { equals: null } }],
    ['tenantId exact + conditions:DbNull',        { ...base, tenantId, conditions: { equals: Prisma.DbNull } }],
    ['tenant-or-global + conditions:DbNull',      { ...base, OR: [{ tenantId }, { tenantId: null }], conditions: { equals: Prisma.DbNull } }],
];
for (const [label, where] of variants) {
    const rows = await prisma.rbacRoleRule.findMany({ where: where as never, select: { roleId: true }, distinct: ['roleId'] });
    console.log(String(rows.length).padStart(2), '<-', label);
}
await prisma.$disconnect();
