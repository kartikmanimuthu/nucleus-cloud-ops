import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MockedFunction } from 'vitest';

vi.mock('@/lib/db/pg-config', () => ({
    getTenantClient: vi.fn(),
}));

import { getTenantClient } from '@/lib/db/pg-config';
import { ScheduleExecutionPostgresRepository } from './postgres';

const makeExecutionRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'cuid-1',
    tenantId: 'org-default',
    executionId: 'exec-abc123',
    scheduleId: 'sched-001',
    accountId: 'acc-1',
    status: 'success',
    executionTime: new Date('2024-01-15T10:00:00Z'),
    resourcesStarted: 3,
    resourcesStopped: 0,
    resourcesFailed: 0,
    duration: 45,
    errorMessage: null,
    details: null,
    scheduleMetadata: null,
    expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    ...overrides,
});

describe('ScheduleExecutionPostgresRepository', () => {
    let mockPrisma: {
        scheduleExecution: {
            create: MockedFunction<any>;
            findMany: MockedFunction<any>;
            count: MockedFunction<any>;
        };
    };

    beforeEach(() => {
        mockPrisma = {
            scheduleExecution: {
                create: vi.fn(),
                findMany: vi.fn(),
                count: vi.fn(),
            },
        };
        vi.mocked(getTenantClient).mockReturnValue(mockPrisma as any);
    });

    describe('logExecution', () => {
        it('creates record with expiresAt set approximately 90 days from now', async () => {
            const before = Date.now();
            mockPrisma.scheduleExecution.create.mockResolvedValue(makeExecutionRow());

            const repo = new ScheduleExecutionPostgresRepository();
            await repo.logExecution({
                tenantId: 'org-default',
                accountId: 'acc-1',
                scheduleId: 'sched-001',
                executionTime: new Date().toISOString(),
                status: 'success',
            });

            expect(mockPrisma.scheduleExecution.create).toHaveBeenCalledOnce();
            const createArg = mockPrisma.scheduleExecution.create.mock.calls[0][0];
            const expiresAt: Date = createArg.data.expiresAt;

            const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
            const after = Date.now();

            // expiresAt should be approximately now + 90 days
            expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + ninetyDaysMs - 1000);
            expect(expiresAt.getTime()).toBeLessThanOrEqual(after + ninetyDaysMs + 1000);
        });

        it('includes tenantId and scheduleId in create data', async () => {
            mockPrisma.scheduleExecution.create.mockResolvedValue(makeExecutionRow());

            const repo = new ScheduleExecutionPostgresRepository();
            await repo.logExecution({
                tenantId: 'org-default',
                accountId: 'acc-1',
                scheduleId: 'sched-target',
                executionTime: new Date().toISOString(),
                status: 'failed',
                errorMessage: 'Connection timeout',
            });

            const createArg = mockPrisma.scheduleExecution.create.mock.calls[0][0];
            expect(createArg.data.tenantId).toBe('org-default');
            expect(createArg.data.scheduleId).toBe('sched-target');
            expect(createArg.data.errorMessage).toBe('Connection timeout');
        });

        it('returns ScheduleExecution with generated executionId', async () => {
            mockPrisma.scheduleExecution.create.mockResolvedValue(makeExecutionRow());

            const repo = new ScheduleExecutionPostgresRepository();
            const result = await repo.logExecution({
                tenantId: 'org-default',
                accountId: 'acc-1',
                scheduleId: 'sched-001',
                executionTime: '2024-01-15T10:00:00Z',
                status: 'success',
            });

            expect(result.executionId).toMatch(/^exec-/);
            expect(result.scheduleId).toBe('sched-001');
        });
    });

    describe('getExecutionHistory', () => {
        it('queries with tenantId and scheduleId in WHERE clause', async () => {
            mockPrisma.scheduleExecution.findMany.mockResolvedValue([makeExecutionRow()]);

            const repo = new ScheduleExecutionPostgresRepository();
            await repo.getExecutionHistory('sched-001', 'org-default', 25);

            expect(mockPrisma.scheduleExecution.findMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({
                        tenantId: 'org-default',
                        scheduleId: 'sched-001',
                    }),
                    take: 25,
                })
            );
        });

        it('returns UIScheduleExecution array with ISO timestamp', async () => {
            mockPrisma.scheduleExecution.findMany.mockResolvedValue([
                makeExecutionRow({ executionTime: new Date('2024-03-15T08:00:00Z') }),
            ]);

            const repo = new ScheduleExecutionPostgresRepository();
            const result = await repo.getExecutionHistory('sched-001', 'org-default');

            expect(result).toHaveLength(1);
            expect(result[0].executionTime).toBe('2024-03-15T08:00:00.000Z');
            expect(result[0].id).toBe('exec-abc123');
        });
    });

    describe('getExecutionHistoryPaged', () => {
        it('applies skip/take and scopes count + findMany by tenantId + scheduleId', async () => {
            mockPrisma.scheduleExecution.count.mockResolvedValue(57);
            mockPrisma.scheduleExecution.findMany.mockResolvedValue([makeExecutionRow()]);

            const repo = new ScheduleExecutionPostgresRepository();
            const result = await repo.getExecutionHistoryPaged('sched-001', 'org-default', {
                offset: 20,
                limit: 10,
            });

            expect(mockPrisma.scheduleExecution.count).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({ tenantId: 'org-default', scheduleId: 'sched-001' }),
                })
            );
            expect(mockPrisma.scheduleExecution.findMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({ tenantId: 'org-default', scheduleId: 'sched-001' }),
                    skip: 20,
                    take: 10,
                })
            );
            expect(result.total).toBe(57);
            expect(result.executions).toHaveLength(1);
        });

        it('clamps a negative offset to 0', async () => {
            mockPrisma.scheduleExecution.count.mockResolvedValue(3);
            mockPrisma.scheduleExecution.findMany.mockResolvedValue([]);

            const repo = new ScheduleExecutionPostgresRepository();
            await repo.getExecutionHistoryPaged('sched-001', 'org-default', { offset: -5, limit: 10 });

            expect(mockPrisma.scheduleExecution.findMany).toHaveBeenCalledWith(
                expect.objectContaining({ skip: 0 })
            );
        });
    });

    describe('getRecentExecutions', () => {
        it('queries with tenantId only in WHERE clause', async () => {
            mockPrisma.scheduleExecution.findMany.mockResolvedValue([]);

            const repo = new ScheduleExecutionPostgresRepository();
            await repo.getRecentExecutions('org-default', 75);

            expect(mockPrisma.scheduleExecution.findMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { tenantId: 'org-default' },
                    take: 75,
                })
            );
        });

        it('defaults a null duration to undefined', async () => {
            mockPrisma.scheduleExecution.findMany.mockResolvedValue([makeExecutionRow({ duration: null })]);
            const repo = new ScheduleExecutionPostgresRepository();
            const [result] = await repo.getRecentExecutions('org-default');
            expect(result.duration).toBeUndefined();
        });

        it('returns mapped UIScheduleExecution for recent executions', async () => {
            mockPrisma.scheduleExecution.findMany.mockResolvedValue([
                makeExecutionRow({ status: 'partial', resourcesFailed: 1 }),
            ]);

            const repo = new ScheduleExecutionPostgresRepository();
            const result = await repo.getRecentExecutions('org-default');

            expect(result).toHaveLength(1);
            expect(result[0].status).toBe('partial');
            expect(result[0].resourcesFailed).toBe(1);
        });
    });

    describe('error wrapping', () => {
        it('logExecution wraps a DB failure', async () => {
            mockPrisma.scheduleExecution.create.mockRejectedValue(new Error('DB down'));
            const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const repo = new ScheduleExecutionPostgresRepository();
            await expect(repo.logExecution({
                tenantId: 'org-default', scheduleId: 's1', accountId: 'a1', status: 'success', executionTime: '',
            } as any)).rejects.toThrow('Failed to log execution: DB down');
            consoleSpy.mockRestore();
        });

        it('getExecutionHistory wraps a DB failure', async () => {
            mockPrisma.scheduleExecution.findMany.mockRejectedValue(new Error('DB down'));
            const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const repo = new ScheduleExecutionPostgresRepository();
            await expect(repo.getExecutionHistory('s1', 'org-default')).rejects.toThrow('Failed to get execution history: DB down');
            consoleSpy.mockRestore();
        });

        it('getExecutionHistoryPaged wraps a DB failure', async () => {
            mockPrisma.scheduleExecution.count.mockRejectedValue(new Error('DB down'));
            mockPrisma.scheduleExecution.findMany.mockRejectedValue(new Error('DB down'));
            const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const repo = new ScheduleExecutionPostgresRepository();
            await expect(repo.getExecutionHistoryPaged('s1', 'org-default', { offset: 0, limit: 10 }))
                .rejects.toThrow('Failed to get paged execution history: DB down');
            consoleSpy.mockRestore();
        });

        it('getRecentExecutions wraps a DB failure', async () => {
            mockPrisma.scheduleExecution.findMany.mockRejectedValue(new Error('DB down'));
            const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const repo = new ScheduleExecutionPostgresRepository();
            await expect(repo.getRecentExecutions('org-default')).rejects.toThrow('Failed to get recent executions: DB down');
            consoleSpy.mockRestore();
        });

        it('stringifies a non-Error throw in the wrapped message', async () => {
            mockPrisma.scheduleExecution.findMany.mockRejectedValue('raw failure');
            const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const repo = new ScheduleExecutionPostgresRepository();
            await expect(repo.getRecentExecutions('org-default')).rejects.toThrow('Failed to get recent executions: raw failure');
            consoleSpy.mockRestore();
        });

        it('stringifies a non-Error throw for logExecution and getExecutionHistoryPaged', async () => {
            const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

            mockPrisma.scheduleExecution.create.mockRejectedValue('raw failure');
            const repo = new ScheduleExecutionPostgresRepository();
            await expect(repo.logExecution({
                tenantId: 'org-default', scheduleId: 's1', accountId: 'a1', status: 'success', executionTime: '',
            } as any)).rejects.toThrow('Failed to log execution: raw failure');

            mockPrisma.scheduleExecution.count.mockRejectedValue('raw failure');
            mockPrisma.scheduleExecution.findMany.mockRejectedValue('raw failure');
            await expect(repo.getExecutionHistoryPaged('s1', 'org-default', { offset: 0, limit: 10 }))
                .rejects.toThrow('Failed to get paged execution history: raw failure');

            consoleSpy.mockRestore();
        });
    });
});

