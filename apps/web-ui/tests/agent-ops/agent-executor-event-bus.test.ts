/**
 * Wiring tests for agent-executor.ts → GatewayEventBus
 *
 * Requirements: step-boundary events reach channel adapters live
 *
 * Guards the defect Task 1 fixed: processLangGraphEvent persisted events but
 * never emitted them, so `run:event` had no producer. These drive the REAL
 * executeAgentRun with a mock bus and assert the bus actually receives the
 * event — reverting the eventBus threading or the recordAndEmit swap fails here.
 *
 * Lives beside agent-executor.test.ts rather than inside it: reaching the event
 * stream requires mocking the model resolver, and vi.mock is hoisted file-wide,
 * so adding it there would change the behaviour of that file's 19 pre-existing
 * failures. Same harness style, isolated blast radius.
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
    mockGetAgentOpsDefaults,
    mockResolveMaxIterations,
} = vi.hoisted(() => ({
    mockUpdateRunStatus: vi.fn().mockResolvedValue(undefined),
    mockRecordEvent: vi.fn().mockResolvedValue(undefined),
    mockGetRun: vi.fn().mockResolvedValue(undefined),
    mockMkdir: vi.fn().mockResolvedValue(undefined),
    mockRm: vi.fn().mockResolvedValue(undefined),
    mockCreateDynamicExecutorGraph: vi.fn(),
    mockGetMCPManager: vi.fn(),
    mockGetSkillContent: vi.fn().mockReturnValue(null),
    mockLoadSkills: vi.fn().mockResolvedValue([]),
    mockLoadAllSkillContent: vi.fn().mockResolvedValue(new Map()),
    mockResolveModelConfig: vi.fn().mockResolvedValue({ model: 'test-model' }),
    mockResolveDefaultModelConfig: vi.fn().mockResolvedValue({ model: 'test-model' }),
    mockGetAgentOpsDefaults: vi.fn().mockResolvedValue(null),
    mockResolveMaxIterations: vi.fn().mockResolvedValue(30),
}));

// ---------------------------------------------------------------------------
// Mocks — record-and-emit is deliberately NOT mocked; it is under test.
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

vi.mock('../../lib/agent/model-resolver', () => ({
    resolveModelConfig: mockResolveModelConfig,
    resolveDefaultModelConfig: mockResolveDefaultModelConfig,
}));

vi.mock('../../lib/agent-ops/agent-ops-defaults', () => ({
    getAgentOpsDefaults: mockGetAgentOpsDefaults,
    resolveMaxIterations: mockResolveMaxIterations,
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

// Import after mocks
import { executeAgentRun } from '../../lib/agent-ops/agent-executor';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRun(overrides: Record<string, unknown> = {}) {
    return {
        PK: 'TENANT#T0001',
        SK: 'RUN#run-bus-123',
        runId: 'run-bus-123',
        tenantId: 'T0001',
        source: 'slack' as const,
        status: 'queued' as const,
        taskDescription: 'Check Lambda configs',
        mode: 'fast' as const,
        threadId: 'agent-ops-run-bus-123',
        trigger: { userId: 'U0001', channelId: 'C0001', responseUrl: 'https://hooks.slack.com/commands/abc' },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ttl: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
        mcpServerIds: [],
        ...overrides,
    };
}

function makeMCPManager() {
    return { connectServers: vi.fn().mockResolvedValue(undefined) };
}

async function* makeEventStream(events: unknown[]) {
    for (const event of events) {
        yield event;
    }
}

function makeFakeGraph(events: unknown[] = []) {
    return {
        streamEvents: vi.fn().mockReturnValue(makeEventStream(events)),
        getGraph: vi.fn().mockReturnValue({ drawMermaid: vi.fn().mockReturnValue('') }),
    };
}

/** A LangGraph on_tool_end event — becomes a `tool_result` step boundary */
function toolEndEvent(toolName: string, output: string) {
    return {
        event: 'on_tool_end',
        name: toolName,
        metadata: { langgraph_node: 'tools', langgraph_step: 2 },
        data: { output },
    };
}

