import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MockedFunction } from 'vitest';

// Partial mock: only the client factories are stubbed. andWhere() is the real
// implementation — it is pure, and a stub of it would hide the row-filter
// composition this repository depends on.
vi.mock('@/lib/db/pg-config', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/db/pg-config')>()),
    getPrismaClient: vi.fn(),
    getTenantClient: vi.fn(),
}));

vi.mock('uuid', () => ({ v4: vi.fn(() => 'mock-task-id') }));

vi.mock('croner', () => ({
    Cron: vi.fn().mockImplementation(() => ({
        nextRun: vi.fn(() => new Date('2024-02-01T00:00:00Z')),
        stop: vi.fn(),
    })),
}));

import { getPrismaClient, getTenantClient } from '@/lib/db/pg-config';
import { ScheduledTaskPostgresRepository } from './postgres';

const makeTaskRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'cuid-1',
    tenantId: 't1',
    taskId: 'task-1',
    name: 'Daily Cleanup',
    description: 'Runs daily',
    cronExpression: '0 2 * * *',
    timezone: 'UTC',
    taskStatus: 'active',
    mode: 'plan',
    autoApprove: false,
    model: null,
    accountId: null,
    accountName: null,
    mcpServerIds: [],
    notification: { type: 'none' },
    lastRunId: null,
    lastRunAt: null,
    lastRunStatus: null,
    nextRunAt: new Date('2024-02-01T00:00:00Z'),
    runCount: 0,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    createdBy: 'user-1',
    ...overrides,
});

describe('ScheduledTaskPostgresRepository', () => {
    let mockPrisma: {
        scheduledTask: {
            create: MockedFunction<any>;
            findFirst: MockedFunction<any>;
            findMany: MockedFunction<any>;
            updateMany: MockedFunction<any>;
        };
        scheduledTaskLock: {
            findUnique: MockedFunction<any>;
        };
        $executeRaw: MockedFunction<any>;
    };

    beforeEach(() => {
        mockPrisma = {
            scheduledTask: {
                create: vi.fn(),
                findFirst: vi.fn(),
                findMany: vi.fn(),
                updateMany: vi.fn(),
            },
            scheduledTaskLock: {
                findUnique: vi.fn(),
            },
            $executeRaw: vi.fn(),
        };
        vi.mocked(getPrismaClient).mockReturnValue(mockPrisma as any);
        vi.mocked(getTenantClient).mockReturnValue(mockPrisma as any);
    });

    describe('createScheduledTask', () => {
        it('creates task with generated taskId', async () => {
            mockPrisma.scheduledTask.create.mockResolvedValue(
                makeTaskRow({ taskId: 'mock-task-id' })
            );

            const repo = new ScheduledTaskPostgresRepository();
            const result = await repo.createScheduledTask({
                tenantId: 't1',
                name: 'Daily Cleanup',
                description: 'Runs daily',
                cronExpression: '0 2 * * *',
                timezone: 'UTC',
                mode: 'plan',
                autoApprove: false,
                notification: { type: 'none' },
                createdBy: 'user-1',
            });

            expect(result.taskId).toBe('mock-task-id');
            expect(result.taskStatus).toBe('active');
            expect(result.runCount).toBe(0);
            expect(mockPrisma.scheduledTask.create).toHaveBeenCalledOnce();
        });
    });

    describe('listScheduledTasks', () => {
        it('excludes deleted tasks via WHERE taskStatus != deleted', async () => {
            mockPrisma.scheduledTask.findMany.mockResolvedValue([makeTaskRow()]);

            const repo = new ScheduledTaskPostgresRepository();
            await repo.listScheduledTasks('t1');

            const callArg = mockPrisma.scheduledTask.findMany.mock.calls[0][0];
            expect(callArg.where.tenantId).toBe('t1');
            expect(callArg.where.taskStatus).toEqual({ not: 'deleted' });
        });
    });

    describe('listAllActiveTasks', () => {
        it('returns only active tasks across all tenants', async () => {
            mockPrisma.scheduledTask.findMany.mockResolvedValue([makeTaskRow()]);

            const repo = new ScheduledTaskPostgresRepository();
            await repo.listAllActiveTasks();

            const callArg = mockPrisma.scheduledTask.findMany.mock.calls[0][0];
            expect(callArg.where.taskStatus).toBe('active');
            // No tenantId filter — cross-tenant query
            expect(callArg.where.tenantId).toBeUndefined();
        });
    });

    describe('deleteScheduledTask', () => {
        it('soft-deletes by setting taskStatus=deleted', async () => {
            mockPrisma.scheduledTask.updateMany.mockResolvedValue({ count: 1 });

            const repo = new ScheduledTaskPostgresRepository();
            await repo.deleteScheduledTask('t1', 'task-1');

            expect(mockPrisma.scheduledTask.updateMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({ tenantId: 't1', taskId: 'task-1' }),
                    data: expect.objectContaining({ taskStatus: 'deleted' }),
                })
            );
        });
    });

    describe('updateLastRun', () => {
        it('increments runCount via Prisma increment', async () => {
            mockPrisma.scheduledTask.findFirst.mockResolvedValue(makeTaskRow({ runCount: 3 }));
            mockPrisma.scheduledTask.updateMany.mockResolvedValue({ count: 1 });

            const repo = new ScheduledTaskPostgresRepository();
            await repo.updateLastRun('t1', 'task-1', 'run-x', 'completed');

            const callArg = mockPrisma.scheduledTask.updateMany.mock.calls[0][0];
            expect(callArg.data.runCount).toEqual({ increment: 1 });
            expect(callArg.data.lastRunId).toBe('run-x');
            expect(callArg.data.lastRunStatus).toBe('completed');
        });
    });

    describe('tryAcquireExecutionLock', () => {
        it('returns true when the INSERT affects a row (lock acquired)', async () => {
            mockPrisma.$executeRaw.mockResolvedValue(1);

            const repo = new ScheduledTaskPostgresRepository();
            const result = await repo.tryAcquireExecutionLock('task-1', '2024-01-01T02:00:00Z');

            expect(result).toBe(true);
            expect(mockPrisma.$executeRaw).toHaveBeenCalledOnce();
        });

        it('returns false when ON CONFLICT DO NOTHING affects zero rows (lock already held)', async () => {
            mockPrisma.$executeRaw.mockResolvedValue(0);

            const repo = new ScheduledTaskPostgresRepository();
            const result = await repo.tryAcquireExecutionLock('task-1', '2024-01-01T02:00:00Z');

            expect(result).toBe(false);
        });

        it('returns false on database error', async () => {
            mockPrisma.$executeRaw.mockRejectedValue(new Error('DB error'));

            const repo = new ScheduledTaskPostgresRepository();
            const result = await repo.tryAcquireExecutionLock('task-1', '2024-01-01T02:00:00Z');

            expect(result).toBe(false);
        });
    });
});

