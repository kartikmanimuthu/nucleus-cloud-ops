import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
    mockListActiveRunsByTask,
    mockUpdateRunStatus,
    mockRecordEvent,
    mockCancelRun,
} = vi.hoisted(() => ({
    mockListActiveRunsByTask: vi.fn(),
    mockUpdateRunStatus: vi.fn(),
    mockRecordEvent: vi.fn(),
    mockCancelRun: vi.fn(),
}));

vi.mock('@/lib/db/repository-factory', () => ({
    getAgentOpsRunRepository: () => ({
        listActiveRunsByTask: mockListActiveRunsByTask,
        updateRunStatus: mockUpdateRunStatus,
    }),
    getAgentOpsEventRepository: () => ({
        recordEvent: mockRecordEvent,
    }),
}));
vi.mock('@/lib/agent-ops/run-manager', () => ({
    cancelRun: mockCancelRun,
}));

import { cancelActiveRunsForTask } from '../../lib/agent-ops/agent-ops-service';

beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateRunStatus.mockResolvedValue(undefined);
    mockRecordEvent.mockResolvedValue(undefined);
});

describe('cancelActiveRunsForTask', () => {
    it('cancels every non-terminal run for the task and returns their ids', async () => {
        mockListActiveRunsByTask.mockResolvedValue([
            { runId: 'run-a', tenantId: 'ten-1', status: 'in_progress' },
            { runId: 'run-b', tenantId: 'ten-1', status: 'queued' },
        ]);

        const cancelled = await cancelActiveRunsForTask('ten-1', 'task-1');

        expect(cancelled).toEqual(['run-a', 'run-b']);
        // In-process abort signalled for each (stops execution on this replica).
        expect(mockCancelRun).toHaveBeenCalledWith('run-a');
        expect(mockCancelRun).toHaveBeenCalledWith('run-b');
        // DB flipped to cancelled for each (cross-replica signal + UI truth).
        expect(mockUpdateRunStatus).toHaveBeenCalledWith('ten-1', 'run-a', 'cancelled');
        expect(mockUpdateRunStatus).toHaveBeenCalledWith('ten-1', 'run-b', 'cancelled');
    });

    it('is a no-op when the task has no active runs', async () => {
        mockListActiveRunsByTask.mockResolvedValue([]);

        const cancelled = await cancelActiveRunsForTask('ten-1', 'task-1');

        expect(cancelled).toEqual([]);
        expect(mockCancelRun).not.toHaveBeenCalled();
        expect(mockUpdateRunStatus).not.toHaveBeenCalled();
    });

    it('continues cancelling remaining runs if one cancellation throws', async () => {
        mockListActiveRunsByTask.mockResolvedValue([
            { runId: 'run-a', tenantId: 'ten-1', status: 'in_progress' },
            { runId: 'run-b', tenantId: 'ten-1', status: 'queued' },
        ]);
        mockUpdateRunStatus.mockRejectedValueOnce(new Error('db blip'));

        const cancelled = await cancelActiveRunsForTask('ten-1', 'task-1');

        // run-a failed to persist, run-b still cancelled.
        expect(cancelled).toEqual(['run-b']);
        expect(mockUpdateRunStatus).toHaveBeenCalledWith('ten-1', 'run-b', 'cancelled');
    });
});
