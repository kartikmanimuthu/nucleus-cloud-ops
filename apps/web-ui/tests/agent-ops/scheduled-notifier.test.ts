import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ScheduledTask, AgentOpsRun } from '@/lib/agent-ops/types';

const { sendScheduledNotification, registryHas, registryGet, mockGetScheduledTask, mockUpdateLastRun } = vi.hoisted(() => ({
    sendScheduledNotification: vi.fn(),
    registryHas: vi.fn(),
    registryGet: vi.fn(),
    mockGetScheduledTask: vi.fn(),
    mockUpdateLastRun: vi.fn(),
}));

vi.mock('@/lib/gateway', () => ({
    getAdapterRegistry: () => ({ has: registryHas, get: registryGet }),
}));

vi.mock('@/lib/agent-ops/scheduled-task-service', () => ({
    getScheduledTask: mockGetScheduledTask,
    updateLastRun: mockUpdateLastRun,
}));

import {
    mapRunStatusToOutcome,
    notifyScheduledRunResult,
    finalizeScheduledRun,
} from '@/lib/agent-ops/scheduled-notifier';

function makeTask(over: Record<string, unknown> = {}): ScheduledTask {
    return {
        taskId: 'task-1',
        tenantId: 'tenant-1',
        name: 'Daily Review',
        description: 'check costs',
        notification: { type: 'slack', channelId: 'C1' },
        ...over,
    } as unknown as ScheduledTask;
}

function makeRun(over: Record<string, unknown> = {}): AgentOpsRun {
    return {
        runId: 'run-1',
        tenantId: 'tenant-1',
        source: 'scheduled',
        status: 'completed',
        taskDescription: 'check costs',
        trigger: { taskId: 'task-1', taskName: 'Daily Review', scheduledAt: '2026-07-05T00:00:00Z' },
        result: { summary: 'All good', toolsUsed: ['execute_command'], iterations: 1 },
        ...over,
    } as unknown as AgentOpsRun;
}

beforeEach(() => {
    vi.clearAllMocks();
    registryHas.mockReturnValue(true);
    registryGet.mockReturnValue({ sendScheduledNotification });
    mockGetScheduledTask.mockResolvedValue(makeTask());
    mockUpdateLastRun.mockResolvedValue(undefined);
    sendScheduledNotification.mockResolvedValue(undefined);
});

describe('mapRunStatusToOutcome', () => {
    it('maps completed → result', () => expect(mapRunStatusToOutcome('completed')).toBe('result'));
    it('maps failed → failure', () => expect(mapRunStatusToOutcome('failed')).toBe('failure'));
    it('maps cancelled → failure', () => expect(mapRunStatusToOutcome('cancelled')).toBe('failure'));
    it('maps awaiting_input → attention', () => expect(mapRunStatusToOutcome('awaiting_input')).toBe('attention'));
    it('maps awaiting_approval → attention', () => expect(mapRunStatusToOutcome('awaiting_approval')).toBe('attention'));
    it('maps queued / in_progress → null', () => {
        expect(mapRunStatusToOutcome('queued')).toBeNull();
        expect(mapRunStatusToOutcome('in_progress')).toBeNull();
    });
});

describe('notifyScheduledRunResult', () => {
    it('dispatches to the adapter named by notification.type with the mapped outcome', async () => {
        await notifyScheduledRunResult(makeTask(), makeRun());
        expect(registryGet).toHaveBeenCalledWith('slack');
        expect(sendScheduledNotification).toHaveBeenCalledTimes(1);
        const [taskArg, runArg, outcomeArg] = sendScheduledNotification.mock.calls[0];
        expect(taskArg.taskId).toBe('task-1');
        expect(runArg.runId).toBe('run-1');
        expect(outcomeArg).toBe('result');
    });

    it('sends failure outcome for a failed run', async () => {
        await notifyScheduledRunResult(makeTask(), makeRun({ status: 'failed', error: 'boom' }));
        expect(sendScheduledNotification.mock.calls[0][2]).toBe('failure');
    });

    it('sends attention outcome for an awaiting_approval run', async () => {
        await notifyScheduledRunResult(makeTask(), makeRun({ status: 'awaiting_approval' }));
        expect(sendScheduledNotification.mock.calls[0][2]).toBe('attention');
    });

    it('skips when notification.type is none', async () => {
        await notifyScheduledRunResult(makeTask({ notification: { type: 'none' } }), makeRun());
        expect(sendScheduledNotification).not.toHaveBeenCalled();
    });

    it('skips when no adapter is registered for the type', async () => {
        registryHas.mockReturnValue(false);
        await notifyScheduledRunResult(makeTask(), makeRun());
        expect(sendScheduledNotification).not.toHaveBeenCalled();
    });

    it('skips when the adapter has no sendScheduledNotification (e.g. jira in v1)', async () => {
        registryGet.mockReturnValue({});
        await expect(notifyScheduledRunResult(makeTask({ notification: { type: 'jira', issueKey: 'OPS-1' } }), makeRun()))
            .resolves.toBeUndefined();
    });

    it('skips when run status maps to no outcome', async () => {
        await notifyScheduledRunResult(makeTask(), makeRun({ status: 'in_progress' }));
        expect(sendScheduledNotification).not.toHaveBeenCalled();
    });

    it('never throws when the adapter throws', async () => {
        sendScheduledNotification.mockRejectedValue(new Error('slack down'));
        await expect(notifyScheduledRunResult(makeTask(), makeRun())).resolves.toBeUndefined();
    });
});

describe('finalizeScheduledRun', () => {
    it('no-ops for non-scheduled runs', async () => {
        await finalizeScheduledRun(makeRun({ source: 'slack' }));
        expect(mockGetScheduledTask).not.toHaveBeenCalled();
        expect(mockUpdateLastRun).not.toHaveBeenCalled();
    });

    it('no-ops when trigger has no taskId', async () => {
        await finalizeScheduledRun(makeRun({ trigger: {} }));
        expect(mockGetScheduledTask).not.toHaveBeenCalled();
    });

    it('updates lastRun and delivers the digest for a scheduled run', async () => {
        await finalizeScheduledRun(makeRun());
        expect(mockGetScheduledTask).toHaveBeenCalledWith('tenant-1', 'task-1');
        expect(mockUpdateLastRun).toHaveBeenCalledWith('tenant-1', 'task-1', 'run-1', 'completed');
        expect(sendScheduledNotification).toHaveBeenCalledTimes(1);
    });

    it('no-ops delivery when the task no longer exists', async () => {
        mockGetScheduledTask.mockResolvedValue(null);
        await finalizeScheduledRun(makeRun());
        expect(mockUpdateLastRun).not.toHaveBeenCalled();
        expect(sendScheduledNotification).not.toHaveBeenCalled();
    });

    it('never throws when updateLastRun rejects', async () => {
        mockUpdateLastRun.mockRejectedValue(new Error('db down'));
        await expect(finalizeScheduledRun(makeRun())).resolves.toBeUndefined();
    });
});
