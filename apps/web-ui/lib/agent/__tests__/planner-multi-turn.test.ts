import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BaseMessage, HumanMessage, AIMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { parsePlanResponse } from '@/lib/agent/planning-agent';

const TURN1_REQUEST = 'List running EC2 instances in the dev account';
const TURN2_REQUEST = 'now do the same for prod';
const PLAN_STEP_MARKER = 'STEP_ALPHA_get_credentials';
const ANSWER_MARKER = 'ANSWER_MARKER_dev_has_three_instances';

// >800 chars so finalNode promotes it verbatim as the turn's answer.
const LONG_ANSWER = `${ANSWER_MARKER}. ` + 'You have 3 running EC2 instances in the dev account. '.repeat(20);

const recorded: Array<{ node: string; inputs: BaseMessage[] }> = [];

function classify(inputs: BaseMessage[]): string {
    const sys = String((inputs[0] as any)?.content ?? '');
    if (sys.includes('decompose the user')) return 'PLANNER';
    if (sys.includes('execute the current plan step')) return 'EXECUTOR';
    if (sys.includes('structured review')) return 'REFLECTOR';
    if (sys.includes('address the specific issues')) return 'REVISER';
    return 'OTHER';
}

// Verbatim shape of a real Sonnet 4.6 planner response (thread 1786343725502): a
// valid array, then the model ignores "only return the JSON array" and role-plays the
// whole execution — prose plus <function_calls> blocks stuffed with JMESPath brackets.
const PLANNER_OVERRUN = `${JSON.stringify([PLAN_STEP_MARKER, 'Describe running EC2 instances', 'Compose the final answer'])}

Running the EC2 health check for account **STX-CLOUD-PLATFORM (970547372609)**. Let me gather credentials.

**Step 1 — Credentials**

<function_calls>
<invoke name="get_aws_credentials">
<parameter name="accountId">970547372609</parameter>
</invoke>
</function_calls>

<function_calls>
<invoke name="execute_aws_command">
<parameter name="command">aws ec2 describe-instances --query "Reservations[].Instances[].{Id:InstanceId,Name:Tags[?Key=='Name']|[0].Value}" --output json</parameter>
</invoke>
</function_calls>`;

let plannerResponse = () => JSON.stringify([PLAN_STEP_MARKER, 'Compose the final answer']);

