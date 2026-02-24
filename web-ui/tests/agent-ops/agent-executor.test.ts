/**
 * Unit tests for agent-executor.ts
 *
 * Requirements: Agent execution lifecycle
 *
 * Covers:
 * - Status transitions: queued → in_progress → completed
 * - Status transitions: queued → in_progress → failed
 * - Sandbox directory is always cleaned up (even on error)
 * - toolsUsed grows monotonically and never shrinks
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mock functions so they are available inside vi.mock factories
// ---------------------------------------------------------------------------

const {
    mockUpdateRunStatus,
    mockRecordEvent,
    mockAgentOpsRunModelUpdate,
    mockMkdir,
    mockRm,
    mockCreateDynamicExecutorGraph,
    mockGetMCPManager,
    mockGetSkillContent,
    mockLoadSkills,
} = vi.hoisted(() => ({
    mockUpdateRunStatus: vi.fn().mockResolvedValue(undefined),
    mockRecordEvent: vi.fn().mockResolvedValue(undefined),
    mockAgentOpsRunModelUpdate: vi.fn().mockResolvedValue(undefined),
    mockMkdir: vi.fn().mockResolvedValue(undefined),
    mockRm: vi.fn().mockResolvedValue(undefined),
    mockCreateDynamicExecutorGraph: vi.fn(),
    mockGetMCPManager: vi.fn(),
    mockGetSkillContent: vi.fn().mockReturnValue(null),
    mockLoadSkills: vi.fn().mockResolvedValue([]),
}));

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../lib/agent-ops/agent-ops-service', () => ({
    agentOpsService: {
        updateRunStatus: mockUpdateRunStatus,
        recordEvent: mockRecordEvent,
    },
}));

vi.mock('../../lib/agent-ops/executor-graphs', () => ({
    createDynamicExecutorGraph: mockCreateDynamicExecutorGraph,
}));

vi.mock('../../lib/agent-ops/models/agent-ops-run', () => ({
    AgentOpsRunModel: {
        update: mockAgentOpsRunModelUpdate,
    },
}));

vi.mock('../../lib/agent-ops/dynamoose-config', () => ({
    default: {},
    AGENT_OPS_TABLE_NAME: 'AgentOpsTable-test',
    TTL_30_DAYS: () => Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
}));

vi.mock('fs/promises', () => ({
    mkdir: mockMkdir,
    rm: mockRm,
}));

vi.mock('@/lib/agent/mcp-manager', () => ({
    getMCPManager: mockGetMCPManager,
}));

vi.mock('@/lib/agent/skills/skill-loader', () => ({
    getSkillContent: mockGetSkillContent,
    loadSkills: mockLoadSkills,
}));

// Import after mocks
import { executeAgentRun } from '../../lib/agent-ops/agent-executor';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal AgentOpsRun-like object for testing */
function makeRun(overrides: Record<string, unknown> = {}) {
    return {
        PK: 'TENANT#T0001',
        SK: 'RUN#run-test-123',
        GSI1PK: 'SOURCE#slack',
        GSI1SK: '2024-01-01T00:00:00.000Z#run-test-123',
        runId: 'run-test-123',
        tenantId: 'T0001',
        source: 'slack' as const,
        status: 'queued' as const,
        taskDescription: 'Check Lambda configs',
        mode: 'fast' as const,
        threadId: 'agent-ops-run-test-123',
        trigger: {
            userId: 'U0001',
            channelId: 'C0001',
            responseUrl: 'https://hooks.slack.com/commands/abc',
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ttl: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
        // Extra fields accessed via `run as any`
        mcpServerIds: [],
        workspaceId: undefined,
        ...overrides,
    };
}

/** Build a fake MCP manager */
function makeMCPManager() {
    return {
        connectServers: vi.fn().mockResolvedValue(undefined),
    };
}

/** Create an async generator that yields the given events */
async function* makeEventStream(events: unknown[]) {
    for (const event of events) {
        yield event;
    }
}

/** Build a fake graph whose streamEvents yields the given events */
function makeFakeGraph(events: unknown[] = []) {
    return {
        streamEvents: vi.fn().mockReturnValue(makeEventStream(events)),
        getGraph: vi.fn().mockReturnValue({ drawMermaid: vi.fn().mockReturnValue('') }),
    };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
    vi.clearAllMocks();
    mockGetMCPManager.mockReturnValue(makeMCPManager());
});

