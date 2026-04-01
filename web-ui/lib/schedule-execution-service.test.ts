import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the repository factory
vi.mock('@/lib/db/repository-factory', () => ({
    getScheduleExecutionRepository: vi.fn(),
}));

// Mock aws-config (DEFAULT_TENANT_ID removed — tenantId is now always explicit)
vi.mock('@/lib/aws-config', () => ({
    getDynamoDBDocumentClient: vi.fn(),
    APP_TABLE_NAME: 'test-table',
    AUDIT_TABLE_NAME: 'test-audit-table',
}));

import { getScheduleExecutionRepository } from '@/lib/db/repository-factory';
import { ScheduleExecutionService } from './schedule-execution-service';

const makeExecution = (overrides: Record<string, unknown> = {}) => ({
    id: 'exec-1',
    executionId: 'exec-1',
    tenantId: 'org-default',
    accountId: 'acc-1',
    scheduleId: 'sched-1',
    executionTime: '2024-01-15T08:00:00Z',
    status: 'success' as const,
    resourcesStarted: 3,
    resourcesStopped: 0,
    resourcesFailed: 0,
    duration: 45,
    ...overrides,
});

describe('ScheduleExecutionService', () => {
    let mockRepo: {
        logExecution: ReturnType<typeof vi.fn>;
        getExecutionHistory: ReturnType<typeof vi.fn>;
        getRecentExecutions: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
        vi.clearAllMocks();
        mockRepo = {
            logExecution: vi.fn(),
            getExecutionHistory: vi.fn(),
            getRecentExecutions: vi.fn(),
        };
        vi.mocked(getScheduleExecutionRepository).mockReturnValue(mockRepo as any);
    });

    describe('logExecution', () => {
        it('delegates to repo.logExecution', async () => {
            const exec = makeExecution();
            mockRepo.logExecution.mockResolvedValue(exec);

            const result = await ScheduleExecutionService.logExecution(exec as any);

            expect(mockRepo.logExecution).toHaveBeenCalledWith(exec);
            expect(result.executionId).toBe('exec-1');
        });

        it('re-throws on error', async () => {
            mockRepo.logExecution.mockRejectedValue(new Error('Log failed'));

            await expect(ScheduleExecutionService.logExecution({} as any)).rejects.toThrow('Log failed');
        });
    });

    describe('getExecutionsForSchedule', () => {
        it('delegates to repo.getExecutionHistory with limit', async () => {
            mockRepo.getExecutionHistory.mockResolvedValue([makeExecution()]);

            const result = await ScheduleExecutionService.getExecutionsForSchedule(
                'sched-1', 'acc-1', { limit: 10 }, 'test-tenant'
            );

            expect(mockRepo.getExecutionHistory).toHaveBeenCalledWith('sched-1', 'test-tenant', 10);
            expect(result).toHaveLength(1);
        });

        it('returns [] on error', async () => {
            mockRepo.getExecutionHistory.mockRejectedValue(new Error('DB error'));

            const result = await ScheduleExecutionService.getExecutionsForSchedule('sched-1', 'acc-1');

            expect(result).toEqual([]);
        });
    });

    describe('getExecutionById', () => {
        it('returns matching execution from history', async () => {
            mockRepo.getExecutionHistory.mockResolvedValue([
                makeExecution({ executionId: 'exec-1' }),
                makeExecution({ executionId: 'exec-2' }),
            ]);

            const result = await ScheduleExecutionService.getExecutionById('sched-1', 'exec-2', 'test-tenant');

            expect(result).not.toBeNull();
            expect(result!.executionId).toBe('exec-2');
            expect(mockRepo.getExecutionHistory).toHaveBeenCalledWith('sched-1', 'test-tenant', 200);
        });

        it('returns null when executionId not found', async () => {
            mockRepo.getExecutionHistory.mockResolvedValue([makeExecution({ executionId: 'exec-1' })]);

            const result = await ScheduleExecutionService.getExecutionById('sched-1', 'exec-missing');

            expect(result).toBeNull();
        });

        it('returns null on error', async () => {
            mockRepo.getExecutionHistory.mockRejectedValue(new Error('DB error'));

            const result = await ScheduleExecutionService.getExecutionById('sched-1', 'exec-1');

            expect(result).toBeNull();
        });
    });

    describe('getRecentExecutions', () => {
        it('delegates to repo.getRecentExecutions', async () => {
            mockRepo.getRecentExecutions.mockResolvedValue([makeExecution()]);

            const result = await ScheduleExecutionService.getRecentExecutions({ limit: 5, tenantId: 'test-tenant' });

            expect(mockRepo.getRecentExecutions).toHaveBeenCalledWith('test-tenant', 5);
            expect(result).toHaveLength(1);
        });

        it('filters by status in-memory when options.status provided', async () => {
            mockRepo.getRecentExecutions.mockResolvedValue([
                makeExecution({ executionId: 'exec-1', status: 'success' }),
                makeExecution({ executionId: 'exec-2', status: 'failed' }),
                makeExecution({ executionId: 'exec-3', status: 'success' }),
            ]);

            const result = await ScheduleExecutionService.getRecentExecutions({ status: 'failed' });

            expect(result).toHaveLength(1);
            expect(result[0].executionId).toBe('exec-2');
        });

        it('returns [] on error', async () => {
            mockRepo.getRecentExecutions.mockRejectedValue(new Error('DB error'));

            const result = await ScheduleExecutionService.getRecentExecutions();

            expect(result).toEqual([]);
        });
    });
});
