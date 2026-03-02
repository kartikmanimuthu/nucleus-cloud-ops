import { BaseMessage } from "@langchain/core/messages";
import { StateGraphArgs } from "@langchain/langgraph";

export interface RequestEvaluation {
    mode: 'plan' | 'fast' | 'end' | null;
    skillId: string | null;
    accountId: string | null;
    requiresApproval: boolean;
    reasoning: string;
    clarificationQuestion: string | null; // Set when mode='end' — the question to post back to the user
    missingInfo: string | null;           // Brief label of what info is needed (e.g. "AWS account ID")
}

export interface PlanStep {
    step: string;
    status: 'pending' | 'in_progress' | 'completed' | 'failed';
}

export interface ReflectionState {
    messages: BaseMessage[];
    taskDescription: string;
    plan: PlanStep[];
    code: string;
    executionOutput: string;
    errors: string[];
    reflection: string;
    iterationCount: number;
    nextAction: string;
    isComplete: boolean;
    toolResults: string[]; // Store tool results for final summary
    evaluation: RequestEvaluation | null;
    clarificationQuestion: string | null; // Populated by clarifyNode when awaiting user input
}

export const graphState: StateGraphArgs<ReflectionState>["channels"] = {
    messages: {
        reducer: (x: BaseMessage[], y: BaseMessage[]) => x.concat(y),
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
    code: {
        reducer: (x: string, y: string) => y || x,
        default: () => "",
    },
    executionOutput: {
        reducer: (x: string, y: string) => y ? (x + "\n" + y) : x, // Accumulate outputs
        default: () => "",
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
        reducer: (x: number, y: number) => y,
        default: () => 0,
    },
    nextAction: {
        reducer: (x: string, y: string) => y || x,
        default: () => "plan",
    },
    isComplete: {
        reducer: (x: boolean, y: boolean) => y,
        default: () => false,
    },
    toolResults: {
        reducer: (x: string[], y: string[]) => x.concat(y),
        default: () => [],
    },
    evaluation: {
        reducer: (x: RequestEvaluation | null, y: RequestEvaluation | null) => y || x,
        default: () => null,
    },
    clarificationQuestion: {
        reducer: (x: string | null, y: string | null) => y ?? x,
        default: () => null,
    },
};
