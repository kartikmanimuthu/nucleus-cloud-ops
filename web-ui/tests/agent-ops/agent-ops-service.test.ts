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
    mockRunCreate: vi.fn().mockResolvedValue(undefined),
    mockRunUpdate: vi.fn().mockResolvedValue(undefined),
    mockRunGet: vi.fn(),
    mockEventCreate: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Mock Dynamoose models before importing the service
// ---------------------------------------------------------------------------

vi.mock('../../lib/agent-ops/models/agent-ops-run', () => ({
    AgentOpsRunModel: {
        create: mockRunCreate,
        update: mockRunUpdate,
        get: mockRunGet,
    },
}));

vi.mock('../../lib/agent-ops/models/agent-ops-event', () => ({
    AgentOpsEventModel: {
        create: mockEventCreate,
    },
}));

// Mock dynamoose-config to avoid real AWS SDK initialization
vi.mock('../../lib/agent-ops/dynamoose-config', () => ({
    default: {},
    AGENT_OPS_TABLE_NAME: 'AgentOpsTable-test',
    TTL_30_DAYS: () => Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
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
    });

    it('sets PK = TENANT#<tenantId>', async () => {
        const run = await createRun(baseCreateParams);
        expect(run.PK).toBe('TENANT#T0001');
    });

    it('sets SK = RUN#<runId> where runId is a UUID v4', async () => {
        const run = await createRun(baseCreateParams);
        expect(run.SK).toMatch(/^RUN#/);
        const runId = run.SK.replace('RUN#', '');
        expect(runId).toMatch(UUID_V4_REGEX);
    });

    it('sets threadId = agent-ops-<runId>', async () => {
        const run = await createRun(baseCreateParams);
        expect(run.threadId).toBe(`agent-ops-${run.runId}`);
    });

    it('sets GSI1PK = SOURCE#slack', async () => {
        const run = await createRun(baseCreateParams);
        expect(run.GSI1PK).toBe('SOURCE#slack');
    });

    it('sets status = queued', async () => {
        const run = await createRun(baseCreateParams);
        expect(run.status).toBe('queued');
    });

    it('sets ttl to a Unix epoch ~30 days in the future', async () => {
        const before = Math.floor(Date.now() / 1000);
        const run = await createRun(baseCreateParams);
        const after = Math.floor(Date.now() / 1000);

        const thirtyDays = 30 * 24 * 60 * 60;
        expect(run.ttl).toBeGreaterThanOrEqual(before + thirtyDays - 1);
        expect(run.ttl).toBeLessThanOrEqual(after + thirtyDays + 1);
    });

    it('calls AgentOpsRunModel.create with the run object', async () => {
        const run = await createRun(baseCreateParams);
        expect(mockRunCreate).toHaveBeenCalledOnce();
        expect(mockRunCreate).toHaveBeenCalledWith(expect.objectContaining({ PK: run.PK, SK: run.SK }));
    });

    it('returns the full AgentOpsRun object', async () => {
        const run = await createRun(baseCreateParams);
        expect(run.runId).toMatch(UUID_V4_REGEX);
        expect(run.tenantId).toBe('T0001');
        expect(run.source).toBe('slack');
        expect(run.taskDescription).toBe('Check Lambda configs');
        expect(run.mode).toBe('fast');
        expect(run.createdAt).toBeTruthy();
        expect(run.updatedAt).toBeTruthy();
    });

    it('each call produces a unique runId', async () => {
        const run1 = await createRun(baseCreateParams);
        const run2 = await createRun(baseCreateParams);
        expect(run1.runId).not.toBe(run2.runId);
    });
});

// ---------------------------------------------------------------------------
// recordEvent
// ---------------------------------------------------------------------------

