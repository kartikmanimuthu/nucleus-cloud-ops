import { BaseMessage } from "@langchain/core/messages";
import { StateGraphArgs } from "@langchain/langgraph";
import type { MemoryStats } from "@/lib/agent/memory/types";

export interface RequestEvaluation {
    mode: 'plan' | 'fast' | 'end' | null;
    skillId: string | null;
    skillName?: string | null;
    accountId: string | null;
    requiresApproval: boolean;
    reasoning: string;
    clarificationQuestion: string | null;
    missingInfo: string | null;
    /** Effective knowledge base ids for this run: the run's configured ids, or — when
     *  none were configured — the ids autonomously picked by resolveKnowledgeBaseIds().
     *  Set once by evaluatorNode after parsing the LLM output; always an array by then. */
    knowledgeBaseIds?: string[];
}

export interface PlanStep {
    step: string;
    status: 'pending' | 'in_progress' | 'completed' | 'failed';
}

/** Structured tool result — richer than plain string for reflection/summary nodes. */
export interface ToolResultEntry {
    toolName: string;
    output: string;       // truncated to 1000 chars
    isError: boolean;
    iterationIndex: number;
}

export interface ReflectionState {
    messages: BaseMessage[];
    taskDescription: string;
    plan: PlanStep[];
    errors: string[];
    reflection: string;
    iterationCount: number;
    nextAction: string;
    isComplete: boolean;
    toolResults: ToolResultEntry[];
    memoryContext: string; // Formatted memories injected by the shared memory_recall node
    memoryStats: MemoryStats | null;
    evaluation: RequestEvaluation | null;
    clarificationQuestion: string | null;
    approvalStatus: 'pending' | 'approved' | 'rejected' | null;
    pendingToolApprovals: string[];  // tool names awaiting approval at mutative_approval_gate
    reflectionStallCount?: number;   // consecutive unproductive reflections (stall detector)
}

export const graphState: StateGraphArgs<ReflectionState>["channels"] = {
    messages: {
        reducer: (x: BaseMessage[], y: BaseMessage[]) => {
            const combined = x.concat(y);
            return combined.length > 100 ? combined.slice(-100) : combined;
        },
        default: () => [],
    },
    taskDescription: {
        reducer: (x: string, y: string) => y || x,
        default: () => "",
    },
    plan: {
        reducer: (x: PlanStep[], y: PlanStep[]) => y.length > 0 ? y : x,
        default: () => [],
    },
    errors: {
        reducer: (x: string[], y: string[]) => y.length > 0 ? y : x,
        default: () => [],
    },
    reflection: {
        reducer: (x: string, y: string) => y || x,
        default: () => "",
    },
    iterationCount: {
        reducer: (_x: number, y: number) => y,
        default: () => 0,
    },
    nextAction: {
        reducer: (x: string, y: string) => y || x,
        default: () => "plan",
    },
    isComplete: {
        reducer: (_x: boolean, y: boolean) => y,
        default: () => false,
    },
    // Stall detector: without this channel LangGraph silently DROPS the value the
    // reflect node returns, so the counter never accumulates and the bail never fires.
    reflectionStallCount: {
        reducer: (x: number | undefined, y: number | undefined) => y ?? x ?? 0,
        default: () => 0,
    },
    toolResults: {
        reducer: (x: ToolResultEntry[], y: ToolResultEntry[]) => x.concat(y),
        default: () => [],
    },
    memoryContext: {
        reducer: (x: string, y: string) => y || x,
        default: () => "",
    },
    memoryStats: {
        reducer: (x: MemoryStats | null, y: MemoryStats | null) => y ?? x,
        default: () => null,
    },
    evaluation: {
        reducer: (x: RequestEvaluation | null, y: RequestEvaluation | null) => y || x,
        default: () => null,
    },
    clarificationQuestion: {
        reducer: (x: string | null, y: string | null) => y ?? x,
        default: () => null,
    },
    approvalStatus: {
        reducer: (x: 'pending' | 'approved' | 'rejected' | null, y: 'pending' | 'approved' | 'rejected' | null) => y ?? x,
        default: () => null,
    },
    pendingToolApprovals: {
        reducer: (x: string[], y: string[]) => y.length > 0 ? y : x,
        default: () => [],
    },
};

/**
 * Whether a checkpointed evaluation can be REUSED on a graph re-invoke.
 *
 * The clarification resume re-runs the graph on the SAME thread, so the
 * previous run's evaluation survives in the checkpoint (the channel reducer
 * keeps it). A plan-mode evaluation is a real execution decision — reusing it
 * is correct (that's what the approval resume relies on). But a mode='end'
 * (clarification) decision must NEVER be reused: the user's reply is now in
 * the conversation and the evaluator has to actually read it — otherwise the
 * stale decision routes straight back to clarify and the run re-asks the same
 * question forever, no matter what the user answers.
 */
export function isReusableEvaluation(evaluation: RequestEvaluation | null | undefined): boolean {
    return !!evaluation && evaluation.mode !== 'end';
}
