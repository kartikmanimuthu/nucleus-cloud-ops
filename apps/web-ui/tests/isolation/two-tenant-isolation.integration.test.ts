import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPrismaClient, getTenantClient } from '@/lib/db/pg-config';

declare const __HAS_DB__: boolean;

// Requires a local Postgres (docker compose up -d postgres) + migrations applied.
const TENANT_A = 'test-isolation-tenant-a';
const TENANT_B = 'test-isolation-tenant-b';

describe.skipIf(!__HAS_DB__)('Two-Tenant Isolation', () => {
    let clientA: ReturnType<typeof getTenantClient>;
    let clientB: ReturnType<typeof getTenantClient>;
    const prisma = getPrismaClient(); // unscoped — for seed/cleanup only

    beforeAll(async () => {
        // vitest still invokes suite-level beforeAll/afterAll even when every
        // test in a skipIf'd describe is skipped — guard explicitly rather than
        // rely on skipIf alone to keep this suite DB-free by default.
        if (!__HAS_DB__) return;
        // Create test tenants
        await prisma.tenant.createMany({
            data: [
                { id: TENANT_A, name: 'Isolation Test Tenant A', status: 'active' },
                { id: TENANT_B, name: 'Isolation Test Tenant B', status: 'active' },
            ],
            skipDuplicates: true,
        });

        // Seed Account for each tenant
        await prisma.account.createMany({
            data: [
                { tenantId: TENANT_A, accountId: 'acc-iso-a', name: 'Account A', roleArn: 'arn:aws:iam::111:role/r', regions: [] },
                { tenantId: TENANT_B, accountId: 'acc-iso-b', name: 'Account B', roleArn: 'arn:aws:iam::222:role/r', regions: [] },
            ],
            skipDuplicates: true,
        });

        // Seed Schedule for each tenant
        await prisma.schedule.createMany({
            data: [
                { tenantId: TENANT_A, scheduleId: 'sched-iso-a', accountId: 'acc-iso-a', name: 'Schedule A', starttime: '08:00', endtime: '18:00', days: ['Mon'] },
                { tenantId: TENANT_B, scheduleId: 'sched-iso-b', accountId: 'acc-iso-b', name: 'Schedule B', starttime: '09:00', endtime: '17:00', days: ['Tue'] },
            ],
            skipDuplicates: true,
        });

        // Seed AuditLog for each tenant
        const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        await prisma.auditLog.createMany({
            data: [
                { tenantId: TENANT_A, logId: 'log-iso-a', eventType: 'test', action: 'seed', expiresAt },
                { tenantId: TENANT_B, logId: 'log-iso-b', eventType: 'test', action: 'seed', expiresAt },
            ],
            skipDuplicates: true,
        });

        // Seed ChatMessage for each tenant
        await prisma.chatMessage.createMany({
            data: [
                { tenantId: TENANT_A, sessionId: 'thread-iso-a', role: 'human', content: 'Hello from A', expiresAt },
                { tenantId: TENANT_B, sessionId: 'thread-iso-b', role: 'human', content: 'Hello from B', expiresAt },
            ],
        });

        // Seed AgentMemory for each tenant
        const memExpires = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
        await prisma.agentMemory.createMany({
            data: [
                { tenantId: TENANT_A, userId: 'user-a', namespace: 'test', key: 'mem-a', value: { data: 'a' }, expiresAt: memExpires },
                { tenantId: TENANT_B, userId: 'user-b', namespace: 'test', key: 'mem-b', value: { data: 'b' }, expiresAt: memExpires },
            ],
            skipDuplicates: true,
        });

        // Seed CustomRole for each tenant
        await prisma.customRole.createMany({
            data: [
                { tenantId: TENANT_A, name: 'IsoRoleA', permissions: {}, level: 1, createdBy: 'test' },
                { tenantId: TENANT_B, name: 'IsoRoleB', permissions: {}, level: 1, createdBy: 'test' },
            ],
            skipDuplicates: true,
        });

        clientA = getTenantClient(TENANT_A);
        clientB = getTenantClient(TENANT_B);
    });

    afterAll(async () => {
        if (!__HAS_DB__) return;
        // Cleanup test data (unscoped client)
        await prisma.chatMessage.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
        await prisma.agentMemory.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
        await prisma.customRole.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
        await prisma.auditLog.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
        await prisma.schedule.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
        await prisma.account.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
        await prisma.tenant.deleteMany({ where: { id: { in: [TENANT_A, TENANT_B] } } });
        await prisma.$disconnect();
    });

    // --- Factory validation ---
    it('getTenantClient throws on empty tenantId', () => {
        expect(() => getTenantClient('')).toThrow('tenantId is required');
    });

    it('getTenantClient with valid tenantId returns extended client', () => {
        expect(() => getTenantClient('some-tenant')).not.toThrow();
    });

    // --- Account isolation ---
    describe('Account isolation', () => {
        it('Tenant A sees only its own accounts', async () => {
            const accounts = await clientA.account.findMany();
            expect(accounts.length).toBeGreaterThanOrEqual(1);
            expect(accounts.every(a => a.tenantId === TENANT_A)).toBe(true);
        });

        it('Tenant B sees only its own accounts', async () => {
            const accounts = await clientB.account.findMany();
            expect(accounts.length).toBeGreaterThanOrEqual(1);
            expect(accounts.every(a => a.tenantId === TENANT_B)).toBe(true);
        });

        it('Tenant A cannot find Tenant B account by accountId', async () => {
            const account = await clientA.account.findFirst({ where: { accountId: 'acc-iso-b' } });
            expect(account).toBeNull();
        });

        it('Tenant A count excludes Tenant B records', async () => {
            const countA = await clientA.account.count();
            const countB = await clientB.account.count();
            const countAll = await prisma.account.count({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
            expect(countA + countB).toBe(countAll);
        });
    });

    // --- Schedule isolation ---
    describe('Schedule isolation', () => {
        it('Tenant A sees only its own schedules', async () => {
            const schedules = await clientA.schedule.findMany();
            expect(schedules.every(s => s.tenantId === TENANT_A)).toBe(true);
        });

        it('Tenant B cannot find Tenant A schedule', async () => {
            const schedule = await clientB.schedule.findFirst({ where: { scheduleId: 'sched-iso-a' } });
            expect(schedule).toBeNull();
        });
    });

    // --- AuditLog isolation ---
    describe('AuditLog isolation', () => {
        it('Tenant A sees only its own audit logs', async () => {
            const logs = await clientA.auditLog.findMany();
            expect(logs.every(l => l.tenantId === TENANT_A)).toBe(true);
        });

        it('Tenant B cannot find Tenant A audit log', async () => {
            const log = await clientB.auditLog.findFirst({ where: { logId: 'log-iso-a' } });
            expect(log).toBeNull();
        });
    });

    // --- ChatMessage isolation ---
    describe('ChatMessage isolation', () => {
        it('Tenant A sees only its own chat messages', async () => {
            const msgs = await clientA.chatMessage.findMany();
            expect(msgs.every(m => m.tenantId === TENANT_A)).toBe(true);
        });

        it('Tenant B cannot read Tenant A chat messages', async () => {
            const msgs = await clientB.chatMessage.findMany({ where: { sessionId: 'thread-iso-a' } });
            expect(msgs).toHaveLength(0);
        });
    });

    // --- AgentMemory isolation ---
    describe('AgentMemory isolation', () => {
        it('Tenant A sees only its own memories', async () => {
            const mems = await clientA.agentMemory.findMany();
            expect(mems.every(m => m.tenantId === TENANT_A)).toBe(true);
        });

        it('Tenant B cannot read Tenant A memories', async () => {
            const mem = await clientB.agentMemory.findFirst({ where: { key: 'mem-a' } });
            expect(mem).toBeNull();
        });
    });

    // --- CustomRole isolation ---
    describe('CustomRole isolation', () => {
        it('Tenant A sees only its own custom roles', async () => {
            const roles = await clientA.customRole.findMany();
            expect(roles.every(r => r.tenantId === TENANT_A)).toBe(true);
        });

        it('Tenant B cannot find Tenant A custom role', async () => {
            const role = await clientB.customRole.findFirst({ where: { name: 'IsoRoleA' } });
            expect(role).toBeNull();
        });
    });

    // --- Write isolation ---
    describe('Write isolation', () => {
        it('create via scoped client auto-sets tenantId', async () => {
            const role = await clientA.customRole.create({
                data: { name: 'AutoTenantRole', permissions: {}, level: 1, createdBy: 'test' },
            });
            expect(role.tenantId).toBe(TENANT_A);
            // Cleanup
            await clientA.customRole.delete({ where: { id: role.id } });
        });

        it('Tenant A deleteMany cannot delete Tenant B records', async () => {
            const result = await clientA.auditLog.deleteMany({ where: { logId: 'log-iso-b' } });
            expect(result.count).toBe(0);
            // Verify B's record still exists
            const log = await clientB.auditLog.findFirst({ where: { logId: 'log-iso-b' } });
            expect(log).not.toBeNull();
        });
    });
});