const fakeModel: any = {
    bindTools: () => fakeModel,
    invoke: async (inputs: BaseMessage[]) => {
        const node = classify(inputs);
        recorded.push({ node, inputs });
        if (node === 'PLANNER') {
            return new AIMessage({ content: plannerResponse() });
        }
        return new AIMessage({ content: LONG_ANSWER });
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

describe('parsePlanResponse', () => {
    const steps = (raw: string) => parsePlanResponse(raw).map(s => s.step);

    it('takes the first complete array and ignores trailing prose', () => {
        // The production failure: a valid array, then the model role-plays the run.
        expect(steps('["a","b"]\n\nNow: aws ec2 describe-instances --query "Reservations[].Instances[]"'))
            .toEqual(['a', 'b']);
    });

    it('skips candidates that are not the plan', () => {
        expect(steps('Plan (steps [1-5]):\n["a","b"]')).toEqual(['a', 'b']);
        expect(steps('[oops never closes\n["a","b"]')).toEqual(['a', 'b']);
        expect(steps('[]\n["a","b"]')).toEqual(['a', 'b']);
        expect(steps('{"note":"skip"}\nPlan: ["a","b"]')).toEqual(['a', 'b']);
    });

    it('keeps brackets and escaped quotes inside step text intact', () => {
        expect(steps('["Query \\"Reservations[].Instances[]\\" now","b"]'))
            .toEqual(['Query "Reservations[].Instances[]" now', 'b']);
    });

    it('handles markdown fences and drops unusable entries', () => {
        expect(steps('```json\n["a","b"]\n```')).toEqual(['a', 'b']);
        expect(steps('["a",5,"","  ","b"]')).toEqual(['a', 'b']);
    });

    it('returns nothing usable so the caller can fall back', () => {
        expect(steps('')).toEqual([]);
        expect(steps('["a","b"')).toEqual([]);
        expect(steps('[1,2,3]')).toEqual([]);
    });
});

describe('planner sees prior turns on a multi-turn thread', () => {
    beforeEach(() => {
        recorded.length = 0;
        plannerResponse = () => JSON.stringify([PLAN_STEP_MARKER, 'Compose the final answer']);
    });

    it('grounds the turn-2 plan in the previous request, answer, and plan', async () => {
        const { createReflectionGraph } = await import('@/lib/agent/planning-agent');
        const graph = await createReflectionGraph({ model: MODEL_CONFIG, autoApprove: true } as any);
        const config = { configurable: { thread_id: 'planner-multi-turn' } };

        await graph.invoke({ messages: [new HumanMessage(TURN1_REQUEST)] }, config);
        recorded.length = 0;
        await graph.invoke({ messages: [new HumanMessage(TURN2_REQUEST)] }, config);

        const planner = recorded.find(r => r.node === 'PLANNER');
        expect(planner, 'planner should run on turn 2').toBeTruthy();
        const prompt = String((planner!.inputs[0] as any).content);

        // The previous request must be visible, or "now do the same" is unresolvable.
        expect(prompt).toContain(TURN1_REQUEST);
        // What was already answered last turn.
        expect(prompt).toContain(ANSWER_MARKER);
        // What was already planned/completed last turn.
        expect(prompt).toContain(PLAN_STEP_MARKER);

        // The current request still arrives as the user turn.
        expect(String((planner!.inputs.at(-1) as any).content)).toContain(TURN2_REQUEST);
    });

    it('keeps the plan when the model appends prose and bracket-laden text after the array', async () => {
        plannerResponse = () => PLANNER_OVERRUN;
        const { createReflectionGraph } = await import('@/lib/agent/planning-agent');
        const graph = await createReflectionGraph({ model: MODEL_CONFIG, autoApprove: true } as any);
        const config = { configurable: { thread_id: 'planner-overrun' } };

        await graph.invoke({ messages: [new HumanMessage(TURN1_REQUEST)] }, config);

        const plan = (await graph.getState(config)).values.plan as Array<{ step: string }>;
        expect(plan.map(p => p.step)).toEqual([
            PLAN_STEP_MARKER, 'Describe running EC2 instances', 'Compose the final answer',
        ]);
    });

    it('gives each turn its own iteration budget instead of carrying it across turns', async () => {
        const { createReflectionGraph } = await import('@/lib/agent/planning-agent');
        const graph = await createReflectionGraph({ model: MODEL_CONFIG, autoApprove: true } as any);
        const config = { configurable: { thread_id: 'planner-iteration-budget' } };

        await graph.invoke({ messages: [new HumanMessage(TURN1_REQUEST)] }, config);
        recorded.length = 0;
        await graph.invoke({ messages: [new HumanMessage(TURN2_REQUEST)] }, config);

        const turn2ExecutorCalls = recorded.filter(r => r.node === 'EXECUTOR' || r.node === 'REVISER').length;
        const finalCount = (await graph.getState(config)).values.iterationCount as number;
        expect(finalCount).toBeLessThanOrEqual(turn2ExecutorCalls);
    });

    it('adds no conversation section on the very first turn', async () => {
        const { createReflectionGraph } = await import('@/lib/agent/planning-agent');
        const graph = await createReflectionGraph({ model: MODEL_CONFIG, autoApprove: true } as any);
        await graph.invoke({ messages: [new HumanMessage(TURN1_REQUEST)] }, { configurable: { thread_id: 'planner-first-turn' } });

        const planner = recorded.find(r => r.node === 'PLANNER')!;
        expect(String((planner.inputs[0] as any).content)).not.toContain('Conversation So Far');
    });
});
