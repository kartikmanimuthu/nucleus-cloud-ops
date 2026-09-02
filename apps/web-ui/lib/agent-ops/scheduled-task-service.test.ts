import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/repository-factory', () => ({ getScheduledTaskRepository: vi.fn() }));

import { getScheduledTaskRepository } from '@/lib/db/repository-factory';
import {
    createScheduledTask, getScheduledTask, listScheduledTasks, listAllActiveTasks,
    updateScheduledTask, pauseScheduledTask, resumeScheduledTask, deleteScheduledTask,
    updateLastRun, tryAcquireExecutionLock, validateScheduleInput,
    MIN_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES,
} from './scheduled-task-service';

const mockRepo = {
    createScheduledTask: vi.fn(), getScheduledTask: vi.fn(), listScheduledTasks: vi.fn(),
    listAllActiveTasks: vi.fn(), updateScheduledTask: vi.fn(), pauseScheduledTask: vi.fn(),
    resumeScheduledTask: vi.fn(), deleteScheduledTask: vi.fn(), updateLastRun: vi.fn(),
    tryAcquireExecutionLock: vi.fn(),
};

describe('scheduled-task-service delegation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getScheduledTaskRepository).mockReturnValue(mockRepo as any);
    });

    it('createScheduledTask delegates and logs the created taskId', async () => {
        mockRepo.createScheduledTask.mockResolvedValueOnce({ taskId: 't1' });
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const params = { tenantId: 'ten1' } as any;

        const result = await createScheduledTask(params);
        expect(mockRepo.createScheduledTask).toHaveBeenCalledWith(params);
        expect(result).toEqual({ taskId: 't1' });
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('t1'));
    });

    it('getScheduledTask delegates to the repository', async () => {
        mockRepo.getScheduledTask.mockResolvedValueOnce(null);
        expect(await getScheduledTask('ten1', 't1')).toBeNull();
        expect(mockRepo.getScheduledTask).toHaveBeenCalledWith('ten1', 't1');
    });

    it('listScheduledTasks delegates the query object', async () => {
        const query = { tenantId: 'ten1' } as any;
        mockRepo.listScheduledTasks.mockResolvedValueOnce({ tasks: [], total: 0 });
        await listScheduledTasks(query);
        expect(mockRepo.listScheduledTasks).toHaveBeenCalledWith(query);
    });

    it('listAllActiveTasks delegates with no arguments', async () => {
        mockRepo.listAllActiveTasks.mockResolvedValueOnce([]);
        await listAllActiveTasks();
        expect(mockRepo.listAllActiveTasks).toHaveBeenCalledWith();
    });

    it('updateScheduledTask delegates all arguments', async () => {
        const updates = { title: 'new' } as any;
        await updateScheduledTask('ten1', 't1', updates);
        expect(mockRepo.updateScheduledTask).toHaveBeenCalledWith('ten1', 't1', updates);
    });

    it('pauseScheduledTask and resumeScheduledTask delegate to the repository', async () => {
        await pauseScheduledTask('ten1', 't1');
        await resumeScheduledTask('ten1', 't1');
        expect(mockRepo.pauseScheduledTask).toHaveBeenCalledWith('ten1', 't1');
        expect(mockRepo.resumeScheduledTask).toHaveBeenCalledWith('ten1', 't1');
    });

    it('deleteScheduledTask delegates to the repository', async () => {
        await deleteScheduledTask('ten1', 't1');
        expect(mockRepo.deleteScheduledTask).toHaveBeenCalledWith('ten1', 't1');
    });

    it('updateLastRun forwards all args including the optional opts', async () => {
        await updateLastRun('ten1', 't1', 'run1', 'completed', { incrementRunCount: true });
        expect(mockRepo.updateLastRun).toHaveBeenCalledWith('ten1', 't1', 'run1', 'completed', { incrementRunCount: true });
    });

    it('tryAcquireExecutionLock delegates and returns the repo result', async () => {
        mockRepo.tryAcquireExecutionLock.mockResolvedValueOnce(true);
        expect(await tryAcquireExecutionLock('t1', '2026-01-01T00:00:00Z')).toBe(true);
    });
});

describe('validateScheduleInput', () => {
    it('rejects an unrecognized scheduleType', () => {
        expect(validateScheduleInput({ scheduleType: 'weekly' as any })).toContain("must be 'cron' or 'interval'");
    });

    it('defaults to cron when scheduleType is omitted, requiring a cronExpression', () => {
        expect(validateScheduleInput({})).toBe('cronExpression is required for cron schedules');
    });

    it('accepts a valid cron expression', () => {
        expect(validateScheduleInput({ scheduleType: 'cron', cronExpression: '0 * * * *' })).toBeNull();
    });

    it('rejects a blank/whitespace-only cronExpression', () => {
        expect(validateScheduleInput({ scheduleType: 'cron', cronExpression: '   ' })).toContain('cronExpression is required');
    });

    it('accepts an interval within [MIN_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES]', () => {
        expect(validateScheduleInput({ scheduleType: 'interval', intervalMinutes: MIN_INTERVAL_MINUTES })).toBeNull();
        expect(validateScheduleInput({ scheduleType: 'interval', intervalMinutes: MAX_INTERVAL_MINUTES })).toBeNull();
    });

    it('rejects an interval below the minimum or above the maximum', () => {
        expect(validateScheduleInput({ scheduleType: 'interval', intervalMinutes: MIN_INTERVAL_MINUTES - 1 }))
            .toContain('must be an integer between');
        expect(validateScheduleInput({ scheduleType: 'interval', intervalMinutes: MAX_INTERVAL_MINUTES + 1 }))
            .toContain('must be an integer between');
    });

    it('rejects a non-integer or non-numeric interval', () => {
        expect(validateScheduleInput({ scheduleType: 'interval', intervalMinutes: 10.5 })).toContain('must be an integer');
        expect(validateScheduleInput({ scheduleType: 'interval', intervalMinutes: 'abc' })).toContain('must be an integer');
        expect(validateScheduleInput({ scheduleType: 'interval', intervalMinutes: undefined })).toContain('must be an integer');
    });
});
