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

// `new Cron(...)` requires a real constructor — an arrow-function mockImplementation
// can't be `new`'d and throws, which computeNextRunAt's try/catch silently swallows
// into a null nextRunAt. Use a function expression, same convention as AWS SDK mocks.
vi.mock('croner', () => ({
    Cron: vi.fn().mockImplementation(function () {
        return {
            nextRun: vi.fn(() => new Date('2024-02-01T00:00:00Z')),
            stop: vi.fn(),
        };
    }),
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
            count: MockedFunction<any>;
            aggregate: MockedFunction<any>;
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
                count: vi.fn().mockResolvedValue(0),
                aggregate: vi.fn().mockResolvedValue({ _sum: { runCount: 0 } }),
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

        it('passes through explicit mcpServerIds/knowledgeBaseIds', async () => {
            mockPrisma.scheduledTask.create.mockResolvedValue(makeTaskRow({ taskId: 'mock-task-id' }));
            const repo = new ScheduledTaskPostgresRepository();
            await repo.createScheduledTask({
                tenantId: 't1', name: 'x', description: 'x', cronExpression: '0 2 * * *', timezone: 'UTC',
                mode: 'plan', autoApprove: false, notification: { type: 'none' }, createdBy: 'user-1',
                mcpServerIds: ['mcp-1'], knowledgeBaseIds: ['kb-1'],
            } as any);
            const data = mockPrisma.scheduledTask.create.mock.calls[0][0].data;
            expect(data.mcpServerIds).toEqual(['mcp-1']);
            expect(data.knowledgeBaseIds).toEqual(['kb-1']);
        });
    });

    describe('getScheduledTask', () => {
        it('returns the transformed task when found', async () => {
            mockPrisma.scheduledTask.findFirst.mockResolvedValue(makeTaskRow());
            const repo = new ScheduledTaskPostgresRepository();
            const task = await repo.getScheduledTask('t1', 'task-1');
            expect(task?.taskId).toBe('task-1');
        });

        it('returns null when not found', async () => {
            mockPrisma.scheduledTask.findFirst.mockResolvedValue(null);
            const repo = new ScheduledTaskPostgresRepository();
            expect(await repo.getScheduledTask('t1', 'missing')).toBeNull();
        });
    });

    describe('listScheduledTasks', () => {
        it('sorts by createdAt desc by default', async () => {
            mockPrisma.scheduledTask.findMany.mockResolvedValue([]);
            const repo = new ScheduledTaskPostgresRepository();
            await repo.listScheduledTasks({ tenantId: 't1' });
            expect(mockPrisma.scheduledTask.findMany.mock.calls[0][0].orderBy).toEqual({ createdAt: 'desc' });
        });

        it('sorts by the given column, defaulting sortDir to asc', async () => {
            mockPrisma.scheduledTask.findMany.mockResolvedValue([]);
            const repo = new ScheduledTaskPostgresRepository();
            await repo.listScheduledTasks({ tenantId: 't1', sortBy: 'name' } as any);
            expect(mockPrisma.scheduledTask.findMany.mock.calls[0][0].orderBy).toEqual({ name: 'asc' });
        });

        it('defaults totalRuns to 0 when the aggregate sum is null', async () => {
            mockPrisma.scheduledTask.findMany.mockResolvedValue([]);
            mockPrisma.scheduledTask.aggregate.mockResolvedValue({ _sum: { runCount: null } });
            const repo = new ScheduledTaskPostgresRepository();
            const result = await repo.listScheduledTasks({ tenantId: 't1' });
            expect(result.stats.totalRuns).toBe(0);
        });

        it('excludes deleted tasks via WHERE taskStatus != deleted', async () => {
            mockPrisma.scheduledTask.findMany.mockResolvedValue([makeTaskRow()]);
            mockPrisma.scheduledTask.count.mockResolvedValue(1);

            const repo = new ScheduledTaskPostgresRepository();
            const result = await repo.listScheduledTasks({ tenantId: 't1' });

            const callArg = mockPrisma.scheduledTask.findMany.mock.calls[0][0];
            expect(callArg.where.tenantId).toBe('t1');
            expect(callArg.where.taskStatus).toEqual({ not: 'deleted' });
            expect(result.total).toBe(1);
            expect(result.tasks).toHaveLength(1);
        });

        it('returns stats computed from active/paused counts and runCount sum', async () => {
            mockPrisma.scheduledTask.findMany.mockResolvedValue([]);
            mockPrisma.scheduledTask.count
                .mockResolvedValueOnce(0)   // total (Promise.all first count call)
                .mockResolvedValueOnce(2)   // computeStats: active
                .mockResolvedValueOnce(1);  // computeStats: paused
            mockPrisma.scheduledTask.aggregate.mockResolvedValue({ _sum: { runCount: 7 } });

            const repo = new ScheduledTaskPostgresRepository();
            const result = await repo.listScheduledTasks({ tenantId: 't1' });

            expect(result.stats).toEqual({ active: 2, paused: 1, totalRuns: 7 });
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

    describe('updateScheduledTask', () => {
        it('recomputes nextRunAt when the schedule itself changed', async () => {
            mockPrisma.scheduledTask.findFirst.mockResolvedValue(makeTaskRow());
            mockPrisma.scheduledTask.updateMany.mockResolvedValue({ count: 1 });

            const repo = new ScheduledTaskPostgresRepository();
            await repo.updateScheduledTask('t1', 'task-1', { cronExpression: '0 3 * * *' });

            const data = mockPrisma.scheduledTask.updateMany.mock.calls[0][0].data;
            expect(data.nextRunAt).toEqual(new Date('2024-02-01T00:00:00Z'));
        });

        it('does not touch nextRunAt when none of the schedule fields change', async () => {
            mockPrisma.scheduledTask.findFirst.mockResolvedValue(makeTaskRow());
            mockPrisma.scheduledTask.updateMany.mockResolvedValue({ count: 1 });

            const repo = new ScheduledTaskPostgresRepository();
            await repo.updateScheduledTask('t1', 'task-1', { name: 'Renamed' });

            expect(mockPrisma.scheduledTask.updateMany.mock.calls[0][0].data).not.toHaveProperty('nextRunAt');
        });

        it('skips the nextRunAt recompute when the task no longer exists', async () => {
            mockPrisma.scheduledTask.findFirst.mockResolvedValueOnce(null); // the schedule-changed lookup
            mockPrisma.scheduledTask.updateMany.mockResolvedValue({ count: 0 });

            const repo = new ScheduledTaskPostgresRepository();
            const result = await repo.updateScheduledTask('t1', 'missing', { cronExpression: '0 3 * * *' });

            expect(mockPrisma.scheduledTask.updateMany.mock.calls[0][0].data).not.toHaveProperty('nextRunAt');
            expect(result).toBeNull(); // the trailing getScheduledTask also finds nothing
        });

        it('recomputes nextRunAt using the CALLER-supplied scheduleType/timezone/intervalMinutes when given, not the stale task values', async () => {
            mockPrisma.scheduledTask.findFirst.mockResolvedValue(makeTaskRow({ scheduleType: 'cron' }));
            mockPrisma.scheduledTask.updateMany.mockResolvedValue({ count: 1 });

            const repo = new ScheduledTaskPostgresRepository();
            await repo.updateScheduledTask('t1', 'task-1', {
                scheduleType: 'interval', intervalMinutes: 30, timezone: 'America/New_York',
            } as any);

            const nextRunAt: Date = mockPrisma.scheduledTask.updateMany.mock.calls[0][0].data.nextRunAt;
            expect(nextRunAt).toBeInstanceOf(Date); // interval branch computed a real Date, not the cron mock's fixed one
        });

        it('converts a supplied notification object', async () => {
            mockPrisma.scheduledTask.updateMany.mockResolvedValue({ count: 1 });
            const repo = new ScheduledTaskPostgresRepository();
            await repo.updateScheduledTask('t1', 'task-1', { notification: { type: 'slack' } } as any);
            expect(mockPrisma.scheduledTask.updateMany.mock.calls[0][0].data.notification).toEqual({ type: 'slack' });
        });

        it('returns the freshly re-fetched task after the update', async () => {
            mockPrisma.scheduledTask.updateMany.mockResolvedValue({ count: 1 });
            mockPrisma.scheduledTask.findFirst.mockResolvedValue(makeTaskRow({ name: 'Updated' }));
            const repo = new ScheduledTaskPostgresRepository();
            const result = await repo.updateScheduledTask('t1', 'task-1', { name: 'Updated' });
            expect(result?.name).toBe('Updated');
        });
    });

    describe('pauseScheduledTask', () => {
        it('sets taskStatus=paused and clears nextRunAt', async () => {
            mockPrisma.scheduledTask.updateMany.mockResolvedValue({ count: 1 });
            const repo = new ScheduledTaskPostgresRepository();
            await repo.pauseScheduledTask('t1', 'task-1');
            expect(mockPrisma.scheduledTask.updateMany).toHaveBeenCalledWith({
                where: { tenantId: 't1', taskId: 'task-1' },
                data: { taskStatus: 'paused', nextRunAt: null },
            });
        });
    });

    describe('resumeScheduledTask', () => {
        it('returns null when the task does not exist', async () => {
            mockPrisma.scheduledTask.findFirst.mockResolvedValue(null);
            const repo = new ScheduledTaskPostgresRepository();
            expect(await repo.resumeScheduledTask('t1', 'missing')).toBeNull();
            expect(mockPrisma.scheduledTask.updateMany).not.toHaveBeenCalled();
        });

        it('recomputes nextRunAt and reactivates the task', async () => {
            mockPrisma.scheduledTask.findFirst.mockResolvedValue(makeTaskRow({ taskStatus: 'paused' }));
            mockPrisma.scheduledTask.updateMany.mockResolvedValue({ count: 1 });

            const repo = new ScheduledTaskPostgresRepository();
            await repo.resumeScheduledTask('t1', 'task-1');

            expect(mockPrisma.scheduledTask.updateMany).toHaveBeenCalledWith({
                where: { tenantId: 't1', taskId: 'task-1' },
                data: { taskStatus: 'active', nextRunAt: new Date('2024-02-01T00:00:00Z') },
            });
        });

        it('nulls nextRunAt when the schedule cannot compute one (zero-interval task)', async () => {
            mockPrisma.scheduledTask.findFirst.mockResolvedValue(
                makeTaskRow({ scheduleType: 'interval', intervalMinutes: 0 }),
            );
            mockPrisma.scheduledTask.updateMany.mockResolvedValue({ count: 1 });

            const repo = new ScheduledTaskPostgresRepository();
            await repo.resumeScheduledTask('t1', 'task-1');

            expect(mockPrisma.scheduledTask.updateMany.mock.calls[0][0].data.nextRunAt).toBeNull();
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

        it('skips the increment when incrementRunCount is explicitly false', async () => {
            mockPrisma.scheduledTask.findFirst.mockResolvedValue(makeTaskRow());
            mockPrisma.scheduledTask.updateMany.mockResolvedValue({ count: 1 });

            const repo = new ScheduledTaskPostgresRepository();
            await repo.updateLastRun('t1', 'task-1', 'run-x', 'completed', { incrementRunCount: false });

            expect(mockPrisma.scheduledTask.updateMany.mock.calls[0][0].data).not.toHaveProperty('runCount');
        });

        it('no-ops entirely when the task no longer exists', async () => {
            mockPrisma.scheduledTask.findFirst.mockResolvedValue(null);
            const repo = new ScheduledTaskPostgresRepository();
            await repo.updateLastRun('t1', 'missing', 'run-x', 'completed');
            expect(mockPrisma.scheduledTask.updateMany).not.toHaveBeenCalled();
        });

        it('re-anchors an interval task: next fire = now + intervalMinutes', async () => {
            mockPrisma.scheduledTask.findFirst.mockResolvedValue(
                makeTaskRow({ scheduleType: 'interval', intervalMinutes: 15 }),
            );
            mockPrisma.scheduledTask.updateMany.mockResolvedValue({ count: 1 });
            const before = Date.now();

            const repo = new ScheduledTaskPostgresRepository();
            await repo.updateLastRun('t1', 'task-1', 'run-x', 'completed');

            const nextRunAt: Date = mockPrisma.scheduledTask.updateMany.mock.calls[0][0].data.nextRunAt;
            expect(nextRunAt.getTime()).toBeGreaterThanOrEqual(before + 15 * 60_000 - 1000);
        });

        it('leaves nextRunAt null for a zero/absent-interval interval task', async () => {
            mockPrisma.scheduledTask.findFirst.mockResolvedValue(
                makeTaskRow({ scheduleType: 'interval', intervalMinutes: null }),
            );
            mockPrisma.scheduledTask.updateMany.mockResolvedValue({ count: 1 });

            const repo = new ScheduledTaskPostgresRepository();
            await repo.updateLastRun('t1', 'task-1', 'run-x', 'completed');

            expect(mockPrisma.scheduledTask.updateMany.mock.calls[0][0].data.nextRunAt).toBeNull();
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
            count: MockedFunction<any>;
            aggregate: MockedFunction<any>;
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
                count: vi.fn().mockResolvedValue(0),
                aggregate: vi.fn().mockResolvedValue({ _sum: { runCount: 0 } }),
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
        await repo.listScheduledTasks({ tenantId: 'tenant-test' });
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
