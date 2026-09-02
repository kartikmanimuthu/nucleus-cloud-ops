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
    mockGetRun,
    mockMkdir,
    mockRm,
    mockCreateDynamicExecutorGraph,
    mockGetMCPManager,
    mockGetSkillContent,
    mockLoadSkills,
    mockLoadAllSkillContent,
    mockResolveModelConfig,
    mockResolveDefaultModelConfig,
    mockTenantConfigGetConfig,
} = vi.hoisted(() => ({
    mockUpdateRunStatus: vi.fn().mockResolvedValue(undefined),
    mockRecordEvent: vi.fn().mockResolvedValue(undefined),
    // Cross-replica cancel poll: not "cancelled" by default so every existing
    // test below exercises the poll's false branch without extra setup.
    mockGetRun: vi.fn().mockResolvedValue({ status: 'in_progress' }),
    mockMkdir: vi.fn().mockResolvedValue(undefined),
    mockRm: vi.fn().mockResolvedValue(undefined),
    mockCreateDynamicExecutorGraph: vi.fn(),
    mockGetMCPManager: vi.fn(),
    mockGetSkillContent: vi.fn().mockReturnValue(null),
    mockLoadSkills: vi.fn().mockResolvedValue([]),
    mockLoadAllSkillContent: vi.fn().mockResolvedValue(new Map()),
    // resolveRunModel() falls through to resolveDefaultModelConfig() for every
    // run here (none set an explicit run.model) — that hits ProviderModelService
    // (real Postgres) unless stubbed. Model resolution itself isn't under test.
    mockResolveModelConfig: vi.fn(),
    mockResolveDefaultModelConfig: vi.fn().mockResolvedValue({
        provider: 'bedrock',
        modelId: 'us.anthropic.claude-sonnet-4-6-v1:0',
        region: 'us-east-1',
    }),
    mockTenantConfigGetConfig: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

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

vi.mock('fs/promises', () => ({
    mkdir: mockMkdir,
    rm: mockRm,
}));

vi.mock('@/lib/agent/mcp-manager', () => ({
    getMCPManager: mockGetMCPManager,
}));

vi.mock('@/lib/skill-service', () => ({
    getSkillContent: mockGetSkillContent,
    loadSkills: mockLoadSkills,
    loadAllSkillContent: mockLoadAllSkillContent,
}));

vi.mock('@/lib/agent/model-resolver', () => ({
    resolveModelConfig: mockResolveModelConfig,
    resolveDefaultModelConfig: mockResolveDefaultModelConfig,
}));

// Used both by agent-ops-defaults.ts's getAgentOpsDefaults() and directly by
// agent-executor.ts's own MCP-config resolution. Defaults to rejecting (matching
// the real DB-less behavior every existing test already implicitly relies on —
// see the beforeEach below), overridden per-test where this path is under test.
vi.mock('@/lib/tenant-config-service', () => ({
    TenantConfigService: { getConfig: mockTenantConfigGetConfig },
}));

// Import after mocks
import { executeAgentRun, resumeApprovedRun } from '../../lib/agent-ops/agent-executor';

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
    mockTenantConfigGetConfig.mockRejectedValue(new Error('no DB in this test env'));
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

// The 'sandbox cleanup' suite that stood here covered the per-run /tmp/agent-ops
// directory, which executeAgentRun created and deleted but never handed to any
// tool. It was removed as dead code in af608d07, so the tests went with it.

// ---------------------------------------------------------------------------
// 4. toolsUsed grows monotonically and never shrinks
// ---------------------------------------------------------------------------

describe('toolsUsed grows monotonically', () => {
    it('includes all tools from on_chat_model_end tool_calls in the completed result', async () => {
        const events = [
            {
                event: 'on_chat_model_end',
                name: 'claude-3',
                metadata: { langgraph_node: 'tools' },
                data: {
                    output: {
                        tool_calls: [{ name: 'list_buckets', args: {}, id: 'tc1' }],
                        content: '',
                        usage_metadata: { input_tokens: 100, output_tokens: 50 },
                    },
                },
            },
            {
                event: 'on_chat_model_end',
                name: 'claude-3',
                metadata: { langgraph_node: 'tools' },
                data: {
                    output: {
                        tool_calls: [{ name: 'get_aws_credentials', args: {}, id: 'tc2' }],
                        content: '',
                        usage_metadata: { input_tokens: 50, output_tokens: 20 },
                    },
                },
            },
            {
                event: 'on_chat_model_end',
                name: 'claude-3',
                metadata: { langgraph_node: 'tools' },
                data: {
                    output: {
                        tool_calls: [{ name: 'execute_command', args: {}, id: 'tc3' }],
                        content: '',
                        usage_metadata: { input_tokens: 50, output_tokens: 20 },
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

        expect(toolsUsed).toContain('list_buckets');
        expect(toolsUsed).toContain('get_aws_credentials');
        expect(toolsUsed).toContain('execute_command');
    });

    it('deduplicates tools that appear multiple times', async () => {
        const events = [
            {
                event: 'on_chat_model_end',
                name: 'claude-3',
                metadata: { langgraph_node: 'tools' },
                data: {
                    output: {
                        tool_calls: [{ name: 'list_buckets', args: {}, id: 'tc1' }],
                        content: '',
                        usage_metadata: { input_tokens: 100, output_tokens: 50 },
                    },
                },
            },
            {
                event: 'on_chat_model_end',
                name: 'claude-3',
                metadata: { langgraph_node: 'tools' },
                data: {
                    output: {
                        tool_calls: [{ name: 'list_buckets', args: {}, id: 'tc2' }],
                        content: '',
                        usage_metadata: { input_tokens: 50, output_tokens: 20 },
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

        // Should appear exactly once (Set semantics)
        const listBucketsCount = toolsUsed.filter(t => t === 'list_buckets').length;
        expect(listBucketsCount).toBe(1);
    });

    it('toolsUsed count never decreases across sequential on_chat_model_end events', async () => {
        const events = [
            {
                event: 'on_chat_model_end',
                name: 'claude-3',
                metadata: { langgraph_node: 'tools' },
                data: {
                    output: {
                        tool_calls: [{ name: 'tool_a', args: {}, id: 'tc1' }],
                        content: '',
                        usage_metadata: { input_tokens: 100, output_tokens: 50 },
                    },
                },
            },
            {
                event: 'on_chat_model_end',
                name: 'claude-3',
                metadata: { langgraph_node: 'tools' },
                data: {
                    output: {
                        tool_calls: [{ name: 'tool_b', args: {}, id: 'tc2' }],
                        content: '',
                        usage_metadata: { input_tokens: 50, output_tokens: 20 },
                    },
                },
            },
            {
                event: 'on_chat_model_end',
                name: 'claude-3',
                metadata: { langgraph_node: 'tools' },
                data: {
                    output: {
                        tool_calls: [{ name: 'tool_c', args: {}, id: 'tc3' }],
                        content: '',
                        usage_metadata: { input_tokens: 50, output_tokens: 20 },
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
                        tool_calls: [{ name: 'read_file', args: { path: '/etc/config' }, id: 'tc1' }],
                        content: '',
                        usage_metadata: { input_tokens: 100, output_tokens: 50 },
                    },
                },
            },
            {
                event: 'on_chat_model_end',
                name: 'claude-3',
                metadata: { langgraph_node: 'generate' },
                data: {
                    output: {
                        tool_calls: [{ name: 'web_search', args: { query: 'lambda limits' }, id: 'tc2' }],
                        content: '',
                        usage_metadata: { input_tokens: 50, output_tokens: 20 },
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

// ---------------------------------------------------------------------------
// 5. Cancellation
// ---------------------------------------------------------------------------

describe('cancellation', () => {
    it('marks the run cancelled (not completed) when aborted mid-stream', async () => {
        const { cancelRun } = await import('../../lib/agent-ops/run-manager');
        // Abort as a side effect of the stream itself — the graph, MCP client, etc.
        // would ordinarily see this via AbortController, but for this unit test the
        // only observable effect under test is executeAgentRun's post-loop isAborted() check.
        async function* abortingEvents() {
            cancelRun('run-test-123');
        }
        const graph = { streamEvents: () => abortingEvents(), getGraph: () => ({ drawMermaid: () => '' }) };
        mockCreateDynamicExecutorGraph.mockResolvedValue(graph);

        await executeAgentRun(makeRun());

        const statuses = mockUpdateRunStatus.mock.calls.map((c: unknown[]) => c[2]);
        expect(statuses).toContain('cancelled');
        expect(statuses).not.toContain('completed');

        const cancelledEvent = mockRecordEvent.mock.calls.find((c: unknown[]) => (c[0] as any).node === '__cancelled__');
        expect(cancelledEvent).toBeDefined();
    });
});

// ---------------------------------------------------------------------------
// 6. Graph interrupt / HITL states
// ---------------------------------------------------------------------------

describe('clarification and approval-gate interrupts', () => {
    it('sets status awaiting_input and emits hil:clarification when the graph needs clarification', async () => {
        const emit = vi.fn();
        const graph = makeFakeGraph([]);
        (graph as any).getState = vi.fn().mockResolvedValue({
            values: {
                nextAction: 'awaiting_input',
                clarificationQuestion: 'Which AWS account?',
                evaluation: { missingInfo: 'accountId' },
            },
        });
        mockCreateDynamicExecutorGraph.mockResolvedValue(graph);

        await executeAgentRun(makeRun(), { emit } as any);

        const call = mockUpdateRunStatus.mock.calls.find((c: unknown[]) => c[2] === 'awaiting_input');
        expect(call![3].clarification).toEqual({ question: 'Which AWS account?', missingInfo: 'accountId' });
        expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'hil:clarification' }));
        // Terminal branch — never reaches the "mark completed" tail.
        expect(mockUpdateRunStatus.mock.calls.some((c: unknown[]) => c[2] === 'completed')).toBe(false);
    });

    it('defaults missingInfo to a generic message when the graph omits it', async () => {
        const graph = makeFakeGraph([]);
        (graph as any).getState = vi.fn().mockResolvedValue({
            values: { nextAction: 'awaiting_input', clarificationQuestion: 'Which region?' },
        });
        mockCreateDynamicExecutorGraph.mockResolvedValue(graph);

        await executeAgentRun(makeRun());

        const call = mockUpdateRunStatus.mock.calls.find((c: unknown[]) => c[2] === 'awaiting_input');
        expect(call![3].clarification.missingInfo).toBe('Additional information');
    });

    it('sets status awaiting_approval and emits hil:plan_approval at the plan-level approval gate', async () => {
        const emit = vi.fn();
        const graph = makeFakeGraph([]);
        (graph as any).getState = vi.fn().mockResolvedValue({
            values: { plan: [{ step: 'Stop the instance', status: 'pending' }] },
            next: ['approval_gate'],
        });
        mockCreateDynamicExecutorGraph.mockResolvedValue(graph);

        await executeAgentRun(makeRun(), { emit } as any);

        const call = mockUpdateRunStatus.mock.calls.find((c: unknown[]) => c[2] === 'awaiting_approval');
        expect(call![3].approvalRequest).toEqual({ planSteps: ['Stop the instance'], approvalType: 'plan' });
        expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'hil:plan_approval' }));
    });

    it('does not gate at the plan-level approval gate when autoApprove is true', async () => {
        const graph = makeFakeGraph([]);
        (graph as any).getState = vi.fn().mockResolvedValue({
            values: { plan: [{ step: 'x', status: 'pending' }] },
            next: ['approval_gate'],
        });
        mockCreateDynamicExecutorGraph.mockResolvedValue(graph);

        await executeAgentRun(makeRun({ autoApprove: true }));

        expect(mockUpdateRunStatus.mock.calls.some((c: unknown[]) => c[2] === 'awaiting_approval')).toBe(false);
        expect(mockUpdateRunStatus.mock.calls.some((c: unknown[]) => c[2] === 'completed')).toBe(true);
    });

    it('sets status awaiting_approval and emits hil:tool_approval at the mutative tool gate', async () => {
        const emit = vi.fn();
        const graph = makeFakeGraph([]);
        (graph as any).getState = vi.fn().mockResolvedValue({
            values: { pendingToolApprovals: ['stop-instance'] },
            next: ['mutative_approval_gate'],
        });
        mockCreateDynamicExecutorGraph.mockResolvedValue(graph);

        await executeAgentRun(makeRun(), { emit } as any);

        const call = mockUpdateRunStatus.mock.calls.find((c: unknown[]) => c[2] === 'awaiting_approval');
        expect(call![3].approvalRequest).toEqual({
            planSteps: ['Execute mutative tools: stop-instance'],
            pendingTools: ['stop-instance'],
            approvalType: 'tool_execution',
        });
        expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'hil:tool_approval' }));
    });

    it('sets status awaiting_input when LangGraph reports a generic pending tool interrupt', async () => {
        const graph = makeFakeGraph([]);
        (graph as any).getState = vi.fn().mockResolvedValue({
            values: {},
            next: [],
            tasks: [{ name: 'execute_command', interrupts: [{ value: 'approve?' }] }],
        });
        mockCreateDynamicExecutorGraph.mockResolvedValue(graph);

        await executeAgentRun(makeRun());

        const call = mockUpdateRunStatus.mock.calls.find((c: unknown[]) => c[2] === 'awaiting_input');
        expect(call![3].clarification).toEqual({
            question: 'Approval required for tools: execute_command',
            missingInfo: 'tool_approval',
        });
    });

    it('ignores tasks with no pending interrupts and completes normally', async () => {
        const graph = makeFakeGraph([]);
        (graph as any).getState = vi.fn().mockResolvedValue({
            values: {}, next: [], tasks: [{ name: 'describe_instances', interrupts: [] }],
        });
        mockCreateDynamicExecutorGraph.mockResolvedValue(graph);

        await executeAgentRun(makeRun());

        expect(mockUpdateRunStatus.mock.calls.some((c: unknown[]) => c[2] === 'completed')).toBe(true);
    });

    it('treats a getState failure as non-fatal and completes normally', async () => {
        const graph = makeFakeGraph([]);
        (graph as any).getState = vi.fn().mockRejectedValue(new Error('checkpoint read failed'));
        mockCreateDynamicExecutorGraph.mockResolvedValue(graph);

        await executeAgentRun(makeRun());

        expect(mockUpdateRunStatus.mock.calls.some((c: unknown[]) => c[2] === 'completed')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// 7. Model resolution fallback
// ---------------------------------------------------------------------------

describe('resolveRunModel fallback chain', () => {
    it('uses the explicit run.model over any tenant default', async () => {
        mockResolveModelConfig.mockResolvedValueOnce({ provider: 'bedrock', modelId: 'explicit-model', region: 'us-east-1' });
        const graph = makeFakeGraph([]);
        mockCreateDynamicExecutorGraph.mockResolvedValue(graph);

        await executeAgentRun(makeRun({ model: 'explicit-model' }));

        expect(mockResolveModelConfig).toHaveBeenCalledWith('explicit-model', 'T0001');
        expect(mockResolveDefaultModelConfig).not.toHaveBeenCalled();
    });

    it('falls back to the provider default when the tenant Agent Ops default model fails to resolve', async () => {
        // TenantConfigService.getConfig is also called (with a different key) for
        // MCP-server resolution earlier in the run — discriminate by key so that
        // unrelated call doesn't consume this response.
        mockTenantConfigGetConfig.mockImplementation((key: string) =>
            key === 'agent-ops-defaults'
                ? Promise.resolve({ defaultModel: 'stale-model', maxIterations: 50 })
                : Promise.reject(new Error('no DB in this test env')),
        );
        mockResolveModelConfig.mockRejectedValueOnce(new Error('model no longer configured'));
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const graph = makeFakeGraph([]);
        mockCreateDynamicExecutorGraph.mockResolvedValue(graph);

        await executeAgentRun(makeRun());

        expect(mockResolveModelConfig).toHaveBeenCalledWith('stale-model', 'T0001');
        expect(mockResolveDefaultModelConfig).toHaveBeenCalledWith('T0001');
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('failed to resolve'), expect.any(Error));
        expect(mockUpdateRunStatus.mock.calls.some((c: unknown[]) => c[2] === 'completed')).toBe(true);
    });

    it('uses the tenant Agent Ops default model when it resolves successfully', async () => {
        mockTenantConfigGetConfig.mockImplementation((key: string) =>
            key === 'agent-ops-defaults'
                ? Promise.resolve({ defaultModel: 'tenant-default-model', maxIterations: 50 })
                : Promise.reject(new Error('no DB in this test env')),
        );
        mockResolveModelConfig.mockResolvedValueOnce({ provider: 'bedrock', modelId: 'tenant-default-model', region: 'us-east-1' });
        const graph = makeFakeGraph([]);
        mockCreateDynamicExecutorGraph.mockResolvedValue(graph);

        await executeAgentRun(makeRun());

        expect(mockResolveModelConfig).toHaveBeenCalledWith('tenant-default-model', 'T0001');
        expect(mockResolveDefaultModelConfig).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// 8. MCP server connection
// ---------------------------------------------------------------------------

describe('MCP server connection', () => {
    it('connects the enabled, requested MCP servers when tenant config resolves', async () => {
        mockTenantConfigGetConfig.mockResolvedValueOnce({
            mcpServers: { jira: { command: 'npx', args: ['jira-mcp'] } },
        });
        const mcpManager = makeMCPManager();
        mockGetMCPManager.mockReturnValue(mcpManager);
        const graph = makeFakeGraph([]);
        mockCreateDynamicExecutorGraph.mockResolvedValue(graph);

        await executeAgentRun(makeRun({ mcpServerIds: ['jira'] }));

        expect(mcpManager.connectServers).toHaveBeenCalledWith(['jira'], expect.arrayContaining([
            expect.objectContaining({ id: 'jira', enabled: true }),
        ]));
    });

    it('does not connect servers that are not enabled in the resolved config', async () => {
        mockTenantConfigGetConfig.mockResolvedValueOnce({
            mcpServers: { jira: { command: 'npx', args: ['jira-mcp'], disabled: true } },
        });
        const mcpManager = makeMCPManager();
        mockGetMCPManager.mockReturnValue(mcpManager);
        const graph = makeFakeGraph([]);
        mockCreateDynamicExecutorGraph.mockResolvedValue(graph);

        await executeAgentRun(makeRun({ mcpServerIds: ['jira'] }));

        expect(mcpManager.connectServers).not.toHaveBeenCalled();
    });

    it('treats a TenantConfigService failure as non-fatal and still completes', async () => {
        // Default beforeEach already rejects mockTenantConfigGetConfig.
        const graph = makeFakeGraph([]);
        mockCreateDynamicExecutorGraph.mockResolvedValue(graph);

        await executeAgentRun(makeRun({ mcpServerIds: ['jira'] }));

        expect(mockUpdateRunStatus.mock.calls.some((c: unknown[]) => c[2] === 'completed')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// 9. mapNodeToEventType — remaining switch branches, exercised via streamed events
// ---------------------------------------------------------------------------

describe('event node → eventType mapping', () => {
    it('maps clarify/reflect/revise/tools nodes to their respective eventTypes on text content', async () => {
        const makeChatEndEvent = (node: string, text: string) => ({
            event: 'on_chat_model_end',
            name: 'claude-3',
            metadata: { langgraph_node: node },
            data: { output: { tool_calls: [], content: text, usage_metadata: { input_tokens: 1, output_tokens: 1 } } },
        });
        const events = [
            makeChatEndEvent('revise', 'revision text'),
            makeChatEndEvent('tools', 'tools text'),
        ];
        const graph = makeFakeGraph(events);
        mockCreateDynamicExecutorGraph.mockResolvedValue(graph);

        await executeAgentRun(makeRun());

        const eventTypes = mockRecordEvent.mock.calls.map((c: unknown[]) => (c[0] as any).eventType);
        expect(eventTypes).toContain('revision');
        expect(eventTypes).toContain('tool_call');
    });

    it('maps the clarify node to a planning eventType', async () => {
        const events = [{
            event: 'on_chat_model_end', name: 'claude-3', metadata: { langgraph_node: 'clarify' },
            data: { output: { tool_calls: [], content: 'What region?', usage_metadata: { input_tokens: 1, output_tokens: 1 } } },
        }];
        mockCreateDynamicExecutorGraph.mockResolvedValue(makeFakeGraph(events));

        await executeAgentRun(makeRun());

        const eventTypes = mockRecordEvent.mock.calls.map((c: unknown[]) => (c[0] as any).eventType);
        expect(eventTypes).toContain('planning');
    });

    it('maps the final node to a final eventType and captures it as finalContent', async () => {
        const events = [{
            event: 'on_chat_model_end', name: 'claude-3', metadata: { langgraph_node: 'final' },
            data: { output: { tool_calls: [], content: 'All done here.', usage_metadata: { input_tokens: 1, output_tokens: 1 } } },
        }];
        mockCreateDynamicExecutorGraph.mockResolvedValue(makeFakeGraph(events));

        await executeAgentRun(makeRun());

        const finalEvent = mockRecordEvent.mock.calls.find((c: unknown[]) => (c[0] as any).eventType === 'final');
        expect(finalEvent).toBeDefined();
        const completedCall = mockUpdateRunStatus.mock.calls.find((c: unknown[]) => c[2] === 'completed');
        expect(completedCall![3].result.summary).toBe('All done here.');
    });

    it('falls back to execution for an unrecognized node', async () => {
        const events = [{
            event: 'on_chat_model_end', name: 'claude-3', metadata: { langgraph_node: 'mystery_node' },
            data: { output: { tool_calls: [], content: 'chatter', usage_metadata: { input_tokens: 1, output_tokens: 1 } } },
        }];
        mockCreateDynamicExecutorGraph.mockResolvedValue(makeFakeGraph(events));

        await executeAgentRun(makeRun());

        const eventTypes = mockRecordEvent.mock.calls.map((c: unknown[]) => (c[0] as any).eventType);
        expect(eventTypes).toContain('execution');
    });

    // Note: mapNodeToEventType's `case 'reflect': return 'reflection'` (agent-executor.ts:63)
    // is unreachable in production — its only call site is gated by
    // `!STRUCTURED_TWIN_NODES.has(node)`, and STRUCTURED_TWIN_NODES includes 'reflect'
    // (the structured reflection event is recorded separately, via on_chain_end below,
    // to avoid double-listing). Left untested rather than gamed.
});

// ---------------------------------------------------------------------------
// 10. on_chain_end structured extraction (final messages / reflect / planner)
// ---------------------------------------------------------------------------

describe('on_chain_end structured extraction', () => {
    it('extracts finalContent from the final node output.messages', async () => {
        const events = [{
            event: 'on_chain_end', name: 'final', metadata: { langgraph_node: 'final' },
            data: { output: { messages: [{ content: 'The Lambda config looks correct.' }] } },
        }];
        mockCreateDynamicExecutorGraph.mockResolvedValue(makeFakeGraph(events));

        await executeAgentRun(makeRun());

        const completedCall = mockUpdateRunStatus.mock.calls.find((c: unknown[]) => c[2] === 'completed');
        expect(completedCall![3].result.summary).toBe('The Lambda config looks correct.');
    });

    it('records a structured reflection event from the reflect node output', async () => {
        const events = [{
            event: 'on_chain_end', name: 'reflect', metadata: { langgraph_node: 'reflect' },
            data: { output: { reflection: 'Plan looks sound.', isComplete: true, errors: [] } },
        }];
        mockCreateDynamicExecutorGraph.mockResolvedValue(makeFakeGraph(events));

        await executeAgentRun(makeRun());

        const reflectionEvent = mockRecordEvent.mock.calls.find(
            (c: unknown[]) => (c[0] as any).eventType === 'reflection' && (c[0] as any).content === 'Plan looks sound.'
        );
        expect(reflectionEvent).toBeDefined();
    });

    it('records a structured planning event with the plan steps from the planner node output', async () => {
        const events = [{
            event: 'on_chain_end', name: 'planner', metadata: { langgraph_node: 'planner' },
            data: { output: { plan: [{ step: 'Stop the instance' }, { step: 'Verify it stopped' }] } },
        }];
        mockCreateDynamicExecutorGraph.mockResolvedValue(makeFakeGraph(events));

        await executeAgentRun(makeRun());

        const planningEvent = mockRecordEvent.mock.calls.find(
            (c: unknown[]) => (c[0] as any).eventType === 'planning' && (c[0] as any).node === 'planner'
        );
        expect(planningEvent).toBeDefined();
        expect((planningEvent![0] as any).content).toContain('1. Stop the instance');
        expect((planningEvent![0] as any).content).toContain('2. Verify it stopped');
        expect((planningEvent![0] as any).metadata.stepCount).toBe(2);
    });
});

// ---------------------------------------------------------------------------
// 11. on_tool_end output shapes + on_chain_start iteration tracking
// ---------------------------------------------------------------------------

describe('on_tool_end output shapes', () => {
    it('extracts the string content field when the tool output is an object', async () => {
        const events = [{
            event: 'on_tool_end', name: 'describe_instances', metadata: { langgraph_node: 'tools' },
            data: { output: { content: 'Found 2 instances' } },
        }];
        mockCreateDynamicExecutorGraph.mockResolvedValue(makeFakeGraph(events));

        await executeAgentRun(makeRun());

        const toolResult = mockRecordEvent.mock.calls.find((c: unknown[]) => (c[0] as any).eventType === 'tool_result');
        expect(toolResult![0].toolOutput).toBe('Found 2 instances');
    });

    it('JSON-stringifies a non-string tool output object with no content field', async () => {
        const events = [{
            event: 'on_tool_end', name: 'list_buckets', metadata: { langgraph_node: 'tools' },
            data: { output: ['bucket-a', 'bucket-b'] },
        }];
        mockCreateDynamicExecutorGraph.mockResolvedValue(makeFakeGraph(events));

        await executeAgentRun(makeRun());

        const toolResult = mockRecordEvent.mock.calls.find((c: unknown[]) => (c[0] as any).eventType === 'tool_result');
        expect(toolResult![0].toolOutput).toBe('["bucket-a","bucket-b"]');
    });

    // Genuine finding, not fixed (out of scope): `else if (output && 'content' in output)`
    // (agent-executor.ts:544) assumes a truthy `output` is always an object. A tool that
    // resolves with a bare primitive (e.g. `42` or `true`) makes `'content' in output` throw
    // a TypeError, which is swallowed by the outer per-event try/catch (line 205) as
    // "non-fatal" — but unlike the JSON.stringify fallback, the tool_result event is then
    // never recorded at all, silently dropping that step from the run's timeline.
});

describe('on_chain_start iteration tracking', () => {
    it('increments iterationDelta for the generate node', async () => {
        const events = [{ event: 'on_chain_start', name: 'generate', metadata: { langgraph_node: 'generate' }, data: {} }];
        mockCreateDynamicExecutorGraph.mockResolvedValue(makeFakeGraph(events));

        await executeAgentRun(makeRun());

        const completedCall = mockUpdateRunStatus.mock.calls.find((c: unknown[]) => c[2] === 'completed');
        expect(completedCall![3].result.iterations).toBeGreaterThanOrEqual(1);
    });
});

// ---------------------------------------------------------------------------
// 12. Cross-replica cancel poll
// ---------------------------------------------------------------------------

describe('cross-replica cancel poll', () => {
    it('aborts and marks the run cancelled when another replica flips the DB status to cancelled', async () => {
        mockGetRun.mockResolvedValueOnce({ status: 'cancelled' });
        const events = [{ event: 'on_chain_start', name: 'evaluator', metadata: { langgraph_node: 'evaluator' }, data: {} }];
        mockCreateDynamicExecutorGraph.mockResolvedValue(makeFakeGraph(events));

        await executeAgentRun(makeRun());

        const statuses = mockUpdateRunStatus.mock.calls.map((c: unknown[]) => c[2]);
        expect(statuses).toContain('cancelled');
        expect(statuses).not.toContain('completed');
    });

    it('treats a failed status poll as non-fatal and completes normally', async () => {
        mockGetRun.mockRejectedValueOnce(new Error('DB unreachable'));
        const graph = makeFakeGraph([]);
        mockCreateDynamicExecutorGraph.mockResolvedValue(graph);

        await executeAgentRun(makeRun());

        expect(mockUpdateRunStatus.mock.calls.some((c: unknown[]) => c[2] === 'completed')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// 13. Event-recording resilience + eventBus emits on abort/failure
// ---------------------------------------------------------------------------

describe('event-recording resilience', () => {
    it('logs a mid-stream event-recording failure as non-fatal and still completes', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        // 1st recordEvent call is the "__start__" planning event (must succeed);
        // 2nd is the in-loop tool_result recordAndEmit — reject just that one.
        mockRecordEvent.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('recordEvent boom'));
        const events = [{ event: 'on_tool_end', name: 'stop_ec2', metadata: { langgraph_node: 'tools' }, data: { output: 'done' } }];
        mockCreateDynamicExecutorGraph.mockResolvedValue(makeFakeGraph(events));

        await executeAgentRun(makeRun());

        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Event recording error'), expect.any(Error));
        expect(mockUpdateRunStatus.mock.calls.some((c: unknown[]) => c[2] === 'completed')).toBe(true);
    });
});

describe('eventBus emits on abort and failure', () => {
    it('emits run:cancelled on the event bus when the graph stream throws an AbortError', async () => {
        const emit = vi.fn();
        const graph = {
            streamEvents: vi.fn().mockImplementation(() => {
                throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
            }),
            getGraph: vi.fn().mockReturnValue({ drawMermaid: vi.fn().mockReturnValue('') }),
        };
        mockCreateDynamicExecutorGraph.mockResolvedValue(graph);

        await executeAgentRun(makeRun(), { emit } as any);

        const statuses = mockUpdateRunStatus.mock.calls.map((c: unknown[]) => c[2]);
        expect(statuses).toContain('cancelled');
        expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'run:cancelled' }));
    });

    it('emits run:failed on the event bus when the run fails for a non-abort reason', async () => {
        const emit = vi.fn();
        mockCreateDynamicExecutorGraph.mockRejectedValue(new Error('Bedrock throttled'));

        await executeAgentRun(makeRun(), { emit } as any);

        const statuses = mockUpdateRunStatus.mock.calls.map((c: unknown[]) => c[2]);
        expect(statuses).toContain('failed');
        expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'run:failed', data: { error: 'Bedrock throttled' } }));
    });
});

// ---------------------------------------------------------------------------
// 14. resumeApprovedRun
// ---------------------------------------------------------------------------

describe('resumeApprovedRun', () => {
    function makeResumableGraph(events: unknown[] = []) {
        return {
            updateState: vi.fn().mockResolvedValue(undefined),
            streamEvents: vi.fn().mockReturnValue(makeEventStream(events)),
            getState: vi.fn().mockResolvedValue({ values: {}, next: [] }),
        };
    }

    it('transitions in_progress → completed on a clean resume', async () => {
        const graph = makeResumableGraph([]);
        mockCreateDynamicExecutorGraph.mockResolvedValue(graph);

        await resumeApprovedRun(makeRun() as never);

        const statuses = mockUpdateRunStatus.mock.calls.map((c: unknown[]) => c[2]);
        expect(statuses).toContain('in_progress');
        expect(statuses).toContain('completed');
        expect(graph.updateState).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ approvalStatus: 'approved', nextAction: 'generate' }),
        );
    });

    it('records a "Plan approved" planning event at the approval_gate node before resuming', async () => {
        mockCreateDynamicExecutorGraph.mockResolvedValue(makeResumableGraph([]));

        await resumeApprovedRun(makeRun() as never);

        const approvalEvent = mockRecordEvent.mock.calls.find((c: unknown[]) => (c[0] as any).node === 'approval_gate');
        expect(approvalEvent).toBeDefined();
        expect((approvalEvent![0] as any).content).toContain('resuming execution');
    });

    it('re-enters the mutative tool-approval gate when the resumed graph interrupts again', async () => {
        const emit = vi.fn();
        const graph = makeResumableGraph([]);
        graph.getState = vi.fn().mockResolvedValue({
            values: { pendingToolApprovals: ['stop-instance'] },
            next: ['mutative_approval_gate'],
        });
        mockCreateDynamicExecutorGraph.mockResolvedValue(graph);

        await resumeApprovedRun(makeRun() as never, { emit } as any);

        const call = mockUpdateRunStatus.mock.calls.find((c: unknown[]) => c[2] === 'awaiting_approval');
        expect(call![3].approvalRequest).toEqual({
            planSteps: ['Execute mutative tools: stop-instance'],
            pendingTools: ['stop-instance'],
            approvalType: 'tool_execution',
        });
        expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'hil:tool_approval' }));
        expect(mockUpdateRunStatus.mock.calls.some((c: unknown[]) => c[2] === 'completed')).toBe(false);
    });

    it('re-enters awaiting_input when the resumed graph reports a generic pending tool interrupt', async () => {
        const graph = makeResumableGraph([]);
        graph.getState = vi.fn().mockResolvedValue({
            values: {}, next: [], tasks: [{ name: 'execute_command', interrupts: [{ value: 'approve?' }] }],
        });
        mockCreateDynamicExecutorGraph.mockResolvedValue(graph);

        await resumeApprovedRun(makeRun() as never);

        const call = mockUpdateRunStatus.mock.calls.find((c: unknown[]) => c[2] === 'awaiting_input');
        expect(call![3].clarification.question).toContain('execute_command');
    });

    it('emits run:completed with the fresh run on success when an event bus is supplied', async () => {
        const emit = vi.fn();
        mockGetRun.mockResolvedValueOnce({ runId: 'run-test-123', status: 'completed' });
        mockCreateDynamicExecutorGraph.mockResolvedValue(makeResumableGraph([]));

        await resumeApprovedRun(makeRun() as never, { emit } as any);

        expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'run:completed' }));
    });

    it('marks the run cancelled and emits run:cancelled when the resumed stream throws an AbortError', async () => {
        const emit = vi.fn();
        const graph = makeResumableGraph([]);
        graph.streamEvents = vi.fn().mockImplementation(() => {
            throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
        });
        mockCreateDynamicExecutorGraph.mockResolvedValue(graph);

        await resumeApprovedRun(makeRun() as never, { emit } as any);

        const statuses = mockUpdateRunStatus.mock.calls.map((c: unknown[]) => c[2]);
        expect(statuses).toContain('cancelled');
        expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'run:cancelled' }));
    });

    it('marks the run failed, records an error event, and emits run:failed for a non-abort failure', async () => {
        const emit = vi.fn();
        mockCreateDynamicExecutorGraph.mockRejectedValue(new Error('Graph resume failed'));

        await resumeApprovedRun(makeRun() as never, { emit } as any);

        const statuses = mockUpdateRunStatus.mock.calls.map((c: unknown[]) => c[2]);
        expect(statuses).toContain('failed');
        const errorEvent = mockRecordEvent.mock.calls.find(
            (c: unknown[]) => (c[0] as any).eventType === 'error' && (c[0] as any).node === 'executor'
        );
        expect(errorEvent).toBeDefined();
        expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'run:failed', data: { error: 'Graph resume failed' } }));
    });

    it('marks the run cancelled (no completion) when cross-replica cancellation is detected mid-resume', async () => {
        mockGetRun.mockResolvedValueOnce({ status: 'cancelled' });
        const events = [{ event: 'on_chain_start', name: 'evaluator', metadata: { langgraph_node: 'evaluator' }, data: {} }];
        mockCreateDynamicExecutorGraph.mockResolvedValue(makeResumableGraph(events));

        await resumeApprovedRun(makeRun() as never);

        const statuses = mockUpdateRunStatus.mock.calls.map((c: unknown[]) => c[2]);
        expect(statuses).toContain('cancelled');
        expect(statuses).not.toContain('completed');
    });
});