const runEvents = (bus: { emit: ReturnType<typeof vi.fn> }) =>
    bus.emit.mock.calls.map(c => c[0]).filter(e => e.type === 'run:event');

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
    vi.clearAllMocks();
    mockGetMCPManager.mockReturnValue(makeMCPManager());
    mockResolveModelConfig.mockResolvedValue({ model: 'test-model' });
    mockResolveDefaultModelConfig.mockResolvedValue({ model: 'test-model' });
    mockGetAgentOpsDefaults.mockResolvedValue(null);
    mockResolveMaxIterations.mockResolvedValue(30);
    mockGetRun.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// executeAgentRun forwards its eventBus into the event pipeline
// ---------------------------------------------------------------------------

describe('executeAgentRun → GatewayEventBus wiring', () => {
    it('emits run:event on the bus for a tool_result step boundary', async () => {
        mockCreateDynamicExecutorGraph.mockResolvedValue(
            makeFakeGraph([toolEndEvent('execute_command', 'ok: 3 buckets')])
        );
        const bus = { emit: vi.fn() };

        await executeAgentRun(makeRun() as never, bus as never);

        const emitted = runEvents(bus);
        expect(emitted).toHaveLength(1);
        expect(emitted[0].runId).toBe('run-bus-123');
        expect(emitted[0].tenantId).toBe('T0001');
        expect(emitted[0].data.event.eventType).toBe('tool_result');
        expect(emitted[0].data.event.toolName).toBe('execute_command');
        expect(emitted[0].data.event.toolOutput).toContain('3 buckets');
    });

    it('emits one run:event per step boundary, in stream order', async () => {
        mockCreateDynamicExecutorGraph.mockResolvedValue(
            makeFakeGraph([
                toolEndEvent('list_buckets', 'a'),
                toolEndEvent('read_file', 'b'),
            ])
        );
        const bus = { emit: vi.fn() };

        await executeAgentRun(makeRun() as never, bus as never);

        expect(runEvents(bus).map(e => e.data.event.toolName)).toEqual(['list_buckets', 'read_file']);
    });

    it('does not emit for a non-boundary event, but still records it', async () => {
        // 'generate' text with no tool calls → mapNodeToEventType → 'execution'
        mockCreateDynamicExecutorGraph.mockResolvedValue(
            makeFakeGraph([
                {
                    event: 'on_chat_model_end',
                    name: 'claude',
                    metadata: { langgraph_node: 'generate' },
                    data: { output: { tool_calls: [], content: 'thinking out loud', usage_metadata: {} } },
                },
            ])
        );
        const bus = { emit: vi.fn() };

        await executeAgentRun(makeRun() as never, bus as never);

        expect(runEvents(bus)).toHaveLength(0);
        const recorded = mockRecordEvent.mock.calls.map(c => c[0].eventType);
        expect(recorded).toContain('execution');
    });

    it('runs to completion when no event bus is supplied', async () => {
        mockCreateDynamicExecutorGraph.mockResolvedValue(
            makeFakeGraph([toolEndEvent('execute_command', 'ok')])
        );

        await executeAgentRun(makeRun() as never);

        const statuses = mockUpdateRunStatus.mock.calls.map((c: unknown[]) => c[2]);
        expect(statuses).toContain('completed');
        expect(statuses).not.toContain('failed');
    });

    it('a step-boundary emit failure never disturbs the run', async () => {
        mockCreateDynamicExecutorGraph.mockResolvedValue(
            makeFakeGraph([toolEndEvent('a_tool', 'ok'), toolEndEvent('b_tool', 'ok')])
        );
        // Throws only for run:event — the boundary path this task owns. The
        // executor's own run:completed / run:failed emits are deliberately left
        // working: they are NOT wrapped in try/catch (pre-existing, out of
        // scope), so a bus that threw for everything would abort the run and
        // this test would be asserting that gap instead of this task's guard.
        const bus = {
            emit: vi.fn((e: { type: string }) => {
                if (e.type === 'run:event') throw new Error('bus exploded');
            }),
        };

        await executeAgentRun(makeRun() as never, bus as never);

        // Both boundaries were still attempted and persisted, and the run
        // completed cleanly despite every one of those emits throwing.
        expect(runEvents(bus)).toHaveLength(2);
        const recordedTools = mockRecordEvent.mock.calls
            .map(c => c[0])
            .filter(p => p.eventType === 'tool_result')
            .map(p => p.toolName);
        expect(recordedTools).toEqual(['a_tool', 'b_tool']);
        const statuses = mockUpdateRunStatus.mock.calls.map((c: unknown[]) => c[2]);
        expect(statuses).toContain('completed');
        expect(statuses).not.toContain('failed');
    });
});
