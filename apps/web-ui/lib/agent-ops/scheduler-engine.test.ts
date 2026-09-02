import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../boss-client', () => ({ getBoss: vi.fn() }));

import { getBoss } from '../boss-client';
import { initializeScheduler, registerTask, unregisterTask, shutdownScheduler } from './scheduler-engine';

const mockBoss = {
    unschedule: vi.fn(),
    createQueue: vi.fn(),
    schedule: vi.fn(),
};

const CRON_TASK = {
    taskId: 't1', tenantId: 'ten1', scheduleType: 'cron',
    cronExpression: '0 * * * *', timezone: 'UTC',
} as any;

describe('scheduler-engine', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getBoss).mockResolvedValue(mockBoss as any);
        mockBoss.unschedule.mockResolvedValue(undefined);
        mockBoss.createQueue.mockResolvedValue(undefined);
        mockBoss.schedule.mockResolvedValue(undefined);
    });

    it('initializeScheduler is a documented no-op', async () => {
        await expect(initializeScheduler()).resolves.toBeUndefined();
        expect(getBoss).not.toHaveBeenCalled();
    });

    it('shutdownScheduler is a documented no-op', () => {
        expect(() => shutdownScheduler()).not.toThrow();
    });

    it('registerTask creates the queue and schedules a cron task', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        await registerTask(CRON_TASK);

        expect(mockBoss.createQueue).toHaveBeenCalledWith('agent-ops-task:t1');
        expect(mockBoss.unschedule).toHaveBeenCalledWith('agent-ops-task:t1');
        expect(mockBoss.schedule).toHaveBeenCalledWith(
            'agent-ops-task:t1', '0 * * * *',
            { taskId: 't1', tenantId: 'ten1' },
            { tz: 'UTC' },
        );
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('t1'));
    });

    it('registerTask tolerates unschedule failing when no prior schedule exists', async () => {
        mockBoss.unschedule.mockRejectedValueOnce(new Error('not found'));
        await expect(registerTask(CRON_TASK)).resolves.toBeUndefined();
        expect(mockBoss.schedule).toHaveBeenCalled();
    });

    it('registerTask drops any stale pg-boss schedule and skips registration for interval tasks', async () => {
        await registerTask({ ...CRON_TASK, scheduleType: 'interval' });

        expect(mockBoss.unschedule).toHaveBeenCalledWith('agent-ops-task:t1');
        expect(mockBoss.createQueue).not.toHaveBeenCalled();
        expect(mockBoss.schedule).not.toHaveBeenCalled();
    });

    it('registerTask for an interval task tolerates a missing prior schedule', async () => {
        mockBoss.unschedule.mockRejectedValueOnce(new Error('not found'));
        await expect(registerTask({ ...CRON_TASK, scheduleType: 'interval' })).resolves.toBeUndefined();
    });

    it('unregisterTask unschedules the task queue and logs success', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        await unregisterTask('t1');

        expect(mockBoss.unschedule).toHaveBeenCalledWith('agent-ops-task:t1');
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('t1'));
    });

    it('unregisterTask silently ignores a missing queue/schedule', async () => {
        mockBoss.unschedule.mockRejectedValueOnce(new Error('not found'));
        await expect(unregisterTask('missing')).resolves.toBeUndefined();
    });
});
