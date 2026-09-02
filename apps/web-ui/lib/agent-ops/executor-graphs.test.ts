import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemorySaver } from '@langchain/langgraph';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';

// ── Hoisted mocks (referenced inside vi.mock factories below) ────────────────
const { mockMainInvoke, mockReflectorInvoke, mockToolsInvoke, mockToolNodeInvoke } = vi.hoisted(() => ({
    mockMainInvoke: vi.fn(),
    mockReflectorInvoke: vi.fn(),
    mockToolsInvoke: vi.fn(),
    mockToolNodeInvoke: vi.fn(),
}));

// ToolNode is constructed with `new` — mock as a function-based class per this
// repo's AWS-SDK-v3 mocking convention (arrow functions can't be `new`-ed).
vi.mock('@langchain/langgraph/prebuilt', () => ({
    ToolNode: vi.fn().mockImplementation(function (this: any, tools: any) {
        this.tools = tools;
        this.invoke = mockToolNodeInvoke;
    }),
}));

vi.mock('@/lib/agent/model-factory', () => ({
    createAgentModels: vi.fn(() => ({
        main: { invoke: mockMainInvoke, bindTools: () => ({ invoke: mockToolsInvoke }) },
        reflector: { invoke: mockReflectorInvoke },
    })),
    assembleTools: vi.fn().mockResolvedValue([]),
    createMemoryTools: vi.fn().mockReturnValue([]),
}));

// Real MemorySaver — a genuine in-memory LangGraph checkpointer, so `.invoke()`
// exercises the real interrupt/resume machinery instead of a hand-rolled stub.
vi.mock('@/lib/agent/persistence', () => ({
    getCheckpointer: vi.fn(async () => new MemorySaver()),
    getMemoryStore: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/agent/memory-nodes', () => ({
    createMemoryRecallNode: vi.fn(() => async () => ({})),
    createMemorySaveNode: vi.fn(() => async () => ({})),
}));

// Skill loading hits the repository factory's runtime require(), which vitest's
// transform can't resolve — irrelevant to this test, so it's mocked out.
vi.mock('@/lib/skill-service', () => ({
    loadSkills: vi.fn().mockResolvedValue([{ id: 'swe', name: 'SWE Mode', description: 'Software engineering' }]),
    loadAllSkillContent: vi.fn().mockResolvedValue(new Map([['swe', 'SWE skill content']])),
}));

vi.mock('@/lib/agent/auto-kb-select', () => ({
    resolveKnowledgeBaseIds: vi.fn().mockResolvedValue([]),
}));

import { createDynamicExecutorGraph } from './executor-graphs';

function aiMessage(content: string, tool_calls: any[] = []) {
    return new AIMessage({ content, tool_calls });
}

const BASE_CONFIG = {
    model: { provider: 'bedrock', modelId: 'm', accessKeyId: 'x', secretAccessKey: 'x', region: 'us-east-1' },
    autoApprove: true,
    accounts: [{ accountId: '111111111111', accountName: 'Prod' }],
    tenantId: 't1',
    userId: 'u1',
};

let threadCounter = 0;
function nextConfig(extra: Record<string, any> = {}) {
    return { configurable: { thread_id: `thread-${++threadCounter}` }, ...extra };
}

