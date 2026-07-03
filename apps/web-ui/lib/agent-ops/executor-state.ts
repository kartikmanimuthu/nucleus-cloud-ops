import { BaseMessage } from "@langchain/core/messages";
import { StateGraphArgs } from "@langchain/langgraph";

export interface RequestEvaluation {
    mode: 'plan' | 'fast' | 'end' | null;
    skillId: string | null;
    accountId: string | null;
    requiresApproval: boolean;
    reasoning: string;
    clarificationQuestion: string | null;
    missingInfo: string | null;
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
    evaluation: RequestEvaluation | null;
    clarificationQuestion: string | null;
    approvalStatus: 'pending' | 'approved' | 'rejected' | null;
    pendingToolApprovals: string[];  // tool names awaiting approval at mutative_approval_gate
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
    toolResults: {
        reducer: (x: ToolResultEntry[], y: ToolResultEntry[]) => x.concat(y),
        default: () => [],
    },
    memoryContext: {
        reducer: (x: string, y: string) => y || x,
        default: () => "",
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
