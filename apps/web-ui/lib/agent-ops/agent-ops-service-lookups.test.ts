import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/repository-factory', () => ({
    getAgentOpsRunRepository: vi.fn(),
    getAgentOpsEventRepository: vi.fn(),
}));
vi.mock('@/lib/agent-ops/run-manager', () => ({ cancelRun: vi.fn() }));

import { getAgentOpsRunRepository, getAgentOpsEventRepository } from '@/lib/db/repository-factory';
import { cancelRun } from '@/lib/agent-ops/run-manager';
import {
    getRun, listRuns, listRunsBySource, updateRunTrigger, getRunEvents,
    findAwaitingApprovalRunByJiraIssue, findAwaitingRunByJiraIssue, findAwaitingRunBySlackThread,
    findResumableTelegramRun, closeTelegramSession, updateApprovalMessageTs, findAwaitingApprovalRun,
    cancelActiveRunsForTask,
} from './agent-ops-service';

const mockRunRepo = {
    getRun: vi.fn(), listRuns: vi.fn(), listRunsBySource: vi.fn(), updateRunTrigger: vi.fn(),
    updateRunStatus: vi.fn(), findAwaitingApprovalRunByJiraIssue: vi.fn(), findAwaitingRunByJiraIssue: vi.fn(),
    findAwaitingRunBySlackThread: vi.fn(), findResumableTelegramRun: vi.fn(), updateApprovalMessageTs: vi.fn(),
    findAwaitingApprovalRun: vi.fn(), listActiveRunsByTask: vi.fn(),
};
const mockEventRepo = { recordEvent: vi.fn(), getRunEvents: vi.fn() };

describe('agent-ops-service — lookup/pass-through helpers', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getAgentOpsRunRepository).mockReturnValue(mockRunRepo as any);
        vi.mocked(getAgentOpsEventRepository).mockReturnValue(mockEventRepo as any);
    });

    it('getRun delegates to the repository', async () => {
        mockRunRepo.getRun.mockResolvedValueOnce(null);
        expect(await getRun('t1', 'r1')).toBeNull();
        expect(mockRunRepo.getRun).toHaveBeenCalledWith('t1', 'r1');
    });

    it('listRuns forwards the query object', async () => {
        const query = { tenantId: 't1' } as any;
        mockRunRepo.listRuns.mockResolvedValueOnce({ runs: [], total: 0 });
        await listRuns(query);
        expect(mockRunRepo.listRuns).toHaveBeenCalledWith(query);
    });

    it('listRunsBySource forwards source and limit, defaulting limit to 25', async () => {
        mockRunRepo.listRunsBySource.mockResolvedValueOnce([]);
        await listRunsBySource('slack');
        expect(mockRunRepo.listRunsBySource).toHaveBeenCalledWith('slack', 25);

        await listRunsBySource('jira', 10);
        expect(mockRunRepo.listRunsBySource).toHaveBeenCalledWith('jira', 10);
    });

    it('updateRunTrigger delegates and logs', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        await updateRunTrigger('t1', 'r1', { userId: 'u1' } as any);
        expect(mockRunRepo.updateRunTrigger).toHaveBeenCalledWith('t1', 'r1', { userId: 'u1' });
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('r1'));
    });

    it('getRunEvents delegates to the event repository', async () => {
        mockEventRepo.getRunEvents.mockResolvedValueOnce([]);
        await getRunEvents('r1', 't1');
        expect(mockEventRepo.getRunEvents).toHaveBeenCalledWith('r1', 't1');
    });

    it('findAwaitingApprovalRunByJiraIssue delegates to the repository', async () => {
        mockRunRepo.findAwaitingApprovalRunByJiraIssue.mockResolvedValueOnce(null);
        await findAwaitingApprovalRunByJiraIssue('ISSUE-1');
        expect(mockRunRepo.findAwaitingApprovalRunByJiraIssue).toHaveBeenCalledWith('ISSUE-1');
    });

    it('findAwaitingRunByJiraIssue delegates to the repository', async () => {
        await findAwaitingRunByJiraIssue('ISSUE-1');
        expect(mockRunRepo.findAwaitingRunByJiraIssue).toHaveBeenCalledWith('ISSUE-1');
    });

    it('findAwaitingRunBySlackThread delegates channelId and threadTs', async () => {
        await findAwaitingRunBySlackThread('C1', '1234.5678');
        expect(mockRunRepo.findAwaitingRunBySlackThread).toHaveBeenCalledWith('C1', '1234.5678');
    });

    it('findResumableTelegramRun delegates chatId and idleCutoff', async () => {
        const cutoff = new Date('2026-01-01T00:00:00Z');
        await findResumableTelegramRun(123, cutoff);
        expect(mockRunRepo.findResumableTelegramRun).toHaveBeenCalledWith(123, cutoff);
    });

    it('closeTelegramSession cancels the run via updateRunStatus', async () => {
        await closeTelegramSession('t1', 'r1');
        expect(mockRunRepo.updateRunStatus).toHaveBeenCalledWith('t1', 'r1', 'cancelled', undefined);
    });

    it('updateApprovalMessageTs delegates to the repository', async () => {
        await updateApprovalMessageTs('t1', 'r1', '1700000000.000100');
        expect(mockRunRepo.updateApprovalMessageTs).toHaveBeenCalledWith('t1', 'r1', '1700000000.000100');
    });

    it('findAwaitingApprovalRun delegates to a cross-tenant lookup by runId', async () => {
        await findAwaitingApprovalRun('r1');
        expect(mockRunRepo.findAwaitingApprovalRun).toHaveBeenCalledWith('r1');
    });

    describe('cancelActiveRunsForTask', () => {
        it('aborts, cancels, and records an event for every active run, returning the cancelled ids', async () => {
            mockRunRepo.listActiveRunsByTask.mockResolvedValueOnce([{ runId: 'r1' }, { runId: 'r2' }]);
            const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

            const result = await cancelActiveRunsForTask('t1', 'task1');

            expect(cancelRun).toHaveBeenCalledWith('r1');
            expect(cancelRun).toHaveBeenCalledWith('r2');
            expect(mockRunRepo.updateRunStatus).toHaveBeenCalledWith('t1', 'r1', 'cancelled');
            expect(mockEventRepo.recordEvent).toHaveBeenCalledWith(expect.objectContaining({
                runId: 'r1', node: '__cancelled__', metadata: { reason: 'task_paused_or_deleted', taskId: 'task1' },
            }));
            expect(result).toEqual(['r1', 'r2']);
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('2'));
        });

        it('returns an empty array and does not log a summary when there are no active runs', async () => {
            mockRunRepo.listActiveRunsByTask.mockResolvedValueOnce([]);
            const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
            expect(await cancelActiveRunsForTask('t1', 'task1')).toEqual([]);
            expect(logSpy).not.toHaveBeenCalled();
        });

        it('continues cancelling remaining runs and excludes one that failed', async () => {
            mockRunRepo.listActiveRunsByTask.mockResolvedValueOnce([{ runId: 'r1' }, { runId: 'r2' }]);
            mockRunRepo.updateRunStatus.mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce(undefined);
            const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

            const result = await cancelActiveRunsForTask('t1', 'task1');

            expect(result).toEqual(['r2']);
            expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('r1'), expect.any(Error));
        });
    });
});
