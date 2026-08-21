// Compiles a role's real ability and probes specific (action, subject) pairs.
// Read-only.
import { PrismaClient } from '../node_modules/.prisma/client';
const prisma = new PrismaClient();
const [tenantId, roleName] = process.argv.slice(2);
const role = await prisma.customRole.findFirst({ where: { name: roleName }, select: { id: true } });
const rules = await prisma.rbacRoleRule.findMany({
    where: { roleId: role!.id },
    select: { inverted: true, module: { select: { key: true } }, subject: { select: { key: true } }, action: { select: { key: true } } },
});
console.log('rules for', roleName + ':');
for (const r of rules) console.log(`   ${r.action.key.padEnd(8)} module=${r.module?.key ?? '-'} subject=${r.subject?.key ?? '-'}${r.inverted ? ' (INVERTED)' : ''}`);
await prisma.$disconnect();
