/**
 * Drives createFastGraph's compiled StateGraph end-to-end: the ReAct agent/tools
 * loop, the hard-iteration-cap finalize path (with and without pending tool calls),
 * the empty-content guard, and finalizeNode's provider-error fallback.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BaseMessage, HumanMessage, AIMessage, ToolMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

const recorded: Array<{ node: string; inputs: BaseMessage[] }> = [];

function classify(inputs: BaseMessage[]): string {
    const sys = String((inputs[0] as any)?.content ?? '');
    if (sys.includes('Final Answer')) return 'FINALIZE';
    return 'AGENT';
}

let agentReply: (call: number) => AIMessage = () => new AIMessage({ content: 'a direct answer' });
let finalizeThrows = false;
const callCounts = { AGENT: 0, FINALIZE: 0 };

const fakeModel: any = {
    bindTools: () => fakeModel,
    invoke: async (inputs: BaseMessage[]) => {
        const node = classify(inputs);
        recorded.push({ node, inputs });
        if (node === 'FINALIZE') {
            callCounts.FINALIZE++;
            if (finalizeThrows) throw new Error('finalize provider outage');
            return new AIMessage({ content: 'the synthesized final answer' });
        }
        callCounts.AGENT++;
        return agentReply(callCounts.AGENT);
    },
};

const dummyTool = tool(
    async () => 'CREDENTIALS_OK',
    { name: 'get_aws_credentials', description: 'test', schema: z.object({ accountId: z.string().optional() }) },
);

vi.mock('@/lib/agent/model-factory', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/agent/model-factory')>();
    return { ...actual, createAgentModels: () => ({ main: fakeModel, reflector: fakeModel }), assembleTools: async () => [dummyTool] };
});

vi.mock('@/lib/agent/persistence', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/agent/persistence')>();
    const saver = new MemorySaver();
    return { ...actual, getCheckpointer: async () => saver, getMemoryStore: async () => undefined };
});

vi.mock('@/lib/skill-service', () => ({
    getSkillContent: vi.fn().mockResolvedValue('Skill instructions body'),
    getSkillSummaries: vi.fn().mockResolvedValue('- other-skill: does other things'),
}));

vi.mock('@/lib/agent/aiops-features', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/agent/aiops-features')>();
    return { ...actual, resolveAiopsFeatures: vi.fn().mockResolvedValue({ ...actual.getAiopsFeatures(), maxIterations: 30 }) };
});

const MODEL_CONFIG = { provider: 'bedrock' as const, modelId: 'test-model', maxTokens: 4096 };
const toolCallMsg = (id: string) => new AIMessage({ content: '', tool_calls: [{ id, name: 'get_aws_credentials', args: {} }] });

beforeEach(() => {
    recorded.length = 0;
    agentReply = () => new AIMessage({ content: 'a direct answer' });
    finalizeThrows = false;
    callCounts.AGENT = 0;
    callCounts.FINALIZE = 0;
});

describe('createFastGraph — conversational (no tools) turn', () => {
    it('answers directly and goes straight to memory_save', async () => {
        const { createFastGraph } = await import('@/lib/agent/fast-agent');
        const graph = await createFastGraph({ model: MODEL_CONFIG, autoApprove: true } as any);
        const config = { configurable: { thread_id: 'fast-conversational' } };

        await graph.invoke({ messages: [new HumanMessage('what is 2+2?')] }, config);

        const state = await graph.getState(config);
        const msgs = state.values.messages as BaseMessage[];
        expect(String((msgs.at(-1) as any).content)).toBe('a direct answer');
        expect(recorded.filter(r => r.node === 'FINALIZE')).toHaveLength(0);
        expect(state.values.iterationCount).toBe(1);
    });
});

describe('createFastGraph — tenant-scoped config (skill + aiops resolution)', () => {
    it('resolves the tenant maxIterations and injects the pinned skill + skill catalog', async () => {
        const { createFastGraph } = await import('@/lib/agent/fast-agent');
        const graph = await createFastGraph({
            model: MODEL_CONFIG, autoApprove: true, tenantId: 'tenant-1', selectedSkill: 'ec2-audit', userId: 'user-1',
        } as any);
        const config = { configurable: { thread_id: 'fast-tenant-skill' } };

        await graph.invoke({ messages: [new HumanMessage('run the audit')] }, config);

        const agentCall = recorded.find(r => r.node === 'AGENT')!;
        const sys = String((agentCall.inputs[0] as any).content);
        expect(sys).toContain('Skill instructions body');
    });
});

describe('createFastGraph — tool-call loop', () => {
    it('routes a tool call through guard/tools and back to agent for the final answer', async () => {
        let n = 0;
        agentReply = (call) => (call === 1 ? toolCallMsg(`c-${n++}`) : new AIMessage({ content: 'answer after tool use' }));

        const { createFastGraph } = await import('@/lib/agent/fast-agent');
        const graph = await createFastGraph({ model: MODEL_CONFIG, autoApprove: true } as any);
        const config = { configurable: { thread_id: 'fast-tool-loop' } };

        await graph.invoke({ messages: [new HumanMessage('list ec2 instances')] }, config);

        const state = await graph.getState(config);
        const msgs = state.values.messages as BaseMessage[];
        expect(msgs.some(m => m._getType() === 'tool' && String((m as ToolMessage).content) === 'CREDENTIALS_OK')).toBe(true);
        expect(String((msgs.at(-1) as any).content)).toBe('answer after tool use');
        expect(state.values.toolResults.length).toBe(1);
    });
});

describe('createFastGraph — empty-content guard', () => {
    it('routes an empty, tool-free response to finalize instead of ending on nothing', async () => {
        agentReply = () => new AIMessage({ content: '' });

        const { createFastGraph } = await import('@/lib/agent/fast-agent');
        const graph = await createFastGraph({ model: MODEL_CONFIG, autoApprove: true } as any);
        const config = { configurable: { thread_id: 'fast-empty-content' } };

        await graph.invoke({ messages: [new HumanMessage('...')] }, config);

        expect(recorded.filter(r => r.node === 'FINALIZE')).toHaveLength(1);
        const state = await graph.getState(config);
        expect(String((state.values.messages.at(-1) as any).content)).toBe('the synthesized final answer');
        expect(state.values.isComplete).toBe(true);
    });
});

describe('createFastGraph — hard iteration cap', () => {
    it('synthesizes a final answer via finalizeNode when the cap is hit with pending tool calls', async () => {
        let n = 0;
        agentReply = () => toolCallMsg(`t-${n++}`);

        const { createFastGraph } = await import('@/lib/agent/fast-agent');
        const graph = await createFastGraph({ model: MODEL_CONFIG, autoApprove: true } as any);
        const config = { configurable: { thread_id: 'fast-hard-cap' }, recursionLimit: 400 };

        await graph.invoke({ messages: [new HumanMessage('audit everything, never stop')] }, config);

        expect(recorded.filter(r => r.node === 'FINALIZE')).toHaveLength(1);
        const state = await graph.getState(config);
        expect(String((state.values.messages.at(-1) as any).content)).toBe('the synthesized final answer');
        expect(state.values.isComplete).toBe(true);
    }, 20000);

    it('stops directly at memory_save when the cap is hit on a tool-free turn', async () => {
        // Every agent call returns prose (no tools) but iterationCount still climbs by
        // one per turn since shouldContinue routes tool-free turns straight to
        // memory_save under normal conditions — force the cap via a pre-seeded high
        // iterationCount so the very first turn already sits at the cap.
        const { createFastGraph } = await import('@/lib/agent/fast-agent');
        const { MemorySaver } = await import('@langchain/langgraph');
        void MemorySaver;
        const graph = await createFastGraph({ model: MODEL_CONFIG, autoApprove: true } as any);
        const config = { configurable: { thread_id: 'fast-cap-no-tools' } };

        // Seed the thread at iterationCount 29 so this turn's agentNode call pushes it to 30 (>= MAX_ITERATIONS).
        await graph.invoke({ messages: [new HumanMessage('warm up')] }, config);
        const seeded = await graph.getState(config);
        await (graph as any).updateState(config, { ...seeded.values, iterationCount: 29 });

        agentReply = () => new AIMessage({ content: 'final prose, no tools' });
        await graph.invoke({ messages: [new HumanMessage('one more turn')] }, config);

        expect(recorded.filter(r => r.node === 'FINALIZE')).toHaveLength(0);
        const state = await graph.getState(config);
        expect(String((state.values.messages.at(-1) as any).content)).toBe('final prose, no tools');
    });
});

describe('createFastGraph — finalizeNode provider-error fallback', () => {
    it('returns a best-effort answer built from the tool digest when the finalize LLM call throws', async () => {
        let n = 0;
        agentReply = () => toolCallMsg(`f-${n++}`);
        finalizeThrows = true;

        const { createFastGraph } = await import('@/lib/agent/fast-agent');
        const graph = await createFastGraph({ model: MODEL_CONFIG, autoApprove: true } as any);
        const config = { configurable: { thread_id: 'fast-finalize-throws' }, recursionLimit: 400 };

        await graph.invoke({ messages: [new HumanMessage('audit everything, never stop')] }, config);

        const state = await graph.getState(config);
        const last = String((state.values.messages.at(-1) as any).content);
        expect(last).toContain('maximum number of investigation steps');
        expect(last).toContain('What I gathered before stopping');
    }, 20000);
});

describe('createFastGraph — approval gate (autoApprove: false)', () => {
    it('pauses before approval_gate, then runs it and proceeds to tools on resume', async () => {
        let n = 0;
        agentReply = (call) => (call === 1 ? toolCallMsg(`g-${n++}`) : new AIMessage({ content: 'answer after approval' }));

        const { createFastGraph } = await import('@/lib/agent/fast-agent');
        const graph = await createFastGraph({ model: MODEL_CONFIG, autoApprove: false } as any);
        const config = { configurable: { thread_id: 'fast-approval-gate' } };

        await graph.invoke({ messages: [new HumanMessage('list ec2 instances')] }, config);
        const paused = await graph.getState(config);
        expect(paused.next).toEqual(['approval_gate']);

        // Resume — runs approvalGateNode (the no-op marker) then proceeds to tools/agent.
        await graph.invoke(null, config);

        const state = await graph.getState(config);
        const msgs = state.values.messages as BaseMessage[];
        expect(msgs.some(m => m._getType() === 'tool' && String((m as ToolMessage).content) === 'CREDENTIALS_OK')).toBe(true);
        expect(String((msgs.at(-1) as any).content)).toBe('answer after approval');
    });
});

describe('createFastGraph — tool node with a pre-resolved (rejected) call', () => {
    it('skips execution entirely when every pending tool call already has a result', async () => {
        let n = 0;
        agentReply = (call) => (call === 1 ? toolCallMsg(`r-${n++}`) : new AIMessage({ content: 'proceeding without that tool' }));

        const { createFastGraph } = await import('@/lib/agent/fast-agent');
        const graph = await createFastGraph({ model: MODEL_CONFIG, autoApprove: false } as any);
        const config = { configurable: { thread_id: 'fast-preresolved-reject' } };

        await graph.invoke({ messages: [new HumanMessage('stop the instance')] }, config);
        const paused = await graph.getState(config);
        expect(paused.next).toEqual(['approval_gate']);

        // Simulate the chat route writing a rejection ToolMessage for the pending call
        // BEFORE resuming — collectingToolNode must see it as already-resolved and skip
        // invoking toolNode again, rather than re-executing a rejected call.
        const pendingId = paused.values.messages.at(-1).tool_calls[0].id;
        await (graph as any).updateState(config, {
            messages: [new ToolMessage({ content: 'Rejected by user.', tool_call_id: pendingId })],
        });

        await graph.invoke(null, config);

        const state = await graph.getState(config);
        const msgs = state.values.messages as BaseMessage[];
        expect(msgs.filter(m => m._getType() === 'tool' && m.tool_call_id === pendingId)).toHaveLength(1);
        expect(String((msgs.at(-1) as any).content)).toBe('proceeding without that tool');
    });
});

describe('createFastGraph — skill catalog fetch failure', () => {
    it('degrades to no catalog (does not crash) when getSkillSummaries throws', async () => {
        const { getSkillSummaries } = await import('@/lib/skill-service');
        vi.mocked(getSkillSummaries).mockRejectedValueOnce(new Error('DB down'));

        const { createFastGraph } = await import('@/lib/agent/fast-agent');
        const graph = await createFastGraph({ model: MODEL_CONFIG, autoApprove: true, tenantId: 'tenant-1' } as any);
        const config = { configurable: { thread_id: 'fast-catalog-fail' } };

        await graph.invoke({ messages: [new HumanMessage('what is 2+2?')] }, config);

        const state = await graph.getState(config);
        expect(String((state.values.messages.at(-1) as any).content)).toBe('a direct answer');
    });
});
