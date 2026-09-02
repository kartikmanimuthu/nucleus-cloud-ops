import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MockedFunction } from 'vitest';

// Partial mock: only the client factories are stubbed. andWhere() is the real
// implementation — it is pure, and a stub of it would hide the row-filter
// composition this repository depends on.
vi.mock('@/lib/db/pg-config', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/db/pg-config')>()),
    getTenantClient: vi.fn(),
}));

import { getTenantClient } from '@/lib/db/pg-config';
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
        vi.mocked(getTenantClient).mockReturnValue(mockPrisma as any);
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

        it('defaults to page 1 and limit 20 when not provided', async () => {
            mockPrisma.schedule.count.mockResolvedValue(5);
            mockPrisma.schedule.findMany.mockResolvedValue([]);

            const repo = new SchedulePostgresRepository();
            await repo.getSchedules({ tenantId: 'tenant-1' });

            expect(mockPrisma.schedule.findMany).toHaveBeenCalledWith(
                expect.objectContaining({ skip: 0, take: 20 })
            );
        });

        it('uses custom limit of 25', async () => {
            mockPrisma.schedule.count.mockResolvedValue(80);
            mockPrisma.schedule.findMany.mockResolvedValue([]);

            const repo = new SchedulePostgresRepository();
            await repo.getSchedules({ tenantId: 'tenant-1', page: 1, limit: 25 });

            expect(mockPrisma.schedule.findMany).toHaveBeenCalledWith(
                expect.objectContaining({ skip: 0, take: 25 })
            );
        });

        it('uses custom limit of 50 on page 2', async () => {
            mockPrisma.schedule.count.mockResolvedValue(200);
            mockPrisma.schedule.findMany.mockResolvedValue([]);

            const repo = new SchedulePostgresRepository();
            await repo.getSchedules({ tenantId: 'tenant-1', page: 2, limit: 50 });

            expect(mockPrisma.schedule.findMany).toHaveBeenCalledWith(
                expect.objectContaining({ skip: 50, take: 50 })
            );
        });

        it('adds accountId to the where clause when given', async () => {
            mockPrisma.schedule.count.mockResolvedValue(0);
            mockPrisma.schedule.findMany.mockResolvedValue([]);
            const repo = new SchedulePostgresRepository();
            await repo.getSchedules({ tenantId: 'org-default', accountId: 'acc-1' });
            expect(mockPrisma.schedule.findMany.mock.calls[0][0].where.accountId).toBe('acc-1');
        });

        it('intersects a Gate-3 row filter under AND without discarding the search OR clause', async () => {
            mockPrisma.schedule.count.mockResolvedValue(0);
            mockPrisma.schedule.findMany.mockResolvedValue([]);
            const repo = new SchedulePostgresRepository();
            await repo.getSchedules({ tenantId: 'org-default', searchTerm: 'x', rowFilter: { accountId: { in: ['a1'] } } });
            const where = mockPrisma.schedule.findMany.mock.calls[0][0].where;
            expect(where.OR).toBeDefined();
            expect(where.AND).toEqual([{ accountId: { in: ['a1'] } }]);
        });

        it('applies resourceFilter in memory, narrowing to schedules whose resources include the type', async () => {
            mockPrisma.schedule.count.mockResolvedValue(2);
            mockPrisma.schedule.findMany.mockResolvedValue([
                makeScheduleRow({ scheduleId: 'sched-ec2', resources: [{ type: 'ec2' }] }),
                makeScheduleRow({ scheduleId: 'sched-rds', resources: [{ type: 'rds' }] }),
            ]);
            const repo = new SchedulePostgresRepository();
            const result = await repo.getSchedules({ tenantId: 'org-default', resourceFilter: 'ec2' });
            expect(result.schedules.map((s) => s.id)).toEqual(['sched-ec2']);
            // total reflects the unfiltered DB count — the in-memory narrowing doesn't touch pagination.
            expect(result.total).toBe(2);
        });

        it('does not filter when resourceFilter is "all"', async () => {
            mockPrisma.schedule.count.mockResolvedValue(1);
            mockPrisma.schedule.findMany.mockResolvedValue([makeScheduleRow({ resources: [{ type: 'ec2' }] })]);
            const repo = new SchedulePostgresRepository();
            const result = await repo.getSchedules({ tenantId: 'org-default', resourceFilter: 'all' });
            expect(result.schedules).toHaveLength(1);
        });

        it('wraps a repository failure in a descriptive error', async () => {
            mockPrisma.schedule.findMany.mockRejectedValue(new Error('DB down'));
            mockPrisma.schedule.count.mockRejectedValue(new Error('DB down'));
            const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const repo = new SchedulePostgresRepository();
            await expect(repo.getSchedules({ tenantId: 'org-default' })).rejects.toThrow('Failed to get schedules: DB down');
            consoleSpy.mockRestore();
        });

        it('stringifies a non-Error throw in the wrapped message', async () => {
            mockPrisma.schedule.findMany.mockRejectedValue('raw failure');
            mockPrisma.schedule.count.mockRejectedValue('raw failure');
            const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const repo = new SchedulePostgresRepository();
            await expect(repo.getSchedules({ tenantId: 'org-default' })).rejects.toThrow('Failed to get schedules: raw failure');
            consoleSpy.mockRestore();
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

        it('defaults to tenant "org-default" when no tenantId is given', async () => {
            mockPrisma.schedule.findFirst.mockResolvedValue(null);
            const repo = new SchedulePostgresRepository();
            await repo.getSchedule('sched-abc');
            expect(mockPrisma.schedule.findFirst.mock.calls[0][0].where.tenantId).toBe('org-default');
        });

        it('narrows a UUID lookup by accountId when given', async () => {
            mockPrisma.schedule.findFirst.mockResolvedValue(null);
            const repo = new SchedulePostgresRepository();
            await repo.getSchedule('sched-abc', 'acc-1', 'org-default');
            expect(mockPrisma.schedule.findFirst.mock.calls[0][0].where.accountId).toBe('acc-1');
        });

        it('falls back to a name-based lookup when the id does not start with "sched-"', async () => {
            mockPrisma.schedule.findFirst.mockResolvedValue(null);
            const repo = new SchedulePostgresRepository();
            await repo.getSchedule('Morning Shutdown', undefined, 'org-default');
            expect(mockPrisma.schedule.findFirst.mock.calls[0][0].where).toEqual({
                tenantId: 'org-default', name: 'Morning Shutdown',
            });
        });

        it('narrows a name-based lookup by accountId when given', async () => {
            mockPrisma.schedule.findFirst.mockResolvedValue(null);
            const repo = new SchedulePostgresRepository();
            await repo.getSchedule('Morning Shutdown', 'acc-1', 'org-default');
            expect(mockPrisma.schedule.findFirst.mock.calls[0][0].where.accountId).toBe('acc-1');
        });

        it('returns the mapped schedule for a name-based lookup', async () => {
            mockPrisma.schedule.findFirst.mockResolvedValue(makeScheduleRow());
            const repo = new SchedulePostgresRepository();
            const result = await repo.getSchedule('Morning Shutdown', undefined, 'org-default');
            expect(result?.name).toBe('Morning Shutdown');
        });

        it('wraps a repository failure in a descriptive error', async () => {
            mockPrisma.schedule.findFirst.mockRejectedValue(new Error('DB down'));
            const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const repo = new SchedulePostgresRepository();
            await expect(repo.getSchedule('sched-abc', undefined, 'org-default')).rejects.toThrow('Failed to get schedule: DB down');
            consoleSpy.mockRestore();
        });

        it('stringifies a non-Error throw in the wrapped message', async () => {
            mockPrisma.schedule.findFirst.mockRejectedValue('raw failure');
            const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const repo = new SchedulePostgresRepository();
            await expect(repo.getSchedule('sched-abc', undefined, 'org-default')).rejects.toThrow('Failed to get schedule: raw failure');
            consoleSpy.mockRestore();
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

        it('defaults timezone/days/active/resources/createdBy/updatedBy when omitted', async () => {
            mockPrisma.schedule.create.mockResolvedValue(makeScheduleRow());
            const repo = new SchedulePostgresRepository();
            await repo.createSchedule({
                name: 'Bare', starttime: '09:00', endtime: '17:00', accounts: ['acc-1'],
            } as any, 'org-default');

            const data = mockPrisma.schedule.create.mock.calls[0][0].data;
            expect(data.timezone).toBe('UTC');
            expect(data.days).toEqual([]);
            expect(data.active).toBe(true);
            expect(data.resources).toEqual([]);
            expect(data.createdBy).toBe('system');
            expect(data.updatedBy).toBe('system');
        });

        it('honors explicit timezone/days/active/resources/createdBy/updatedBy', async () => {
            mockPrisma.schedule.create.mockResolvedValue(makeScheduleRow());
            const repo = new SchedulePostgresRepository();
            await repo.createSchedule({
                name: 'Full', starttime: '09:00', endtime: '17:00', accounts: ['acc-1'],
                timezone: 'America/New_York', days: ['Mon'], active: false,
                resources: [{ type: 'ec2' }], createdBy: 'alice', updatedBy: 'bob',
            } as any, 'org-default');

            const data = mockPrisma.schedule.create.mock.calls[0][0].data;
            expect(data.timezone).toBe('America/New_York');
            expect(data.active).toBe(false);
            expect(data.resources).toEqual([{ type: 'ec2' }]);
            expect(data.createdBy).toBe('alice');
            expect(data.updatedBy).toBe('bob');
        });

        it('wraps a repository failure in a descriptive error', async () => {
            mockPrisma.schedule.create.mockRejectedValue(new Error('DB down'));
            const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const repo = new SchedulePostgresRepository();
            await expect(repo.createSchedule({
                name: 'x', starttime: '09:00', endtime: '17:00', accounts: ['acc-1'],
            } as any, 'org-default')).rejects.toThrow('Failed to create schedule: DB down');
            consoleSpy.mockRestore();
        });

        it('stringifies a non-Error throw in the wrapped message', async () => {
            mockPrisma.schedule.create.mockRejectedValue('raw failure');
            const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const repo = new SchedulePostgresRepository();
            await expect(repo.createSchedule({
                name: 'x', starttime: '09:00', endtime: '17:00', accounts: ['acc-1'],
            } as any, 'org-default')).rejects.toThrow('Failed to create schedule: raw failure');
            consoleSpy.mockRestore();
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

        it('writes every whitelisted field when all are supplied', async () => {
            mockPrisma.schedule.update.mockResolvedValue(makeScheduleRow());
            const repo = new SchedulePostgresRepository();
            await repo.updateSchedule('sched-abc', {
                name: 'x', description: 'd', starttime: '10:00', endtime: '18:00', timezone: 'UTC',
                days: ['Tue'], active: true, resources: [{ type: 'ec2' }], updatedBy: 'alice',
            } as any, 'org-default');

            const data = mockPrisma.schedule.update.mock.calls[0][0].data;
            expect(data.name).toBe('x');
            expect(data.resources).toEqual([{ type: 'ec2' }]);
            expect(data.updatedBy).toBe('alice');
        });

        it('defaults resources to [] when explicitly cleared to a falsy value', async () => {
            mockPrisma.schedule.update.mockResolvedValue(makeScheduleRow());
            const repo = new SchedulePostgresRepository();
            await repo.updateSchedule('sched-abc', { resources: null } as any, 'org-default');
            expect(mockPrisma.schedule.update.mock.calls[0][0].data.resources).toEqual([]);
        });

        it('writes no whitelisted field when the update object is empty', async () => {
            mockPrisma.schedule.update.mockResolvedValue(makeScheduleRow());
            const repo = new SchedulePostgresRepository();
            await repo.updateSchedule('sched-abc', {}, 'org-default');
            expect(mockPrisma.schedule.update.mock.calls[0][0].data).toEqual({});
        });

        it('wraps a repository failure in a descriptive error', async () => {
            mockPrisma.schedule.update.mockRejectedValue(new Error('DB down'));
            const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const repo = new SchedulePostgresRepository();
            await expect(repo.updateSchedule('sched-abc', { name: 'x' }, 'org-default')).rejects.toThrow('Failed to update schedule: DB down');
            consoleSpy.mockRestore();
        });

        it('stringifies a non-Error throw in the wrapped message', async () => {
            mockPrisma.schedule.update.mockRejectedValue('raw failure');
            const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const repo = new SchedulePostgresRepository();
            await expect(repo.updateSchedule('sched-abc', { name: 'x' }, 'org-default')).rejects.toThrow('Failed to update schedule: raw failure');
            consoleSpy.mockRestore();
        });
    });

    describe('deleteSchedule', () => {
        it('scopes the delete by tenantId and scheduleId', async () => {
            mockPrisma.schedule.deleteMany.mockResolvedValue({ count: 1 });
            const repo = new SchedulePostgresRepository();
            await repo.deleteSchedule('sched-abc', 'org-default');
            expect(mockPrisma.schedule.deleteMany).toHaveBeenCalledWith({ where: { tenantId: 'org-default', scheduleId: 'sched-abc' } });
        });

        it('wraps a repository failure in a descriptive error', async () => {
            mockPrisma.schedule.deleteMany.mockRejectedValue(new Error('DB down'));
            const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const repo = new SchedulePostgresRepository();
            await expect(repo.deleteSchedule('sched-abc', 'org-default')).rejects.toThrow('Failed to delete schedule: DB down');
            consoleSpy.mockRestore();
        });

        it('stringifies a non-Error throw in the wrapped message', async () => {
            mockPrisma.schedule.deleteMany.mockRejectedValue('raw failure');
            const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const repo = new SchedulePostgresRepository();
            await expect(repo.deleteSchedule('sched-abc', 'org-default')).rejects.toThrow('Failed to delete schedule: raw failure');
            consoleSpy.mockRestore();
        });
    });

    describe('transformToUISchedule — days sorting, resourceTypes, and computeNextExecution', () => {
        // computeNextExecution builds candidates with `new Date(...)` + `.getDay()`/`.setHours()`,
        // all LOCAL-timezone methods — it takes a `timezone` param but never actually uses it for
        // the date math. Fixing "now" pins the day-of-week; expected values are built the same
        // LOCAL-time way the production code builds them, so the assertions hold under any TZ
        // the test happens to run in (not just UTC).
        const NOW = new Date();
        NOW.setHours(10, 0, 0, 0); // a fixed local time, well before the 18:00 test schedules below

        beforeEach(() => {
            vi.useFakeTimers();
            vi.setSystemTime(NOW);
        });
        afterEach(() => {
            vi.useRealTimers();
        });

        it('sorts days into calendar order regardless of input order', async () => {
            mockPrisma.schedule.findFirst.mockResolvedValue(makeScheduleRow({ days: ['Fri', 'Mon', 'Wed'] }));
            const repo = new SchedulePostgresRepository();
            const result = await repo.getSchedule('sched-abc', undefined, 'org-default');
            expect(result?.days).toEqual(['Mon', 'Wed', 'Fri']);
        });

        it('dedupes resourceTypes and drops falsy entries', async () => {
            mockPrisma.schedule.findFirst.mockResolvedValue(makeScheduleRow({
                resources: [{ type: 'ec2' }, { type: 'ec2' }, { type: '' }, { type: 'rds' }],
            }));
            const repo = new SchedulePostgresRepository();
            const result = await repo.getSchedule('sched-abc', undefined, 'org-default');
            expect(result?.resourceTypes).toEqual(['ec2', 'rds']);
        });

        it('defaults a null resources column to [] rather than propagating null', async () => {
            mockPrisma.schedule.findFirst.mockResolvedValue(makeScheduleRow({ resources: null }));
            const repo = new SchedulePostgresRepository();
            const result = await repo.getSchedule('sched-abc', undefined, 'org-default');
            expect(result?.resourceTypes).toEqual([]);
        });

        it('sorts an unrecognized day name to the end rather than throwing', async () => {
            // Three entries so the sort compares the unmapped name on both sides of the
            // comparator (unmapped-vs-mapped and mapped-vs-unmapped), exercising the ?? 99
            // fallback for both operands, not just one.
            mockPrisma.schedule.findFirst.mockResolvedValue(makeScheduleRow({ days: ['Weekday', 'Tue', 'Mon'] }));
            const repo = new SchedulePostgresRepository();
            const result = await repo.getSchedule('sched-abc', undefined, 'org-default');
            expect(result?.days).toEqual(['Mon', 'Tue', 'Weekday']);
        });

        it('sorts two unrecognized day names against each other, exercising the fallback on both sides', async () => {
            mockPrisma.schedule.findFirst.mockResolvedValue(makeScheduleRow({ days: ['Someday', 'Otherday'] }));
            const repo = new SchedulePostgresRepository();
            const result = await repo.getSchedule('sched-abc', undefined, 'org-default');
            expect(result?.days).toHaveLength(2);
        });

        it('leaves nextExecution undefined when the only scheduled day is today and its time has already passed', async () => {
            mockPrisma.schedule.findFirst.mockResolvedValue(makeScheduleRow({ days: [today], starttime: '08:00:00' }));
            const repo = new SchedulePostgresRepository();
            const result = await repo.getSchedule('sched-abc', undefined, 'org-default');
            expect(result?.nextExecution).toBeUndefined();
        });

        it('defaults description to "" when null', async () => {
            mockPrisma.schedule.findFirst.mockResolvedValue(makeScheduleRow({ description: null }));
            const repo = new SchedulePostgresRepository();
            const result = await repo.getSchedule('sched-abc', undefined, 'org-default');
            expect(result?.description).toBe('');
        });

        it('leaves nextExecution undefined for an inactive schedule', async () => {
            mockPrisma.schedule.findFirst.mockResolvedValue(makeScheduleRow({ active: false }));
            const repo = new SchedulePostgresRepository();
            const result = await repo.getSchedule('sched-abc', undefined, 'org-default');
            expect(result?.nextExecution).toBeUndefined();
        });

        it('leaves nextExecution undefined when days is empty', async () => {
            mockPrisma.schedule.findFirst.mockResolvedValue(makeScheduleRow({ days: [] }));
            const repo = new SchedulePostgresRepository();
            const result = await repo.getSchedule('sched-abc', undefined, 'org-default');
            expect(result?.nextExecution).toBeUndefined();
        });

        it('leaves nextExecution undefined when starttime is empty', async () => {
            mockPrisma.schedule.findFirst.mockResolvedValue(makeScheduleRow({ starttime: '' }));
            const repo = new SchedulePostgresRepository();
            const result = await repo.getSchedule('sched-abc', undefined, 'org-default');
            expect(result?.nextExecution).toBeUndefined();
        });

        const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const today = DAY_NAMES[NOW.getDay()];
        const twoDaysOut = DAY_NAMES[(NOW.getDay() + 2) % 7];

        it('computes the next execution later today when the start time has not passed yet', async () => {
            mockPrisma.schedule.findFirst.mockResolvedValue(makeScheduleRow({ days: [today], starttime: '18:00:00' }));
            const repo = new SchedulePostgresRepository();
            const result = await repo.getSchedule('sched-abc', undefined, 'org-default');

            const expected = new Date(NOW);
            expected.setHours(18, 0, 0, 0);
            expect(result?.nextExecution).toBe(expected.toISOString());
        });

        it("rolls over to the next matching day when today's start time has already passed", async () => {
            mockPrisma.schedule.findFirst.mockResolvedValue(makeScheduleRow({ days: [today, twoDaysOut], starttime: '08:00:00' }));
            const repo = new SchedulePostgresRepository();
            const result = await repo.getSchedule('sched-abc', undefined, 'org-default');

            const expected = new Date(NOW.getTime() + 2 * 86400000);
            expected.setHours(8, 0, 0, 0);
            expect(result?.nextExecution).toBe(expected.toISOString());
        });

        it('defaults seconds to 0 when starttime omits them', async () => {
            mockPrisma.schedule.findFirst.mockResolvedValue(makeScheduleRow({ days: [today], starttime: '18:00' }));
            const repo = new SchedulePostgresRepository();
            const result = await repo.getSchedule('sched-abc', undefined, 'org-default');

            const expected = new Date(NOW);
            expected.setHours(18, 0, 0, 0);
            expect(result?.nextExecution).toBe(expected.toISOString());
        });
    });
});

describe('SchedulePostgresRepository — tenant isolation', () => {
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
                findMany: vi.fn().mockResolvedValue([]),
                count: vi.fn().mockResolvedValue(0),
                findFirst: vi.fn().mockResolvedValue(null),
                create: vi.fn(),
                update: vi.fn(),
                deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
            },
        };
        vi.mocked(getTenantClient).mockReturnValue(mockPrisma as any);
    });

    it('getSchedules calls getTenantClient with correct tenantId', async () => {
        const repo = new SchedulePostgresRepository();
        await repo.getSchedules({ tenantId: 'tenant-test' });
        expect(getTenantClient).toHaveBeenCalledWith('tenant-test');
    });

    it('getSchedule calls getTenantClient with correct tenantId', async () => {
        const repo = new SchedulePostgresRepository();
        await repo.getSchedule('sched-abc', undefined, 'tenant-test');
        expect(getTenantClient).toHaveBeenCalledWith('tenant-test');
    });

    it('createSchedule calls getTenantClient with correct tenantId', async () => {
        mockPrisma.schedule.create.mockResolvedValue({
            id: 'cuid-1', tenantId: 'tenant-test', scheduleId: 'sched-new', accountId: 'acc-1',
            name: 'Test', description: null, starttime: '09:00', endtime: '17:00', timezone: 'UTC',
            days: ['Mon'], active: true, resources: [], createdAt: new Date(), updatedAt: new Date(),
            createdBy: 'system', updatedBy: 'system',
        });
        const repo = new SchedulePostgresRepository();
        await repo.createSchedule({
            name: 'Test', active: true, days: ['Mon'], starttime: '09:00', endtime: '17:00',
            timezone: 'UTC', accounts: ['acc-1'], resourceTypes: [], description: '',
            executionCount: 0, successRate: 100, estimatedSavings: 0,
        }, 'tenant-test');
        expect(getTenantClient).toHaveBeenCalledWith('tenant-test');
    });

    it('updateSchedule calls getTenantClient with correct tenantId', async () => {
        mockPrisma.schedule.update.mockResolvedValue({
            id: 'cuid-1', tenantId: 'tenant-test', scheduleId: 'sched-abc', accountId: 'acc-1',
            name: 'Updated', description: null, starttime: '09:00', endtime: '17:00', timezone: 'UTC',
            days: ['Mon'], active: false, resources: [], createdAt: new Date(), updatedAt: new Date(),
            createdBy: 'system', updatedBy: 'system',
        });
        const repo = new SchedulePostgresRepository();
        await repo.updateSchedule('sched-abc', { active: false }, 'tenant-test');
        expect(getTenantClient).toHaveBeenCalledWith('tenant-test');
    });

    it('deleteSchedule calls getTenantClient with correct tenantId', async () => {
        const repo = new SchedulePostgresRepository();
        await repo.deleteSchedule('sched-abc', 'tenant-test');
        expect(getTenantClient).toHaveBeenCalledWith('tenant-test');
    });
});