describe('recordEvent', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('does NOT throw when AgentOpsEventModel.create throws', async () => {
        mockEventCreate.mockRejectedValueOnce(new Error('DynamoDB write failed'));

        await expect(
            recordEvent({ runId: 'run-123', eventType: 'planning', node: 'planner' })
        ).resolves.toBeUndefined();
    });

    it('still logs the error when create throws', async () => {
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => { });
        mockEventCreate.mockRejectedValueOnce(new Error('table not found'));

        await recordEvent({ runId: 'run-123', eventType: 'tool_call', node: 'tools' });

        expect(consoleSpy).toHaveBeenCalledOnce();
        expect(consoleSpy.mock.calls[0][0]).toContain('[AgentOpsService]');
        consoleSpy.mockRestore();
    });

    it('resolves normally when create succeeds', async () => {
        mockEventCreate.mockResolvedValueOnce(undefined);

        await expect(
            recordEvent({ runId: 'run-456', eventType: 'execution', node: 'generate' })
        ).resolves.toBeUndefined();

        expect(mockEventCreate).toHaveBeenCalledOnce();
    });

    it('caps content at 10000 characters', async () => {
        const longContent = 'x'.repeat(20000);
        await recordEvent({ runId: 'run-789', eventType: 'execution', node: 'generate', content: longContent });

        const eventItem = mockEventCreate.mock.calls[0][0];
        expect(eventItem.content).toHaveLength(10000);
    });

    it('caps toolOutput at 10000 characters', async () => {
        const longOutput = 'y'.repeat(15000);
        await recordEvent({ runId: 'run-789', eventType: 'tool_result', node: 'tools', toolOutput: longOutput });

        const eventItem = mockEventCreate.mock.calls[0][0];
        expect(eventItem.toolOutput).toHaveLength(10000);
    });

    it('does not truncate content under 10000 characters', async () => {
        const shortContent = 'hello world';
        await recordEvent({ runId: 'run-789', eventType: 'final', node: 'final', content: shortContent });

        const eventItem = mockEventCreate.mock.calls[0][0];
        expect(eventItem.content).toBe('hello world');
    });
});

// ---------------------------------------------------------------------------
// updateRunStatus
// ---------------------------------------------------------------------------

describe('updateRunStatus', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Default: getRun returns a run with a known createdAt
        mockRunGet.mockResolvedValue({
            createdAt: new Date(Date.now() - 5000).toISOString(),
        });
    });

    it('sets completedAt when status is "completed"', async () => {
        await updateRunStatus('T0001', 'run-abc', 'completed');

        expect(mockRunUpdate).toHaveBeenCalledOnce();
        const [, updateData] = mockRunUpdate.mock.calls[0];
        expect(updateData.completedAt).toBeTruthy();
        expect(typeof updateData.completedAt).toBe('string');
    });

    it('sets completedAt when status is "failed"', async () => {
        await updateRunStatus('T0001', 'run-abc', 'failed');

        expect(mockRunUpdate).toHaveBeenCalledOnce();
        const [, updateData] = mockRunUpdate.mock.calls[0];
        expect(updateData.completedAt).toBeTruthy();
    });

    it('does NOT set completedAt when status is "in_progress"', async () => {
        await updateRunStatus('T0001', 'run-abc', 'in_progress');

        const [, updateData] = mockRunUpdate.mock.calls[0];
        expect(updateData.completedAt).toBeUndefined();
    });

    it('does NOT set completedAt when status is "queued"', async () => {
        await updateRunStatus('T0001', 'run-abc', 'queued');

        const [, updateData] = mockRunUpdate.mock.calls[0];
        expect(updateData.completedAt).toBeUndefined();
    });

    it('sets durationMs on terminal states when createdAt is available', async () => {
        await updateRunStatus('T0001', 'run-abc', 'completed');

        const [, updateData] = mockRunUpdate.mock.calls[0];
        expect(typeof updateData.durationMs).toBe('number');
        expect(updateData.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('always sets status and updatedAt', async () => {
        await updateRunStatus('T0001', 'run-abc', 'in_progress');

        const [, updateData] = mockRunUpdate.mock.calls[0];
        expect(updateData.status).toBe('in_progress');
        expect(updateData.updatedAt).toBeTruthy();
    });

    it('passes result extras to the update when provided', async () => {
        await updateRunStatus('T0001', 'run-abc', 'completed', {
            result: { summary: 'Done', toolsUsed: ['list_buckets'], iterations: 3 },
        });

        const [, updateData] = mockRunUpdate.mock.calls[0];
        expect(updateData.result).toEqual({ summary: 'Done', toolsUsed: ['list_buckets'], iterations: 3 });
    });
});
