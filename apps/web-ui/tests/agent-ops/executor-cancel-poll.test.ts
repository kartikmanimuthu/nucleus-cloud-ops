/**
 * Cross-replica cancellation: a pause/delete/cancel handled on a DIFFERENT web-ui
 * replica only flips the run's DB status to 'cancelled'. The executor (which owns
 * the in-process AbortController for the run) must poll that status and stop.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
    mockUpdateRunStatus,
    mockRecordEvent,
    mockGetRun,
    mockMkdir,
    mockRm,
    mockCreateDynamicExecutorGraph,
    mockGetMCPManager,
} = vi.hoisted(() => ({
    mockUpdateRunStatus: vi.fn().mockResolvedValue(undefined),
    mockRecordEvent: vi.fn().mockResolvedValue(undefined),
    mockGetRun: vi.fn().mockResolvedValue(null),
    mockMkdir: vi.fn().mockResolvedValue(undefined),
    mockRm: vi.fn().mockResolvedValue(undefined),
    mockCreateDynamicExecutorGraph: vi.fn(),
    mockGetMCPManager: vi.fn(),
}));

vi.mock('../../lib/agent-ops/agent-ops-service', () => ({
    agentOpsService: {
        updateRunStatus: mockUpdateRunStatus,
        recordEvent: mockRecordEvent,
        getRun: mockGetRun,
    },
}));
vi.mock('../../lib/agent-ops/executor-graphs', () => ({
    createDynamicExecutorGraph: mockCreateDynamicExecutorGraph,
}));
// No LLM provider is configured in the test env; stub resolution so the run
// reaches the event stream (the graph itself is mocked).
vi.mock('@/lib/agent/model-resolver', () => ({
    resolveDefaultModelConfig: vi.fn().mockResolvedValue({ provider: 'test', model: 'test-model' }),
    resolveModelConfig: vi.fn().mockResolvedValue({ provider: 'test', model: 'test-model' }),
}));
vi.mock('fs/promises', () => ({ mkdir: mockMkdir, rm: mockRm }));
vi.mock('@/lib/agent/mcp-manager', () => ({ getMCPManager: mockGetMCPManager }));
vi.mock('@/lib/skill-service', () => ({
    getSkillContent: vi.fn().mockReturnValue(null),
    loadSkills: vi.fn().mockResolvedValue([]),
    loadAllSkillContent: vi.fn().mockResolvedValue(new Map()),
}));

import { executeAgentRun } from '../../lib/agent-ops/agent-executor';

function makeRun(overrides: Record<string, unknown> = {}) {
    return {
        runId: 'run-poll-1',
        tenantId: 'T1',
        source: 'scheduled' as const,
        status: 'queued' as const,
        taskDescription: 'do work',
        mode: 'fast' as const,
        threadId: 'thread-1',
        trigger: { taskId: 'task-1' },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        mcpServerIds: [],
        ...overrides,
    };
}

/** A stream that never ends on its own — forces the executor to rely on the
 *  cancellation poll to break out. Yields a tick event repeatedly. */
async function* endlessStream() {
    // Yield enough events that the throttled poll is guaranteed to fire at least once.
    for (let i = 0; i < 1000; i++) {
        yield { event: 'on_chain_start', name: 'evaluator', metadata: { langgraph_node: 'evaluator' }, data: {} };
    }
}

function makeGraph(stream: AsyncIterable<unknown>) {
    return {
        streamEvents: vi.fn().mockReturnValue(stream),
        getGraph: vi.fn().mockReturnValue({ drawMermaid: vi.fn().mockReturnValue('') }),
        getState: vi.fn().mockResolvedValue({ values: {}, next: [] }),
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    mockGetMCPManager.mockReturnValue({ connectServers: vi.fn().mockResolvedValue(undefined) });
    mockGetRun.mockResolvedValue(null);
});

describe('executor cross-replica cancellation poll', () => {
    it('stops the run and marks it cancelled when the DB status flips to cancelled', async () => {
        mockCreateDynamicExecutorGraph.mockResolvedValue(makeGraph(endlessStream()));
        // Another replica cancelled the run: the DB now reports 'cancelled'.
        mockGetRun.mockResolvedValue({ runId: 'run-poll-1', tenantId: 'T1', status: 'cancelled' });

        await executeAgentRun(makeRun() as never);

        const statuses = mockUpdateRunStatus.mock.calls.map((c: unknown[]) => c[2]);
        expect(statuses).toContain('cancelled');
        expect(statuses).not.toContain('completed');
    });

    it('does not cancel a healthy run whose DB status is still in_progress', async () => {
        // Finite stream so a non-cancelled run completes normally.
        async function* shortStream() {
            yield { event: 'on_chain_start', name: 'evaluator', metadata: { langgraph_node: 'evaluator' }, data: {} };
        }
        mockCreateDynamicExecutorGraph.mockResolvedValue(makeGraph(shortStream()));
        mockGetRun.mockResolvedValue({ runId: 'run-poll-1', tenantId: 'T1', status: 'in_progress' });

        await executeAgentRun(makeRun() as never);

        const statuses = mockUpdateRunStatus.mock.calls.map((c: unknown[]) => c[2]);
        expect(statuses).not.toContain('cancelled');
        expect(statuses).toContain('completed');
    });
});
