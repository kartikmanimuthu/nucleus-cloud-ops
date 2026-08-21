import { PrismaClient, Prisma } from '../node_modules/.prisma/client';
const prisma = new PrismaClient();
const tenantId = process.argv[2];
const m = await prisma.rbacModule.findFirst({ where: { key: 'Settings', OR: [{ tenantId }, { tenantId: null }] }, select: { id: true } });
const a = await prisma.rbacAction.findFirst({ where: { key: 'update', OR: [{ tenantId }, { tenantId: null }] }, select: { id: true } });
const surviving = await prisma.rbacRoleRule.findMany({
    where: { OR: [{ tenantId }, { tenantId: null }], moduleId: m!.id, actionId: a!.id, inverted: false, conditions: { equals: Prisma.DbNull } },
    select: { roleId: true }, distinct: ['roleId'],
});
const ids = surviving.map((r) => r.roleId);
const names = (await prisma.customRole.findMany({ where: { id: { in: ids } }, select: { name: true } })).map((r) => r.name);
console.log('surviving admin roles:', names.join(', '));
console.log('byRoleId   :', await prisma.userTenantRole.count({ where: { tenantId, roleId: { in: ids } } }));
console.log('byRoleName :', await prisma.userTenantRole.count({ where: { tenantId, role: { in: names } } }));
console.log('byEither   :', await prisma.userTenantRole.count({ where: { tenantId, OR: [{ roleId: { in: ids } }, { role: { in: names } }] } }));
await prisma.$disconnect();