// ---------------------------------------------------------------------------
// 1. Success path: queued → in_progress → completed
// ---------------------------------------------------------------------------

describe('success path: queued → in_progress → completed', () => {
    it('calls updateRunStatus with in_progress before completed', async () => {
        const graph = makeFakeGraph([]);
        mockCreateDynamicExecutorGraph.mockResolvedValue(graph);

        await executeAgentRun(makeRun());

        const calls = mockUpdateRunStatus.mock.calls;
        const statuses = calls.map((c: unknown[]) => c[2]);
        expect(statuses).toContain('in_progress');
        expect(statuses).toContain('completed');

        // in_progress must come before completed
        const inProgressIdx = statuses.indexOf('in_progress');
        const completedIdx = statuses.indexOf('completed');
        expect(inProgressIdx).toBeLessThan(completedIdx);
    });

    it('calls updateRunStatus("completed") with result.summary, result.toolsUsed, result.iterations', async () => {
        const graph = makeFakeGraph([]);
        mockCreateDynamicExecutorGraph.mockResolvedValue(graph);

        await executeAgentRun(makeRun());

        const completedCall = mockUpdateRunStatus.mock.calls.find(
            (c: unknown[]) => c[2] === 'completed'
        );
        expect(completedCall).toBeDefined();

        const extra = completedCall![3];
        expect(extra).toBeDefined();
        expect(extra.result).toBeDefined();
        expect(typeof extra.result.summary).toBe('string');
        expect(Array.isArray(extra.result.toolsUsed)).toBe(true);
        expect(typeof extra.result.iterations).toBe('number');
    });

    it('never calls updateRunStatus("failed") on success', async () => {
        const graph = makeFakeGraph([]);
        mockCreateDynamicExecutorGraph.mockResolvedValue(graph);

        await executeAgentRun(makeRun());

        const failedCall = mockUpdateRunStatus.mock.calls.find(
            (c: unknown[]) => c[2] === 'failed'
        );
        expect(failedCall).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// 2. Failure path: queued → in_progress → failed
// ---------------------------------------------------------------------------

describe('failure path: queued → in_progress → failed', () => {
    it('calls updateRunStatus with in_progress before failed when graph throws', async () => {
        mockCreateDynamicExecutorGraph.mockRejectedValue(new Error('Graph init failed'));

        await executeAgentRun(makeRun());

        const calls = mockUpdateRunStatus.mock.calls;
        const statuses = calls.map((c: unknown[]) => c[2]);
        expect(statuses).toContain('in_progress');
        expect(statuses).toContain('failed');

        const inProgressIdx = statuses.indexOf('in_progress');
        const failedIdx = statuses.indexOf('failed');
        expect(inProgressIdx).toBeLessThan(failedIdx);
    });

    it('calls recordEvent with eventType "error" and node "executor" on failure', async () => {
        mockCreateDynamicExecutorGraph.mockRejectedValue(new Error('Bedrock throttled'));

        await executeAgentRun(makeRun());

        const errorEvent = mockRecordEvent.mock.calls.find(
            (c: unknown[]) => {
                const p = c[0] as Record<string, unknown>;
                return p?.eventType === 'error' && p?.node === 'executor';
            }
        );
        expect(errorEvent).toBeDefined();
    });

    it('passes the error message to updateRunStatus("failed")', async () => {
        const errorMsg = 'Bedrock throttled';
        mockCreateDynamicExecutorGraph.mockRejectedValue(new Error(errorMsg));

        await executeAgentRun(makeRun());

        const failedCall = mockUpdateRunStatus.mock.calls.find(
            (c: unknown[]) => c[2] === 'failed'
        );
        expect(failedCall).toBeDefined();
        expect(failedCall![3]).toMatchObject({ error: errorMsg });
    });

    it('never calls updateRunStatus("completed") on failure', async () => {
        mockCreateDynamicExecutorGraph.mockRejectedValue(new Error('fail'));

        await executeAgentRun(makeRun());

        const completedCall = mockUpdateRunStatus.mock.calls.find(
            (c: unknown[]) => c[2] === 'completed'
        );
        expect(completedCall).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// 3. Sandbox cleanup — always cleaned up even on error
// ---------------------------------------------------------------------------

describe('sandbox cleanup', () => {
    it('creates the sandbox directory with the correct path', async () => {
        const graph = makeFakeGraph([]);
        mockCreateDynamicExecutorGraph.mockResolvedValue(graph);

        const run = makeRun({ runId: 'sandbox-run-abc' });
        await executeAgentRun(run);

        expect(mockMkdir).toHaveBeenCalledWith(
            expect.stringContaining('sandbox-run-abc'),
            expect.objectContaining({ recursive: true })
        );
    });

    it('calls fs.rm with the sandbox path on success', async () => {
        const graph = makeFakeGraph([]);
        mockCreateDynamicExecutorGraph.mockResolvedValue(graph);

        const run = makeRun({ runId: 'cleanup-success-run' });
        await executeAgentRun(run);

        expect(mockRm).toHaveBeenCalledWith(
            expect.stringContaining('cleanup-success-run'),
            expect.objectContaining({ recursive: true, force: true })
        );
    });

    it('calls fs.rm with the sandbox path even when the graph throws', async () => {
        mockCreateDynamicExecutorGraph.mockRejectedValue(new Error('graph error'));

        const run = makeRun({ runId: 'cleanup-error-run' });
        await executeAgentRun(run);

        expect(mockRm).toHaveBeenCalledWith(
            expect.stringContaining('cleanup-error-run'),
            expect.objectContaining({ recursive: true, force: true })
        );
    });

    it('calls fs.rm even when streamEvents throws mid-stream', async () => {
        async function* throwingStream() {
            yield {
                event: 'on_chain_start',
                name: 'evaluator',
                metadata: { langgraph_node: 'evaluator' },
                data: {},
            };
            throw new Error('stream error mid-way');
        }

        const graph = {
            streamEvents: vi.fn().mockReturnValue(throwingStream()),
            getGraph: vi.fn().mockReturnValue({ drawMermaid: vi.fn().mockReturnValue('') }),
        };
        mockCreateDynamicExecutorGraph.mockResolvedValue(graph);

        const run = makeRun({ runId: 'cleanup-midstream-run' });
        await executeAgentRun(run);

        expect(mockRm).toHaveBeenCalledWith(
            expect.stringContaining('cleanup-midstream-run'),
            expect.objectContaining({ recursive: true, force: true })
        );
    });

    it('sandbox path is under /tmp/agent-ops/', async () => {
        const graph = makeFakeGraph([]);
        mockCreateDynamicExecutorGraph.mockResolvedValue(graph);

        const run = makeRun({ runId: 'path-check-run' });
        await executeAgentRun(run);

        const mkdirPath: string = mockMkdir.mock.calls[0][0];
        expect(mkdirPath).toMatch(/^\/tmp\/agent-ops\//);
        expect(mkdirPath).toContain('path-check-run');
    });
});

// ---------------------------------------------------------------------------
// 4. toolsUsed grows monotonically and never shrinks
// ---------------------------------------------------------------------------

describe('toolsUsed grows monotonically', () => {
    it('includes all tools from on_tool_start events in the completed result', async () => {
        const events = [
            {
                event: 'on_tool_start',
                name: 'list_buckets',
                metadata: { langgraph_node: 'tools' },
                data: { input: {} },
            },
            {
                event: 'on_tool_start',
                name: 'get_aws_credentials',
                metadata: { langgraph_node: 'tools' },
                data: { input: {} },
            },
            {
                event: 'on_tool_start',
                name: 'execute_command',
                metadata: { langgraph_node: 'tools' },
                data: { input: {} },
            },
        ];

        const graph = makeFakeGraph(events);
        mockCreateDynamicExecutorGraph.mockResolvedValue(graph);

        await executeAgentRun(makeRun());

        const completedCall = mockUpdateRunStatus.mock.calls.find(
            (c: unknown[]) => c[2] === 'completed'
        );
        const toolsUsed: string[] = completedCall![3].result.toolsUsed;

        expect(toolsUsed).toContain('list_buckets');
        expect(toolsUsed).toContain('get_aws_credentials');
        expect(toolsUsed).toContain('execute_command');
    });

    it('deduplicates tools that appear multiple times', async () => {
        const events = [
            { event: 'on_tool_start', name: 'list_buckets', metadata: { langgraph_node: 'tools' }, data: { input: {} } },
            { event: 'on_tool_start', name: 'list_buckets', metadata: { langgraph_node: 'tools' }, data: { input: {} } },
            { event: 'on_tool_start', name: 'list_buckets', metadata: { langgraph_node: 'tools' }, data: { input: {} } },
        ];

        const graph = makeFakeGraph(events);
        mockCreateDynamicExecutorGraph.mockResolvedValue(graph);

        await executeAgentRun(makeRun());

        const completedCall = mockUpdateRunStatus.mock.calls.find(
            (c: unknown[]) => c[2] === 'completed'
        );
        const toolsUsed: string[] = completedCall![3].result.toolsUsed;

        // Should appear exactly once (Set semantics)
        const listBucketsCount = toolsUsed.filter(t => t === 'list_buckets').length;
        expect(listBucketsCount).toBe(1);
    });

    it('toolsUsed count never decreases across sequential on_tool_start events', async () => {

        const events = [
            { event: 'on_tool_start', name: 'tool_a', metadata: { langgraph_node: 'tools' }, data: { input: {} } },
            { event: 'on_tool_start', name: 'tool_b', metadata: { langgraph_node: 'tools' }, data: { input: {} } },
            { event: 'on_tool_start', name: 'tool_c', metadata: { langgraph_node: 'tools' }, data: { input: {} } },
        ];

        const graph = makeFakeGraph(events);
        mockCreateDynamicExecutorGraph.mockResolvedValue(graph);

        await executeAgentRun(makeRun());

        const completedCall = mockUpdateRunStatus.mock.calls.find(
            (c: unknown[]) => c[2] === 'completed'
        );
        const toolsUsed: string[] = completedCall![3].result.toolsUsed;

        // All 3 distinct tools must be present — the set only grew
        expect(toolsUsed.length).toBe(3);
        expect(toolsUsed).toContain('tool_a');
        expect(toolsUsed).toContain('tool_b');
        expect(toolsUsed).toContain('tool_c');
    });

    it('includes tools from on_chat_model_end tool_calls in the completed result', async () => {
        const events = [
            {
                event: 'on_chat_model_end',
                name: 'claude-3',
                metadata: { langgraph_node: 'generate' },
                data: {
                    output: {
                        tool_calls: [
                            { name: 'read_file', args: { path: '/etc/config' }, id: 'tc1' },
                            { name: 'web_search', args: { query: 'lambda limits' }, id: 'tc2' },
                        ],
                        content: '',
                        usage_metadata: { input_tokens: 100, output_tokens: 50 },
                    },
                },
            },
        ];

        const graph = makeFakeGraph(events);
        mockCreateDynamicExecutorGraph.mockResolvedValue(graph);

        await executeAgentRun(makeRun());

        const completedCall = mockUpdateRunStatus.mock.calls.find(
            (c: unknown[]) => c[2] === 'completed'
        );
        const toolsUsed: string[] = completedCall![3].result.toolsUsed;

        expect(toolsUsed).toContain('read_file');
        expect(toolsUsed).toContain('web_search');
    });

    it('result.toolsUsed is an array (not a Set)', async () => {
        const events = [
            { event: 'on_tool_start', name: 'some_tool', metadata: { langgraph_node: 'tools' }, data: { input: {} } },
        ];

        const graph = makeFakeGraph(events);
        mockCreateDynamicExecutorGraph.mockResolvedValue(graph);

        await executeAgentRun(makeRun());

        const completedCall = mockUpdateRunStatus.mock.calls.find(
            (c: unknown[]) => c[2] === 'completed'
        );
        const toolsUsed = completedCall![3].result.toolsUsed;
        expect(Array.isArray(toolsUsed)).toBe(true);
    });
});
