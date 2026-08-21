import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BaseMessage, HumanMessage, AIMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import {
    findRenderedDeliverable,
    tagMessagePhase,
    tagMessageAsDeliverable,
    type ToolResultEntry,
} from '@/lib/agent/agent-shared';
import { buildToolDigest, isDeliverableTurn } from '@/lib/agent/planning-agent';
import type { PlanStep } from '@/lib/agent/agent-shared';

// The real failure: a correct but short composed answer. ~62 chars — far under the
// 800-char promotion threshold that used to gate finalNode's verbatim path.
const SHORT_ANSWER = 'next: 15.5.15, react: ^19 — both from apps/web-ui/package.json';

const recorded: Array<{ node: string; inputs: BaseMessage[] }> = [];

function classify(inputs: BaseMessage[]): string {
    const sys = String((inputs[0] as any)?.content ?? '');
    if (sys.includes('decompose the user')) return 'PLANNER';
    if (sys.includes('execute the current plan step')) return 'EXECUTOR';
    if (sys.includes('structured review')) return 'REFLECTOR';
    if (sys.includes('address the specific issues')) return 'REVISER';
    if (sys.includes('answering the user')) return 'FINAL';
    return 'OTHER';
}

let plannerPlan = ['Answer the user\'s request directly'];

const fakeModel: any = {
    bindTools: () => fakeModel,
    invoke: async (inputs: BaseMessage[]) => {
        const node = classify(inputs);
        recorded.push({ node, inputs });
        if (node === 'PLANNER') {
            return new AIMessage({ content: JSON.stringify(plannerPlan) });
        }
        if (node === 'FINAL') {
            // Stand-in for the fabricated answer the synthesis path produced live.
            return new AIMessage({ content: 'next: 15.0.3, react: 19.0.0' });
        }
        return new AIMessage({ content: SHORT_ANSWER });
    },
};

vi.mock('@/lib/agent/model-factory', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/agent/model-factory')>();
    return { ...actual, createAgentModels: () => ({ main: fakeModel, reflector: fakeModel }), assembleTools: async () => [] };
});

vi.mock('@/lib/agent/persistence', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/agent/persistence')>();
    const saver = new MemorySaver();
    return { ...actual, getCheckpointer: async () => saver, getMemoryStore: async () => undefined };
});

const MODEL_CONFIG = { provider: 'bedrock' as const, modelId: 'test-model', maxTokens: 4096 };

const aiMsg = (text: string, phase: string, deliverable = false) => {
    const m = tagMessagePhase(new AIMessage({ content: text }), phase);
    return deliverable ? tagMessageAsDeliverable(m) : m;
};

describe('findRenderedDeliverable', () => {
    it('promotes a short answer that was marked as the compose step output', () => {
        expect(findRenderedDeliverable([aiMsg(SHORT_ANSWER, 'execution', true)])).toBe(SHORT_ANSWER);
    });

    it('still ignores short unmarked prose (narration must not become the report)', () => {
        expect(findRenderedDeliverable([aiMsg('Let me check the other region.', 'execution')])).toBeNull();
    });

    it('ignores a marked message that is too short to be an answer', () => {
        expect(findRenderedDeliverable([aiMsg('Done.', 'execution', true)])).toBeNull();
    });

    it('promotes a terse answer — the floor must not reject real ones', () => {
        // Observed live at exactly 38 chars; a floor of 40 sent it to the synthesis path.
        const terse = 'next: `15.5.15`\nreact: `^19` (caret)!';
        expect(terse.length).toBeLessThan(40);
        expect(findRenderedDeliverable([aiMsg(terse, 'execution', true)])).toBe(terse);
    });

    it('takes the latest qualifying message, marked or long', () => {
        const long = 'A'.repeat(900);
        expect(findRenderedDeliverable([
            aiMsg(SHORT_ANSWER, 'execution', true),
            aiMsg(long, 'revision'),
        ])).toBe(long);
        expect(findRenderedDeliverable([
            aiMsg(long, 'execution'),
            aiMsg(SHORT_ANSWER, 'revision', true),
        ])).toBe(SHORT_ANSWER);
    });

    it('ignores non-deliverable phases regardless of marking', () => {
        expect(findRenderedDeliverable([aiMsg(SHORT_ANSWER, 'planning', true)])).toBeNull();
    });
});