describe('ScheduleExecutionPostgresRepository — tenant isolation', () => {
    let mockPrisma: {
        scheduleExecution: {
            create: MockedFunction<any>;
            findMany: MockedFunction<any>;
        };
    };

    beforeEach(() => {
        mockPrisma = {
            scheduleExecution: {
                create: vi.fn(),
                findMany: vi.fn().mockResolvedValue([]),
            },
        };
        vi.mocked(getTenantClient).mockReturnValue(mockPrisma as any);
    });

    it('logExecution calls getTenantClient with correct tenantId', async () => {
        mockPrisma.scheduleExecution.create.mockResolvedValue({
            id: 'cuid-1', tenantId: 'tenant-test', executionId: 'exec-1', scheduleId: 'sched-1',
            accountId: 'acc-1', status: 'success', executionTime: new Date(),
            resourcesStarted: 0, resourcesStopped: 0, resourcesFailed: 0,
            duration: null, errorMessage: null, details: null, scheduleMetadata: null,
            expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
        });
        const repo = new ScheduleExecutionPostgresRepository();
        await repo.logExecution({
            tenantId: 'tenant-test', accountId: 'acc-1', scheduleId: 'sched-1',
            executionTime: new Date().toISOString(), status: 'success',
        });
        expect(getTenantClient).toHaveBeenCalledWith('tenant-test');
    });

    it('getExecutionHistory calls getTenantClient with correct tenantId', async () => {
        const repo = new ScheduleExecutionPostgresRepository();
        await repo.getExecutionHistory('sched-1', 'tenant-test');
        expect(getTenantClient).toHaveBeenCalledWith('tenant-test');
    });

    it('getRecentExecutions calls getTenantClient with correct tenantId', async () => {
        const repo = new ScheduleExecutionPostgresRepository();
        await repo.getRecentExecutions('tenant-test');
        expect(getTenantClient).toHaveBeenCalledWith('tenant-test');
    });
});
