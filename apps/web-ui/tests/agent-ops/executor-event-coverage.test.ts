/**
 * Unit tests for executor timeline event coverage: memory_recall, memory_save, evaluation.
 *
 * Requirements: Agent Ops run-timeline redesign — Task 2
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mock functions so they are available inside vi.mock factories
// ---------------------------------------------------------------------------

const {
    mockUpdateRunStatus,
    mockRecordEvent,
    mockMkdir,
    mockRm,
    mockCreateDynamicExecutorGraph,
    mockGetMCPManager,
    mockGetSkillContent,
    mockLoadSkills,
    mockLoadAllSkillContent,
} = vi.hoisted(() => ({
    mockUpdateRunStatus: vi.fn().mockResolvedValue(undefined),
    mockRecordEvent: vi.fn().mockResolvedValue(undefined),
    mockMkdir: vi.fn().mockResolvedValue(undefined),
    mockRm: vi.fn().mockResolvedValue(undefined),
    mockCreateDynamicExecutorGraph: vi.fn(),
    mockGetMCPManager: vi.fn(),
    mockGetSkillContent: vi.fn().mockReturnValue(null),
    mockLoadSkills: vi.fn().mockResolvedValue([]),
    mockLoadAllSkillContent: vi.fn().mockResolvedValue(new Map()),
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

// No LLM provider is configured in the test env; stub resolution so the run
// reaches the event stream (the graph itself is mocked).
vi.mock('@/lib/agent/model-resolver', () => ({
    resolveDefaultModelConfig: vi.fn().mockResolvedValue({ provider: 'test', model: 'test-model' }),
    resolveModelConfig: vi.fn().mockResolvedValue({ provider: 'test', model: 'test-model' }),
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

function makeRun(overrides: Record<string, unknown> = {}) {
    return {
        runId: 'run-1', tenantId: 't1', taskDescription: 'task', threadId: 'th-1',
        source: 'api', mode: 'fast', autoApprove: true, ...overrides,
    } as never;
}

/** Graph mock whose streamEvents yields the given LangGraph events. */
function makeGraph(events: unknown[]) {
    return {
        streamEvents: () => (async function* () { for (const e of events) yield e; })(),
        getState: vi.fn().mockResolvedValue({ values: {}, next: [] }),
        getGraph: () => ({ drawMermaid: () => '' }),
    };
}

describe('executor event coverage', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetMCPManager.mockReturnValue({ connectServers: vi.fn() });
    });

    it('records memory_recall event with stats metadata', async () => {
        const stats = { phase: 'recall', facts: [{ key: 'k', distance: 0.2 }], rules: [], episodes: [], injected: true };
        mockCreateDynamicExecutorGraph.mockResolvedValue(makeGraph([
            { event: 'on_chain_end', metadata: { langgraph_node: 'memory_recall' }, data: { output: { memoryContext: 'x', memoryStats: stats } } },
        ]));
        await executeAgentRun(makeRun());
        const call = mockRecordEvent.mock.calls.find(c => c[0].eventType === 'memory_recall');
        expect(call).toBeDefined();
        expect(call![0].metadata).toEqual(stats);
        expect(call![0].content).toContain('1 fact');
    });

    it('records evaluation event with skill and KB metadata', async () => {
        const evaluation = {
            mode: 'fast', skillId: 'cost', skillName: 'Cost Analysis', accountId: null,
            requiresApproval: false, reasoning: 'cost task', clarificationQuestion: null,
            missingInfo: null, knowledgeBaseIds: ['kb1'],
        };
        mockCreateDynamicExecutorGraph.mockResolvedValue(makeGraph([
            { event: 'on_chain_end', metadata: { langgraph_node: 'evaluator' }, data: { output: { evaluation } } },
        ]));
        await executeAgentRun(makeRun());
        const call = mockRecordEvent.mock.calls.find(c => c[0].eventType === 'evaluation');
        expect(call).toBeDefined();
        expect(call![0].metadata).toMatchObject({
            mode: 'fast', skillId: 'cost', skillName: 'Cost Analysis',
            knowledgeBaseIds: ['kb1'], requiresApproval: false,
        });
    });

    it('does NOT record chat-model chatter from memory nodes', async () => {
        mockCreateDynamicExecutorGraph.mockResolvedValue(makeGraph([
            {
                event: 'on_chat_model_end', metadata: { langgraph_node: 'memory_recall' },
                data: { output: { content: 'internal filter output', usage_metadata: { input_tokens: 10, output_tokens: 5 } } },
            },
        ]));
        await executeAgentRun(makeRun());
        const chatter = mockRecordEvent.mock.calls.find(c => c[0].node === 'memory_recall' && c[0].eventType !== 'memory_recall');
        expect(chatter).toBeUndefined();
    });

    it('joins streamed text-delta content blocks without inserting newlines', async () => {
        // Bedrock streaming yields on_chat_model_end content as an array of
        // un-coalesced deltas; each delta already carries its own leading space.
        // Joining with '\n' shatters the text one delta per line — join with ''.
        mockCreateDynamicExecutorGraph.mockResolvedValue(makeGraph([
            {
                event: 'on_chat_model_end', metadata: { langgraph_node: 'generate' },
                data: {
                    output: {
                        content: [
                            { type: 'text', text: 'The' },
                            { type: 'text', text: ' request' },
                            { type: 'text', text: ' involves' },
                        ],
                    },
                },
            },
        ]));
        await executeAgentRun(makeRun());
        const call = mockRecordEvent.mock.calls.find(c => c[0].node === 'generate' && c[0].content);
        expect(call).toBeDefined();
        expect(call![0].content).toBe('The request involves');
        expect(call![0].content).not.toContain('\n');
    });

    it('does NOT record raw model text for nodes that emit a structured twin', async () => {
        // planner/evaluator/reflect each record a clean structured event at
        // on_chain_end; their raw on_chat_model_end text is a duplicate.
        mockCreateDynamicExecutorGraph.mockResolvedValue(makeGraph([
            {
                event: 'on_chat_model_end', metadata: { langgraph_node: 'reflect' },
                data: { output: { content: 'raw reflector JSON blob' } },
            },
        ]));
        await executeAgentRun(makeRun());
        const twin = mockRecordEvent.mock.calls.find(c => c[0].node === 'reflect');
        expect(twin).toBeUndefined();
    });
});