describe('isDeliverableTurn', () => {
    const plan = (...statuses: PlanStep['status'][]): PlanStep[] =>
        statuses.map((status, i) => ({ step: `step ${i}`, status }));
    // iterationCount as seen INSIDE generateNode: 0 on the first executor turn.
    const FIRST = 0;
    const LATER = 3;

    it('marks a prose turn when the plan is already exhausted', () => {
        // The live-observed path: the tools node completes each in_progress step, so two
        // tool turns finish a 2-step plan and the compose prose arrives with nothing open.
        expect(isDeliverableTurn(plan('completed', 'completed'), false, LATER)).toBe(true);
    });

    it('marks a prose turn that consumes the last step', () => {
        expect(isDeliverableTurn(plan('completed', 'pending'), false, LATER)).toBe(true);
        expect(isDeliverableTurn(plan('completed', 'in_progress'), false, LATER)).toBe(true);
    });

    it('marks a first no-tool turn even with steps left — the run ends there', () => {
        // shouldContinueFromGenerate sees iterationCount 1 after this node increments and
        // routes straight to final, so steps 2..n never run. Proven gap: the executor's
        // answer was discarded and finalNode re-synthesized it.
        expect(isDeliverableTurn(plan('completed', 'pending', 'pending'), false, FIRST)).toBe(true);
        expect(isDeliverableTurn(plan('pending', 'pending'), false, FIRST)).toBe(true);
    });

    it('does not mark mid-plan narration on later turns', () => {
        expect(isDeliverableTurn(plan('pending', 'pending', 'pending'), false, LATER)).toBe(false);
        expect(isDeliverableTurn(plan('completed', 'pending', 'pending'), false, LATER)).toBe(false);
    });

    it('never marks a turn that called tools, first or later', () => {
        expect(isDeliverableTurn(plan('completed', 'completed'), true, LATER)).toBe(false);
        expect(isDeliverableTurn(plan('completed', 'pending'), true, LATER)).toBe(false);
        expect(isDeliverableTurn(plan('pending', 'pending'), true, FIRST)).toBe(false);
    });
});

describe('buildToolDigest', () => {
    const entry = (name: string, output: string, isError = false): ToolResultEntry =>
        ({ toolName: name, output, isError, iterationIndex: 0 });

    it('keeps output past the old 500-char cut', () => {
        // The live fabrication happened because the dependencies block sat past 500.
        const long = 'x'.repeat(400) + 'NEEDLE_PAST_500' + 'y'.repeat(400);
        expect(buildToolDigest([entry('execute_command', long)])).toContain('NEEDLE_PAST_500');
    });

    it('keeps entries past the old last-3 window', () => {
        const entries = [1, 2, 3, 4, 5].map(i => entry(`tool_${i}`, `OUTPUT_${i}`));
        const digest = buildToolDigest(entries);
        for (const i of [1, 2, 3, 4, 5]) expect(digest).toContain(`OUTPUT_${i}`);
    });

    it('marks errors and handles an empty set', () => {
        expect(buildToolDigest([entry('t', 'boom', true)])).toContain('❌');
        expect(buildToolDigest([])).toBe('(no tool output was captured)');
    });
});

describe('finalNode promotion (real graph)', () => {
    beforeEach(() => {
        recorded.length = 0;
        plannerPlan = ['Answer the user\'s request directly'];
    });

    it('promotes the answer when the run ends early with plan steps still pending', async () => {
        // The over-planned conversational follow-up: planner writes 3 steps, the executor
        // answers on move one with no tools, and shouldContinueFromGenerate jumps straight
        // to final — steps 2 and 3 never run. The answer must still be promoted.
        plannerPlan = ['Get AWS credentials', 'Query CloudWatch', 'Compose the answer'];
        const { createReflectionGraph } = await import('@/lib/agent/planning-agent');
        const graph = await createReflectionGraph({ model: MODEL_CONFIG, autoApprove: true } as any);
        const config = { configurable: { thread_id: 'final-early-exit' } };

        await graph.invoke({ messages: [new HumanMessage('say that again?')] }, config);

        const state = await graph.getState(config);
        const msgs = state.values.messages as BaseMessage[];
        expect(String((msgs.at(-1) as any).content)).toBe(SHORT_ANSWER);
        expect(recorded.filter(r => r.node === 'FINAL')).toHaveLength(0);
        // Steps really were left open — this is the early-exit path, not plan exhaustion.
        expect((state.values.plan as any[]).filter(p => p.status === 'pending').length).toBeGreaterThan(0);
    });

    it('promotes the short composed answer verbatim instead of re-synthesizing', async () => {
        const { createReflectionGraph } = await import('@/lib/agent/planning-agent');
        const graph = await createReflectionGraph({ model: MODEL_CONFIG, autoApprove: true } as any);
        const config = { configurable: { thread_id: 'final-short-answer' } };

        await graph.invoke({ messages: [new HumanMessage('which versions of next and react are pinned?')] }, config);

        const msgs = (await graph.getState(config)).values.messages as BaseMessage[];
        expect(String((msgs.at(-1) as any).content)).toBe(SHORT_ANSWER);
        // Synthesis is the fabrication surface — it must not have run at all.
        expect(recorded.filter(r => r.node === 'FINAL')).toHaveLength(0);
    });
});
