// Exercises assertNoLockout's real queries against the database, in a rolled-back
// transaction. Unit tests stub Prisma, so they cannot tell whether the guard's
// logic is right -- only that it was called. READ-ONLY: always rolls back.
import { PrismaClient, Prisma } from '../node_modules/.prisma/client';
const prisma = new PrismaClient();
const tenantId = process.argv[2];

class Rollback extends Error {}
try {
    await prisma.$transaction(async (tx) => {
        const { assertNoLockout } = await import('../apps/web-ui/lib/rbac/lockout');

        // 1. Healthy tenant: must PASS.
        await assertNoLockout(tx as never, tenantId);
        console.log('PASS  healthy tenant accepted');

        // 2. Remove every unconditional admin grant, then re-check: must THROW.
        const m = await tx.rbacModule.findFirst({ where: { key: 'Settings', OR: [{ tenantId }, { tenantId: null }] }, select: { id: true } });
        const a = await tx.rbacAction.findFirst({ where: { key: 'update', OR: [{ tenantId }, { tenantId: null }] }, select: { id: true } });
        const removed = await tx.rbacRoleRule.deleteMany({
            where: { moduleId: m!.id, actionId: a!.id, inverted: false, conditions: { equals: Prisma.DbNull } },
        });
        try {
            await assertNoLockout(tx as never, tenantId);
            console.log(`FAIL  removed ${removed.count} admin grants and the guard still passed`);
        } catch (e) {
            console.log(`PASS  refused after removing ${removed.count} admin grants: ${(e as Error).message.slice(0, 60)}...`);
        }
        throw new Rollback();
    });
} catch (e) {
    if (!(e instanceof Rollback)) throw e;
    console.log('rolled back — no changes committed');
} finally { await prisma.$disconnect(); }
