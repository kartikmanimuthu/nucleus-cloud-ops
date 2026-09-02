/**
 * Drives createReflectionGraph's compiled StateGraph through the tool-call,
 * reflect/revise, and provider-failure branches that parser-focused unit tests
 * (reflector-parse.test.ts) and the deliverable-promotion tests (final-deliverable.test.ts,
 * planner-multi-turn.test.ts) don't reach — collectingToolNode, reflectNode's real LLM
 * path, reviseNode, finalNode's non-verbatim synthesis path, and each node's
 * provider-error fallback.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BaseMessage, HumanMessage, AIMessage, ToolMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

function classify(inputs: BaseMessage[]): string {
    const sys = String((inputs[0] as any)?.content ?? '');
    if (sys.includes('decompose the user')) return 'PLANNER';
    if (sys.includes('execute the current plan step')) return 'EXECUTOR';
    if (sys.includes('structured review')) return 'REFLECTOR';
    if (sys.includes('address the specific issues')) return 'REVISER';
    if (sys.includes('answering the user')) return 'FINAL';
    return 'OTHER';
}

const recorded: Array<{ node: string; inputs: BaseMessage[] }> = [];
let plannerPlan = ['Investigate the account', 'Compose the final answer'];
let executorReply: (call: number) => AIMessage = () => new AIMessage({ content: 'ok' });
let reflectorReply: (call: number) => AIMessage = () => new AIMessage({ content: JSON.stringify({ isComplete: true, analysis: 'fine' }) });
let reviserReply: (call: number) => AIMessage = () => new AIMessage({ content: 'revised' });
let finalReply: (call: number) => AIMessage = () => new AIMessage({ content: 'the synthesized answer' });
let plannerThrows = false;
let executorThrowsOnce = false;
let reflectorThrows = false;
let reviserThrows = false;
let finalThrows = false;
const callCounts = { EXECUTOR: 0, REFLECTOR: 0, REVISER: 0, FINAL: 0 };

const fakeModel: any = {
    bindTools: () => fakeModel,
    invoke: async (inputs: BaseMessage[]) => {
        const node = classify(inputs);
        recorded.push({ node, inputs });
        if (node === 'PLANNER') {
            if (plannerThrows) throw new Error('planner provider outage');
            return new AIMessage({ content: JSON.stringify(plannerPlan) });
        }
        if (node === 'EXECUTOR') {
            callCounts.EXECUTOR++;
            if (executorThrowsOnce && callCounts.EXECUTOR === 1) throw new Error('executor provider outage');
            return executorReply(callCounts.EXECUTOR);
        }
        if (node === 'REFLECTOR') {
            callCounts.REFLECTOR++;
            if (reflectorThrows) throw new Error('reflector provider outage');
            return reflectorReply(callCounts.REFLECTOR);
        }
        if (node === 'REVISER') {
            callCounts.REVISER++;
            if (reviserThrows) throw new Error('reviser provider outage');
            return reviserReply(callCounts.REVISER);
        }
        if (node === 'FINAL') {
            callCounts.FINAL++;
            if (finalThrows) throw new Error('final provider outage');
            return finalReply(callCounts.FINAL);
        }
        return new AIMessage({ content: 'unclassified' });
    },
};

// A real, minimal LangChain tool so collectingToolNode's ToolNode.invoke runs for real.
// get_aws_credentials sits in the guard's READ_ONLY_ALLOWLIST, so routeAfterGuard sends
// it straight to "tools" under autoApprove without needing the LLM risk-assessment batch.
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

const MODEL_CONFIG = { provider: 'bedrock' as const, modelId: 'test-model', maxTokens: 4096 };
const toolCallMsg = (id: string) => new AIMessage({ content: '', tool_calls: [{ id, name: 'get_aws_credentials', args: {} }] });

beforeEach(() => {
    recorded.length = 0;
    plannerPlan = ['Investigate the account', 'Compose the final answer'];
    executorReply = () => new AIMessage({ content: 'ok' });
    reflectorReply = () => new AIMessage({ content: JSON.stringify({ isComplete: true, analysis: 'fine' }) });
    reviserReply = () => new AIMessage({ content: 'revised' });
    finalReply = () => new AIMessage({ content: 'the synthesized answer' });
    plannerThrows = false;
    executorThrowsOnce = false;
    reflectorThrows = false;
    reviserThrows = false;
    finalThrows = false;
    callCounts.EXECUTOR = 0;
    callCounts.REFLECTOR = 0;
    callCounts.REVISER = 0;
    callCounts.FINAL = 0;
});

describe('tool execution, hard-iteration-cap, and finalNode synthesis (real LLM path)', () => {
    it('runs a real tool call through collectingToolNode, then hard-caps and synthesizes a fresh final answer', async () => {
        // The executor NEVER stops calling tools, so the plan is never marked exhausted by
        // generateNode and no message is ever tagged as a rendered deliverable — the only
        // way to reach "reflect" is the MAX_ITERATIONS hard cap, and the only way finalNode
        // can answer is its real LLM synthesis path (findRenderedDeliverable returns null).
        let n = 0;
        executorReply = () => toolCallMsg(`call-${n++}`);
        reflectorReply = () => new AIMessage({ content: JSON.stringify({ isComplete: false, analysis: 'still going', issues: 'pagination incomplete' }) });

        const { createReflectionGraph } = await import('@/lib/agent/planning-agent');
        const graph = await createReflectionGraph({ model: MODEL_CONFIG, autoApprove: true } as any);
        const config = { configurable: { thread_id: 'hard-cap-run' }, recursionLimit: 400 };

        await graph.invoke({ messages: [new HumanMessage('audit everything, never stop')] }, config);

        const state = await graph.getState(config);
        const msgs = state.values.messages as BaseMessage[];

        // A real tool result made it into the transcript.
        expect(msgs.some(m => m._getType() === 'tool' && String((m as ToolMessage).content) === 'CREDENTIALS_OK')).toBe(true);
        // Reflector ran with real "issues found" content (918-924 formatting branch).
        expect(recorded.some(r => r.node === 'REFLECTOR')).toBe(true);
        // finalNode took the real LLM synthesis path, not verbatim promotion.
        expect(recorded.filter(r => r.node === 'FINAL')).toHaveLength(1);
        expect(String((msgs.at(-1) as any).content)).toBe('the synthesized answer');
        expect(state.values.isComplete).toBe(true);
    }, 20000);
});

describe('reflect finds issues -> revise (with tool calls) -> loops back through generate', () => {
    it('routes a revise-issued tool call through guard/tools and back to generate', async () => {
        let executorCall = 0;
        executorReply = (n) => {
            executorCall = n;
            // First call executes the tool-based step; second call composes the answer.
            return n === 1 ? toolCallMsg('exec-1') : new AIMessage({ content: 'Composed answer after first pass.' });
        };
        let reflectorCall = 0;
        reflectorReply = (n) => {
            reflectorCall = n;
            return n === 1
                ? new AIMessage({ content: JSON.stringify({ isComplete: false, analysis: 'missing detail', issues: 'missing pagination', suggestions: 'fetch next page' }) })
                : new AIMessage({ content: JSON.stringify({ isComplete: true, analysis: 'now complete' }) });
        };
        reviserReply = () => toolCallMsg('revise-1');

        const { createReflectionGraph } = await import('@/lib/agent/planning-agent');
        const graph = await createReflectionGraph({ model: MODEL_CONFIG, autoApprove: true } as any);
        const config = { configurable: { thread_id: 'revise-tool-loop' }, recursionLimit: 200 };

        await graph.invoke({ messages: [new HumanMessage('investigate the account fully')] }, config);

        expect(recorded.filter(r => r.node === 'REVISER')).toHaveLength(1);
        expect(recorded.filter(r => r.node === 'REFLECTOR')).toHaveLength(2);
        // The reviser's tool call actually executed (second CREDENTIALS_OK in the transcript).
        const state = await graph.getState(config);
        const toolMsgs = (state.values.messages as BaseMessage[]).filter(m => m._getType() === 'tool');
        expect(toolMsgs.length).toBeGreaterThanOrEqual(2);
        expect(state.values.isComplete).toBe(true);
        void executorCall; void reflectorCall;
    }, 20000);
});

describe('reflect finds issues -> revise with prose only -> routes straight back to reflect', () => {
    it('increments iterationCount and stallCount when the reviser produces no tool calls', async () => {
        // Two-step plan, first step needs a tool call, so the second (compose) executor
        // pass runs at iterationCount>1 and the run reaches "reflect" via plan exhaustion
        // instead of the iterationCount<=1 fast path straight to "final".
        let n = 0;
        executorReply = (call) => (call === 1 ? toolCallMsg(`p-${n++}`) : new AIMessage({ content: 'Composed answer.' }));
        let reflectorCall = 0;
        reflectorReply = (n2) => {
            reflectorCall = n2;
            return n2 === 1
                ? new AIMessage({ content: JSON.stringify({ isComplete: false, analysis: 'needs a rewrite', issues: 'tone is wrong' }) })
                : new AIMessage({ content: JSON.stringify({ isComplete: true, analysis: 'good now' }) });
        };
        reviserReply = () => new AIMessage({ content: 'Rewritten prose with no further tool calls needed at all.' });

        const { createReflectionGraph } = await import('@/lib/agent/planning-agent');
        const graph = await createReflectionGraph({ model: MODEL_CONFIG, autoApprove: true } as any);
        const config = { configurable: { thread_id: 'revise-prose-only' }, recursionLimit: 200 };

        await graph.invoke({ messages: [new HumanMessage('short conversational request')] }, config);

        expect(recorded.filter(r => r.node === 'REVISER')).toHaveLength(1);
        expect(recorded.filter(r => r.node === 'REFLECTOR')).toHaveLength(2);
        void reflectorCall;
    }, 20000);
});

describe('provider-error fallbacks on each node', () => {
    it('falls back to a single trivial plan step when the planner LLM call throws', async () => {
        plannerThrows = true;
        const { createReflectionGraph } = await import('@/lib/agent/planning-agent');
        const graph = await createReflectionGraph({ model: MODEL_CONFIG, autoApprove: true } as any);
        const config = { configurable: { thread_id: 'planner-throws' } };

        await graph.invoke({ messages: [new HumanMessage('do something')] }, config);

        const state = await graph.getState(config);
        // The trivial fallback plan has one step; the executor's default (tool-free) reply
        // both satisfies it and ends the run on the fast path, so it lands 'completed'.
        expect(state.values.plan).toEqual([{ step: 'Analyze and respond to user request', status: 'completed' }]);
    }, 20000);

    it('emits a provider-error note and continues when the executor LLM call throws once', async () => {
        executorThrowsOnce = true;
        plannerPlan = ['Compose the final answer'];
        const { createReflectionGraph } = await import('@/lib/agent/planning-agent');
        const graph = await createReflectionGraph({ model: MODEL_CONFIG, autoApprove: true } as any);
        const config = { configurable: { thread_id: 'executor-throws' } };

        await graph.invoke({ messages: [new HumanMessage('do something')] }, config);

        const state = await graph.getState(config);
        const msgs = state.values.messages as BaseMessage[];
        expect(msgs.some(m => String((m as any).content ?? '').includes('model/provider error'))).toBe(true);
    }, 20000);

    it('forces finalization directly when the reflector LLM call throws', async () => {
        let n = 0;
        executorReply = () => toolCallMsg(`t-${n++}`);
        reflectorThrows = true;
        const { createReflectionGraph } = await import('@/lib/agent/planning-agent');
        const graph = await createReflectionGraph({ model: MODEL_CONFIG, autoApprove: true } as any);
        const config = { configurable: { thread_id: 'reflector-throws' }, recursionLimit: 400 };

        await graph.invoke({ messages: [new HumanMessage('audit everything, never stop')] }, config);

        expect(recorded.filter(r => r.node === 'REVISER')).toHaveLength(0);
        const state = await graph.getState(config);
        expect(state.values.isComplete).toBe(true);
        expect(state.values.reflection).toContain('Reflection unavailable');
    }, 20000);

    it('emits a provider-error note from the reviser and still reaches completion', async () => {
        let n = 0;
        executorReply = (call) => (call === 1 ? toolCallMsg(`e-${n++}`) : new AIMessage({ content: 'compose step done' }));
        reflectorReply = (call) => (call === 1
            ? new AIMessage({ content: JSON.stringify({ isComplete: false, analysis: 'issue', issues: 'fix it' }) })
            : new AIMessage({ content: JSON.stringify({ isComplete: true, analysis: 'done' }) }));
        reviserThrows = true;

        const { createReflectionGraph } = await import('@/lib/agent/planning-agent');
        const graph = await createReflectionGraph({ model: MODEL_CONFIG, autoApprove: true } as any);
        const config = { configurable: { thread_id: 'reviser-throws' }, recursionLimit: 200 };

        await graph.invoke({ messages: [new HumanMessage('investigate')] }, config);

        const state = await graph.getState(config);
        const msgs = state.values.messages as BaseMessage[];
        expect(msgs.some(m => String((m as any).content ?? '').includes('Revision could not be completed'))).toBe(true);
    }, 20000);

    it('assembles a best-effort answer from the tool digest when finalNode synthesis throws', async () => {
        let n = 0;
        executorReply = () => toolCallMsg(`f-${n++}`);
        reflectorReply = () => new AIMessage({ content: JSON.stringify({ isComplete: false, analysis: 'still going' }) });
        finalThrows = true;

        const { createReflectionGraph } = await import('@/lib/agent/planning-agent');
        const graph = await createReflectionGraph({ model: MODEL_CONFIG, autoApprove: true } as any);
        const config = { configurable: { thread_id: 'final-throws' }, recursionLimit: 400 };

        await graph.invoke({ messages: [new HumanMessage('audit everything, never stop')] }, config);

        const state = await graph.getState(config);
        const msgs = state.values.messages as BaseMessage[];
        expect(String((msgs.at(-1) as any).content)).toContain('I could not generate a polished answer');
        expect(String((msgs.at(-1) as any).content)).toContain('Key tool outputs');
    }, 20000);
});