describe('createDynamicExecutorGraph', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockToolNodeInvoke.mockResolvedValue({ messages: [] });
    });

    it('routes to clarify when the evaluator is ambiguous, with a custom clarification question', async () => {
        mockMainInvoke.mockResolvedValueOnce(aiMessage(JSON.stringify({
            mode: 'end', clarificationQuestion: 'Which AWS account should I use?',
        })));

        const graph = await createDynamicExecutorGraph(BASE_CONFIG as any);
        const result = await graph.invoke({ messages: [new HumanMessage('do the thing')] }, nextConfig());

        expect(result.clarificationQuestion).toBe('Which AWS account should I use?');
        expect(result.nextAction).toBe('awaiting_input');
        expect(result.evaluation.mode).toBe('end');
    });

    it('falls back to the default clarification question when the evaluator omits one', async () => {
        mockMainInvoke.mockResolvedValueOnce(aiMessage(JSON.stringify({ mode: 'end' })));

        const graph = await createDynamicExecutorGraph(BASE_CONFIG as any);
        const result = await graph.invoke({ messages: [new HumanMessage('??')] }, nextConfig());

        expect(result.clarificationQuestion).toContain('need more information');
    });

    it('resolves a matched skillId to its skillName and coerces unknown mode to plan', async () => {
        mockMainInvoke
            .mockResolvedValueOnce(aiMessage(JSON.stringify({
                mode: 'fast', skillId: 'swe', requiresApproval: false, reasoning: 'go',
            })))
            .mockResolvedValueOnce(aiMessage(JSON.stringify(['Do the swe task'])))
            .mockResolvedValueOnce(aiMessage('All done, final summary.'));
        mockToolsInvoke.mockResolvedValueOnce(aiMessage('SWE step complete.'));

        const graph = await createDynamicExecutorGraph(BASE_CONFIG as any);
        const result = await graph.invoke({ messages: [new HumanMessage('refactor the module')] }, nextConfig());

        expect(result.evaluation.mode).toBe('plan');
        expect(result.evaluation.skillName).toBe('SWE Mode');
        expect(result.isComplete).toBe(true);
    });

    it('falls back to a single default plan step and a default evaluation when both LLM responses are unparsable', async () => {
        mockMainInvoke
            .mockResolvedValueOnce(aiMessage('not json at all'))
            .mockResolvedValueOnce(aiMessage('still not json'))
            .mockResolvedValueOnce(aiMessage('Final summary.'));
        mockToolsInvoke.mockResolvedValueOnce(aiMessage('Answered directly.'));

        const graph = await createDynamicExecutorGraph(BASE_CONFIG as any);
        const result = await graph.invoke({ messages: [new HumanMessage('hello')] }, nextConfig());

        expect(result.evaluation.reasoning).toBe('Fallback to plan mode.');
        // generateNode marks the first pending step in_progress once it runs a turn.
        expect(result.plan).toEqual([{ step: 'Analyze and respond to user request', status: 'in_progress' }]);
        expect(result.isComplete).toBe(true);
    });

    it('skips re-evaluation when a reusable (non-clarification) evaluation is already checkpointed', async () => {
        // planNode always re-plans regardless of a pre-existing plan — only the
        // evaluator LLM call is skipped by isReusableEvaluation.
        mockMainInvoke
            .mockResolvedValueOnce(aiMessage(JSON.stringify(['Re-planned step'])))
            .mockResolvedValueOnce(aiMessage('Final summary.'));
        mockToolsInvoke.mockResolvedValueOnce(aiMessage('Answered directly.'));

        const graph = await createDynamicExecutorGraph(BASE_CONFIG as any);
        const result = await graph.invoke({
            messages: [new HumanMessage('resume this')],
            evaluation: {
                mode: 'plan', skillId: null, accountId: null, requiresApproval: false,
                reasoning: 'preexisting', clarificationQuestion: null, missingInfo: null,
            },
            plan: [{ step: 'Preexisting step', status: 'pending' }],
        } as any, nextConfig());

        // A real evaluator call would have produced a JSON-parsed (or fallback)
        // reasoning string, not the exact preseeded value — proving it never ran.
        expect(result.evaluation.reasoning).toBe('preexisting');
        expect(mockMainInvoke).toHaveBeenCalledTimes(2); // planner + final only
    });

    it('executes a non-error tool call, reflects to completion, and finalizes', async () => {
        mockMainInvoke
            .mockResolvedValueOnce(aiMessage(JSON.stringify({ mode: 'plan', requiresApproval: false })))
            .mockResolvedValueOnce(aiMessage(JSON.stringify(['List EC2 instances'])))
            .mockResolvedValueOnce(aiMessage('Final delivery note.'));
        mockToolsInvoke
            .mockResolvedValueOnce(aiMessage('calling a tool', [{ name: 'describe_instances', args: {}, id: 'call1' }]))
            .mockResolvedValueOnce(aiMessage('Summarized the instances.'));
        mockToolNodeInvoke.mockResolvedValueOnce({
            messages: [new ToolMessage({ content: '[{"InstanceId":"i-1"}]', tool_call_id: 'call1', name: 'describe_instances' })],
        });
        mockReflectorInvoke.mockResolvedValueOnce(aiMessage(JSON.stringify({
            analysis: 'Looks complete', issues: 'None', isComplete: true,
            updatedPlan: [{ step: 'List EC2 instances', status: 'completed' }],
        })));

        const graph = await createDynamicExecutorGraph(BASE_CONFIG as any);
        const result = await graph.invoke({ messages: [new HumanMessage('list my instances')] }, nextConfig());

        expect(result.toolResults).toEqual([
            expect.objectContaining({ toolName: 'describe_instances', isError: false }),
        ]);
        expect(result.plan[0].status).toBe('completed');
        expect(result.isComplete).toBe(true);
    });

    it('marks a tool result containing "error" as an error result', async () => {
        mockMainInvoke
            .mockResolvedValueOnce(aiMessage(JSON.stringify({ mode: 'plan' })))
            .mockResolvedValueOnce(aiMessage(JSON.stringify(['Do a thing'])))
            .mockResolvedValueOnce(aiMessage('Final note.'));
        mockToolsInvoke
            .mockResolvedValueOnce(aiMessage('calling', [{ name: 'describe_instances', args: {}, id: 'call1' }]))
            .mockResolvedValueOnce(aiMessage('done'));
        mockToolNodeInvoke.mockResolvedValueOnce({
            messages: [new ToolMessage({ content: 'AccessDenied: an error occurred', tool_call_id: 'call1', name: 'describe_instances' })],
        });
        mockReflectorInvoke.mockResolvedValueOnce(aiMessage(JSON.stringify({ issues: 'None', isComplete: true })));

        const graph = await createDynamicExecutorGraph(BASE_CONFIG as any);
        const result = await graph.invoke({ messages: [new HumanMessage('do it')] }, nextConfig());

        expect(result.toolResults[0].isError).toBe(true);
    });

    it('reports an empty reflector response as EMPTY_REFLECTION rather than looping silently', async () => {
        mockMainInvoke
            .mockResolvedValueOnce(aiMessage(JSON.stringify({ mode: 'plan' })))
            .mockResolvedValueOnce(aiMessage(JSON.stringify(['One step'])))
            .mockResolvedValueOnce(aiMessage('Final wrap-up.'));
        // generate's turn, then revise's turn (an empty first reflection routes to revise)
        mockToolsInvoke
            .mockResolvedValueOnce(aiMessage('a reply with no tool calls'))
            .mockResolvedValueOnce(aiMessage('revised reply, no tools'));
        mockReflectorInvoke
            .mockResolvedValueOnce(aiMessage(''))
            .mockResolvedValueOnce(aiMessage(JSON.stringify({ issues: 'None', isComplete: true })));

        const graph = await createDynamicExecutorGraph({ ...BASE_CONFIG, maxIterations: 5 } as any);
        // iterationCount starts at 0; a single generate call brings it to 1, which
        // routeFromGenerate sends straight to 'final' (iterationCount <= 1). To
        // reach 'reflect' instead, seed iterationCount so the post-generate count > 1.
        const result = await graph.invoke({
            messages: [new HumanMessage('go')],
            iterationCount: 1,
        } as any, nextConfig());

        // The empty-reflection message survives the reducer even though the second,
        // successful reflection reported no issues (issues: 'None' → [] doesn't overwrite).
        expect(result.reflection).toContain('Reflector returned no text output.');
        expect(result.errors).toEqual(['EMPTY_REFLECTION: reflector produced no text']);
        expect(result.isComplete).toBe(true);
    });

    it('revises when the reflector reports unresolved issues, then completes on the next pass', async () => {
        mockMainInvoke
            .mockResolvedValueOnce(aiMessage(JSON.stringify({ mode: 'plan' })))
            .mockResolvedValueOnce(aiMessage(JSON.stringify(['Step A'])))
            .mockResolvedValueOnce(aiMessage('Final.'));
        mockToolsInvoke
            .mockResolvedValueOnce(aiMessage('first attempt, no tools'))
            // reviseNode's own modelWithTools.invoke call:
            .mockResolvedValueOnce(aiMessage('revised, no tools'));
        mockReflectorInvoke
            .mockResolvedValueOnce(aiMessage(JSON.stringify({ issues: 'Missing --output json', isComplete: false })))
            .mockResolvedValueOnce(aiMessage(JSON.stringify({ issues: 'None', isComplete: true })));

        const graph = await createDynamicExecutorGraph({ ...BASE_CONFIG, maxIterations: 10 } as any);
        const result = await graph.invoke({
            messages: [new HumanMessage('go')],
            iterationCount: 1, // forces the first generate's routeFromGenerate to 'reflect', not 'final'
        } as any, nextConfig());

        expect(result.isComplete).toBe(true);
        expect(mockMainInvoke).toHaveBeenCalledTimes(3);
    });

    it('gates a mutative tool call behind the mutative_approval_gate when autoApprove is false, then runs the gate node on resume', async () => {
        // requiresApproval:false keeps the plan-level approval_gate out of the way
        // entirely, isolating the per-tool mutative gate under test. The tool name
        // uses a hyphen (not underscore) so it actually trips the classifier's
        // `\bstop\b`-style word-boundary regex — `_` is a \w character in JS regex,
        // so a real "stop_instance"-style name would NOT match (untested edge of
        // tool-classifier.ts, out of this fork's scope).
        mockMainInvoke
            .mockResolvedValueOnce(aiMessage(JSON.stringify({ mode: 'plan', requiresApproval: false })))
            .mockResolvedValueOnce(aiMessage(JSON.stringify(['Stop the instance'])));
        mockToolsInvoke.mockResolvedValueOnce(aiMessage('stopping', [{ name: 'stop-instance', args: { id: 'i-1' }, id: 'call1' }]));

        const graph = await createDynamicExecutorGraph({ ...BASE_CONFIG, autoApprove: false } as any);
        const config = nextConfig();
        const interrupted = await graph.invoke({ messages: [new HumanMessage('stop it')] }, config);
        // Halted BEFORE mutative_approval_gate ran — the mutative tool call never
        // reached collectingToolNode, and its body hasn't set anything yet.
        expect(mockToolNodeInvoke).not.toHaveBeenCalled();
        expect(interrupted.pendingToolApprovals).toEqual([]);

        // Resume past the interrupt (no new input) — LangGraph continues forward
        // into mutativeApprovalGateNode's own body.
        const resumed = await graph.invoke(null, config);
        expect(resumed.pendingToolApprovals).toEqual(['stop-instance']);
        expect(resumed.nextAction).toBe('awaiting_tool_approval');
        expect(resumed.approvalStatus).toBe('pending');
    });

    it('runs mutative tools without gating when autoApprove is true', async () => {
        mockMainInvoke
            .mockResolvedValueOnce(aiMessage(JSON.stringify({ mode: 'plan' })))
            .mockResolvedValueOnce(aiMessage(JSON.stringify(['Delete the bucket'])))
            .mockResolvedValueOnce(aiMessage('Final.'));
        mockToolsInvoke
            .mockResolvedValueOnce(aiMessage('deleting', [{ name: 'delete_bucket', args: {}, id: 'call1' }]))
            .mockResolvedValueOnce(aiMessage('deleted'));
        mockToolNodeInvoke.mockResolvedValueOnce({
            messages: [new ToolMessage({ content: 'ok', tool_call_id: 'call1', name: 'delete_bucket' })],
        });
        mockReflectorInvoke.mockResolvedValueOnce(aiMessage(JSON.stringify({ isComplete: true })));

        const graph = await createDynamicExecutorGraph(BASE_CONFIG as any);
        const result = await graph.invoke({ messages: [new HumanMessage('delete it')] }, nextConfig());

        expect(result.toolResults[0].toolName).toBe('delete_bucket');
        expect(result.isComplete).toBe(true);
    });

    it('ends the run once the iteration budget is exhausted mid-tool-loop', async () => {
        mockMainInvoke.mockResolvedValueOnce(aiMessage(JSON.stringify({ mode: 'plan' })));
        mockMainInvoke.mockResolvedValueOnce(aiMessage(JSON.stringify(['Loop step'])));
        mockMainInvoke.mockResolvedValueOnce(aiMessage('Final wrap-up.'));
        mockToolsInvoke.mockResolvedValue(aiMessage('again', [{ name: 'describe_instances', args: {}, id: 'callN' }]));
        mockToolNodeInvoke.mockResolvedValue({
            messages: [new ToolMessage({ content: 'ok', tool_call_id: 'callN', name: 'describe_instances' })],
        });
        mockReflectorInvoke.mockResolvedValue(aiMessage(JSON.stringify({ issues: 'None', isComplete: false })));

        const graph = await createDynamicExecutorGraph({ ...BASE_CONFIG, maxIterations: 1 } as any);
        const result = await graph.invoke({ messages: [new HumanMessage('go')] }, nextConfig());

        // routeFromTools sends straight to reflect once iterationCount >= max,
        // and reflect force-completes once iterationCount >= max.
        expect(result.isComplete).toBe(true);
    });

    it('resolveKnowledgeBaseIds failures are swallowed to an empty array', async () => {
        const { resolveKnowledgeBaseIds } = await import('@/lib/agent/auto-kb-select');
        vi.mocked(resolveKnowledgeBaseIds).mockRejectedValueOnce(new Error('embedding service down'));
        mockMainInvoke
            .mockResolvedValueOnce(aiMessage(JSON.stringify({ mode: 'plan' })))
            .mockResolvedValueOnce(aiMessage(JSON.stringify(['A step'])))
            .mockResolvedValueOnce(aiMessage('Final.'));
        mockToolsInvoke.mockResolvedValueOnce(aiMessage('done, no tools'));

        const graph = await createDynamicExecutorGraph(BASE_CONFIG as any);
        const result = await graph.invoke({ messages: [new HumanMessage('go')] }, nextConfig());

        expect(result.evaluation.knowledgeBaseIds).toEqual([]);
    });

    it('injects knowledge-base context into the generate prompt when KB ids are resolved', async () => {
        const { resolveKnowledgeBaseIds } = await import('@/lib/agent/auto-kb-select');
        vi.mocked(resolveKnowledgeBaseIds).mockResolvedValueOnce(['kb-1']);
        mockMainInvoke
            .mockResolvedValueOnce(aiMessage(JSON.stringify({ mode: 'plan' })))
            .mockResolvedValueOnce(aiMessage(JSON.stringify(['A step'])))
            .mockResolvedValueOnce(aiMessage('Final.'));
        mockToolsInvoke.mockResolvedValueOnce(aiMessage('done, no tools'));

        const graph = await createDynamicExecutorGraph({ ...BASE_CONFIG, knowledgeBaseIds: ['kb-1'] } as any);
        const result = await graph.invoke({ messages: [new HumanMessage('go')] }, nextConfig());

        expect(result.evaluation.knowledgeBaseIds).toEqual(['kb-1']);
        const generatePrompt = mockToolsInvoke.mock.calls[0][0][0].content as string;
        expect(generatePrompt).toContain('Knowledge Base Context');
    });

    it('compiles without interruptBefore when autoApprove is true, and with it when false', async () => {
        const autoApproved = await createDynamicExecutorGraph(BASE_CONFIG as any);
        const gated = await createDynamicExecutorGraph({ ...BASE_CONFIG, autoApprove: false } as any);

        expect((autoApproved as any).interruptBefore ?? []).toEqual([]);
        expect((gated as any).interruptBefore).toEqual(
            expect.arrayContaining(['approval_gate', 'mutative_approval_gate']),
        );
    });
});