describe('ScheduledTaskPostgresRepository — tenant isolation', () => {
    let mockPrisma: {
        scheduledTask: {
            create: MockedFunction<any>;
            findFirst: MockedFunction<any>;
            findMany: MockedFunction<any>;
            updateMany: MockedFunction<any>;
        };
        scheduledTaskLock: { findUnique: MockedFunction<any> };
        $executeRaw: MockedFunction<any>;
    };

    beforeEach(() => {
        mockPrisma = {
            scheduledTask: {
                create: vi.fn(),
                findFirst: vi.fn().mockResolvedValue(null),
                findMany: vi.fn().mockResolvedValue([]),
                updateMany: vi.fn().mockResolvedValue({ count: 1 }),
            },
            scheduledTaskLock: { findUnique: vi.fn().mockResolvedValue(null) },
            $executeRaw: vi.fn().mockResolvedValue(1),
        };
        vi.mocked(getPrismaClient).mockReturnValue(mockPrisma as any);
        vi.mocked(getTenantClient).mockReturnValue(mockPrisma as any);
    });

    it('createScheduledTask calls getTenantClient with correct tenantId', async () => {
        mockPrisma.scheduledTask.create.mockResolvedValue(makeTaskRow({ taskId: 'mock-task-id' }));
        const repo = new ScheduledTaskPostgresRepository();
        await repo.createScheduledTask({
            tenantId: 'tenant-test', name: 'Test', description: 'desc',
            cronExpression: '0 2 * * *', timezone: 'UTC', mode: 'plan',
            autoApprove: false, notification: { type: 'none' }, createdBy: 'user-1',
        });
        expect(getTenantClient).toHaveBeenCalledWith('tenant-test');
    });

    it('getScheduledTask calls getTenantClient with correct tenantId', async () => {
        const repo = new ScheduledTaskPostgresRepository();
        await repo.getScheduledTask('tenant-test', 'task-1');
        expect(getTenantClient).toHaveBeenCalledWith('tenant-test');
    });

    it('listScheduledTasks calls getTenantClient with correct tenantId', async () => {
        const repo = new ScheduledTaskPostgresRepository();
        await repo.listScheduledTasks('tenant-test');
        expect(getTenantClient).toHaveBeenCalledWith('tenant-test');
    });

    it('updateScheduledTask calls getTenantClient with correct tenantId', async () => {
        const repo = new ScheduledTaskPostgresRepository();
        await repo.updateScheduledTask('tenant-test', 'task-1', { name: 'Updated' });
        expect(getTenantClient).toHaveBeenCalledWith('tenant-test');
    });

    it('deleteScheduledTask calls getTenantClient with correct tenantId', async () => {
        const repo = new ScheduledTaskPostgresRepository();
        await repo.deleteScheduledTask('tenant-test', 'task-1');
        expect(getTenantClient).toHaveBeenCalledWith('tenant-test');
    });
});
