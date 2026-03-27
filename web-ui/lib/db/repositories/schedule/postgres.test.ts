import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MockedFunction } from 'vitest';

vi.mock('@/lib/db/pg-config', () => ({
    getPrismaClient: vi.fn(),
}));

import { getPrismaClient } from '@/lib/db/pg-config';
import { SchedulePostgresRepository } from './postgres';

const makeScheduleRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'cuid-1',
    tenantId: 'org-default',
    scheduleId: 'sched-abc',
    accountId: 'acc-1',
    name: 'Morning Shutdown',
    description: 'Stops instances at night',
    starttime: '18:00',
    endtime: '08:00',
    timezone: 'UTC',
    days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
    active: true,
    resources: [],
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-02T00:00:00Z'),
    createdBy: 'system',
    updatedBy: 'system',
    ...overrides,
});

describe('SchedulePostgresRepository', () => {
    let mockPrisma: {
        schedule: {
            findMany: MockedFunction<any>;
            count: MockedFunction<any>;
            findFirst: MockedFunction<any>;
            create: MockedFunction<any>;
            update: MockedFunction<any>;
            deleteMany: MockedFunction<any>;
        };
    };

    beforeEach(() => {
        mockPrisma = {
            schedule: {
                findMany: vi.fn(),
                count: vi.fn(),
                findFirst: vi.fn(),
                create: vi.fn(),
                update: vi.fn(),
                deleteMany: vi.fn(),
            },
        };
        vi.mocked(getPrismaClient).mockReturnValue(mockPrisma as any);
    });

    describe('getSchedules', () => {
        it('queries with tenantId in where clause', async () => {
            mockPrisma.schedule.count.mockResolvedValue(1);
            mockPrisma.schedule.findMany.mockResolvedValue([makeScheduleRow()]);

            const repo = new SchedulePostgresRepository();
            const result = await repo.getSchedules({ tenantId: 'org-default' });

            expect(mockPrisma.schedule.findMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({ tenantId: 'org-default' }),
                })
            );
            expect(result.total).toBe(1);
            expect(result.schedules).toHaveLength(1);
        });

        it('sets where.active=true for statusFilter=active', async () => {
            mockPrisma.schedule.count.mockResolvedValue(1);
            mockPrisma.schedule.findMany.mockResolvedValue([makeScheduleRow({ active: true })]);

            const repo = new SchedulePostgresRepository();
            await repo.getSchedules({ tenantId: 'org-default', statusFilter: 'active' });

            const callArg = mockPrisma.schedule.findMany.mock.calls[0][0];
            expect(callArg.where.active).toBe(true);
        });

        it('sets where.active=false for statusFilter=inactive', async () => {
            mockPrisma.schedule.count.mockResolvedValue(1);
            mockPrisma.schedule.findMany.mockResolvedValue([makeScheduleRow({ active: false })]);

            const repo = new SchedulePostgresRepository();
            await repo.getSchedules({ tenantId: 'org-default', statusFilter: 'inactive' });

            const callArg = mockPrisma.schedule.findMany.mock.calls[0][0];
            expect(callArg.where.active).toBe(false);
        });

        it('adds OR array with ILIKE for searchTerm', async () => {
            mockPrisma.schedule.count.mockResolvedValue(1);
            mockPrisma.schedule.findMany.mockResolvedValue([makeScheduleRow()]);

            const repo = new SchedulePostgresRepository();
            await repo.getSchedules({ tenantId: 'org-default', searchTerm: 'morning' });

            const callArg = mockPrisma.schedule.findMany.mock.calls[0][0];
            expect(callArg.where.OR).toBeDefined();
            expect(callArg.where.OR).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ name: expect.objectContaining({ contains: 'morning', mode: 'insensitive' }) }),
                ])
            );
        });

        it('does NOT add active filter when statusFilter is "all"', async () => {
            mockPrisma.schedule.count.mockResolvedValue(2);
            mockPrisma.schedule.findMany.mockResolvedValue([makeScheduleRow(), makeScheduleRow({ id: 'cuid-2', scheduleId: 'sched-2', active: false })]);

            const repo = new SchedulePostgresRepository();
            await repo.getSchedules({ tenantId: 'org-default', statusFilter: 'all' });

            const callArg = mockPrisma.schedule.findMany.mock.calls[0][0];
            expect(callArg.where.active).toBeUndefined();
        });

        it('applies skip/take for pagination', async () => {
            mockPrisma.schedule.count.mockResolvedValue(30);
            mockPrisma.schedule.findMany.mockResolvedValue([]);

            const repo = new SchedulePostgresRepository();
            await repo.getSchedules({ tenantId: 'org-default', page: 3, limit: 5 });

            const callArg = mockPrisma.schedule.findMany.mock.calls[0][0];
            expect(callArg.skip).toBe(10); // (3-1) * 5
            expect(callArg.take).toBe(5);
        });
    });

    describe('getSchedule', () => {
        it('returns null when findFirst returns null', async () => {
            mockPrisma.schedule.findFirst.mockResolvedValue(null);

            const repo = new SchedulePostgresRepository();
            const result = await repo.getSchedule('sched-missing', undefined, 'org-default');

            expect(result).toBeNull();
        });

        it('returns UISchedule when record found by UUID', async () => {
            mockPrisma.schedule.findFirst.mockResolvedValue(makeScheduleRow({ scheduleId: 'sched-abc' }));

            const repo = new SchedulePostgresRepository();
            const result = await repo.getSchedule('sched-abc', undefined, 'org-default');

            expect(result).not.toBeNull();
            expect(result!.id).toBe('sched-abc');
            expect(result!.name).toBe('Morning Shutdown');
        });

        it('includes tenantId in findFirst where clause', async () => {
            mockPrisma.schedule.findFirst.mockResolvedValue(null);

            const repo = new SchedulePostgresRepository();
            await repo.getSchedule('sched-abc', undefined, 'tenant-x');

            expect(mockPrisma.schedule.findFirst).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({ tenantId: 'tenant-x' }),
                })
            );
        });
    });

    describe('createSchedule', () => {
        it('calls prisma.schedule.create with tenantId and returns UISchedule', async () => {
            mockPrisma.schedule.create.mockResolvedValue(
                makeScheduleRow({ name: 'New Schedule', scheduleId: 'sched-new' })
            );

            const repo = new SchedulePostgresRepository();
            const result = await repo.createSchedule(
                {
                    name: 'New Schedule',
                    active: true,
                    days: ['Mon'],
                    starttime: '09:00',
                    endtime: '17:00',
                    timezone: 'UTC',
                    accounts: ['acc-1'],
                    resourceTypes: [],
                    description: '',
                    executionCount: 0,
                    successRate: 100,
                    estimatedSavings: 0,
                },
                'org-default'
            );

            expect(mockPrisma.schedule.create).toHaveBeenCalledOnce();
            const createArg = mockPrisma.schedule.create.mock.calls[0][0];
            expect(createArg.data.tenantId).toBe('org-default');
            expect(result.id).toBe('sched-new');
        });

        it('throws if no accountId in accounts array', async () => {
            const repo = new SchedulePostgresRepository();

            await expect(
                repo.createSchedule(
                    {
                        name: 'No Account',
                        active: true,
                        days: [],
                        starttime: '09:00',
                        endtime: '17:00',
                        timezone: 'UTC',
                        accounts: [], // empty
                        resourceTypes: [],
                        description: '',
                        executionCount: 0,
                        successRate: 100,
                        estimatedSavings: 0,
                    },
                    'org-default'
                )
            ).rejects.toThrow('accountId is required');
        });
    });

    describe('updateSchedule', () => {
        it('calls prisma.schedule.update with tenantId_scheduleId compound key', async () => {
            mockPrisma.schedule.update.mockResolvedValue(makeScheduleRow({ active: false }));

            const repo = new SchedulePostgresRepository();
            const result = await repo.updateSchedule('sched-abc', { active: false }, 'org-default');

            expect(mockPrisma.schedule.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({
                        tenantId_scheduleId: { tenantId: 'org-default', scheduleId: 'sched-abc' },
                    }),
                })
            );
            expect(result.active).toBe(false);
        });
    });
});
