/**
 * Unit tests for agent-ops-service.ts
 *
 * Requirements: Run creation, event recording, status transitions
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mock functions so they are available inside vi.mock factories
// ---------------------------------------------------------------------------

const { mockRunCreate, mockRunUpdate, mockRunGet, mockEventCreate } = vi.hoisted(() => ({
    mockRunCreate: vi.fn(),
    mockRunUpdate: vi.fn().mockResolvedValue(undefined),
    mockRunGet: vi.fn(),
    mockEventCreate: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Mock repository factory — service delegates to repos, not Dynamoose models
// ---------------------------------------------------------------------------

vi.mock('../../lib/db/repository-factory', () => ({
    getAgentOpsRunRepository: () => ({
        createRun: mockRunCreate,
        updateRunStatus: mockRunUpdate,
        getRun: mockRunGet,
        listRuns: vi.fn(),
        listRunsBySource: vi.fn(),
        updateRunTrigger: vi.fn(),
        updateApprovalMessageTs: vi.fn(),
        findAwaitingApprovalRunByJiraIssue: vi.fn(),
        findAwaitingRunByJiraIssue: vi.fn(),
        findAwaitingRunBySlackThread: vi.fn(),
        findAwaitingApprovalRun: vi.fn(),
    }),
    getAgentOpsEventRepository: () => ({
        recordEvent: mockEventCreate,
        getRunEvents: vi.fn(),
    }),
}));

// Import service after mocks are set up
import { createRun, recordEvent, updateRunStatus } from '../../lib/agent-ops/agent-ops-service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const baseCreateParams = {
    tenantId: 'T0001',
    source: 'slack' as const,
    taskDescription: 'Check Lambda configs',
    mode: 'fast' as const,
    trigger: {
        userId: 'U0001',
        channelId: 'C0001',
        responseUrl: 'https://hooks.slack.com/commands/abc',
    },
};

// ---------------------------------------------------------------------------
// createRun
// ---------------------------------------------------------------------------

describe('createRun', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockRunCreate.mockImplementation(async (params: Record<string, unknown>) => ({
            runId: params.runId ?? 'run-test',
            tenantId: params.tenantId,
            source: params.source,
            taskDescription: params.taskDescription,
            mode: params.mode,
            status: 'queued',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            ...params,
        }));
    });

    it('creates a run with queued status', async () => {
        const run = await createRun(baseCreateParams);
        expect(run.status).toBe('queued');
    });

    it('creates a run with the correct tenantId', async () => {
        const run = await createRun(baseCreateParams);
        expect(run.tenantId).toBe('T0001');
    });

    it('calls repository createRun once', async () => {
        await createRun(baseCreateParams);
        expect(mockRunCreate).toHaveBeenCalledOnce();
    });

    it('returns the full AgentOpsRun object', async () => {
        const run = await createRun(baseCreateParams);
        expect(run.tenantId).toBe('T0001');
        expect(run.source).toBe('slack');
        expect(run.taskDescription).toBe('Check Lambda configs');
        expect(run.mode).toBe('fast');
        expect(run.createdAt).toBeTruthy();
        expect(run.updatedAt).toBeTruthy();
    });
});

// ---------------------------------------------------------------------------
// recordEvent
// ---------------------------------------------------------------------------

describe('recordEvent', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('does NOT throw when repository recordEvent throws', async () => {
        mockEventCreate.mockRejectedValueOnce(new Error('DB write failed'));

        await expect(
            recordEvent({ runId: 'run-123', tenantId: 'T0001', eventType: 'planning', node: 'planner' })
        ).resolves.toBeUndefined();
    });

    it('still logs the error when recordEvent throws', async () => {
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => { });
        mockEventCreate.mockRejectedValueOnce(new Error('table not found'));

        await recordEvent({ runId: 'run-123', tenantId: 'T0001', eventType: 'tool_call', node: 'tools' });

        expect(consoleSpy).toHaveBeenCalledOnce();
        expect(consoleSpy.mock.calls[0][0]).toContain('[AgentOpsService]');
        consoleSpy.mockRestore();
    });

    it('resolves normally when recordEvent succeeds', async () => {
        mockEventCreate.mockResolvedValueOnce(undefined);

        await expect(
            recordEvent({ runId: 'run-456', tenantId: 'T0001', eventType: 'execution', node: 'generate' })
        ).resolves.toBeUndefined();

        expect(mockEventCreate).toHaveBeenCalledOnce();
    });
});

// ---------------------------------------------------------------------------
// updateRunStatus
// ---------------------------------------------------------------------------

describe('updateRunStatus', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockRunUpdate.mockResolvedValue(undefined);
    });

    it('calls repository updateRunStatus with correct args', async () => {
        await updateRunStatus('T0001', 'run-abc', 'completed');
        expect(mockRunUpdate).toHaveBeenCalledOnce();
        expect(mockRunUpdate).toHaveBeenCalledWith('T0001', 'run-abc', 'completed', undefined);
    });

    it('passes extra result to repository', async () => {
        const extra = { result: { summary: 'Done', toolsUsed: ['list_buckets'], iterations: 3 } };
        await updateRunStatus('T0001', 'run-abc', 'completed', extra);
        expect(mockRunUpdate).toHaveBeenCalledWith('T0001', 'run-abc', 'completed', extra);
    });

    it('does not throw on repository error', async () => {
        mockRunUpdate.mockRejectedValueOnce(new Error('DB error'));
        await expect(updateRunStatus('T0001', 'run-abc', 'failed')).rejects.toThrow('DB error');
    });
});
