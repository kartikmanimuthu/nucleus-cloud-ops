import { Annotation } from "@langchain/langgraph";
import type { ResolvedModelConfig } from "../agent-shared";

export interface SQLResult {
    rows: Record<string, unknown>[];
    rowCount: number;
}

export interface TextToSQLFilters {
    accountIds?: string[];
    region?: string;
    resourceType?: string;
}

export const TextToSQLAnnotation = Annotation.Root({
    question: Annotation<string>({ reducer: (_x, y) => y, default: () => "" }),
    conversationHistory: Annotation<Array<{ role: string; content: string }>>({
        reducer: (_x, y) => y, default: () => [],
    }),
    tenantId: Annotation<string>({ reducer: (_x, y) => y, default: () => "" }),
    /** Resolved config for the tenant's configured provider — drives every LLM node. */
    modelConfig: Annotation<ResolvedModelConfig | null>({ reducer: (_x, y) => y, default: () => null }),
    filters: Annotation<TextToSQLFilters | undefined>({
        reducer: (_x, y) => y, default: () => undefined,
    }),
    schemaDescription: Annotation<string>({ reducer: (_x, y) => y, default: () => "" }),
    sampleRows: Annotation<Record<string, unknown>[]>({
        reducer: (_x, y) => y, default: () => [],
    }),
    generatedSQL: Annotation<string>({ reducer: (_x, y) => y, default: () => "" }),
    sqlResult: Annotation<SQLResult | null>({ reducer: (_x, y) => y, default: () => null }),
    sqlError: Annotation<string | null>({ reducer: (_x, y) => y, default: () => null }),
    reflectionFeedback: Annotation<string>({ reducer: (_x, y) => y, default: () => "" }),
    iteration: Annotation<number>({ reducer: (_x, y) => y, default: () => 0 }),
    maxIterations: Annotation<number>({ reducer: (_x, y) => y, default: () => 3 }),
    satisfied: Annotation<boolean>({ reducer: (_x, y) => y, default: () => false }),
    finalAnswer: Annotation<string>({ reducer: (_x, y) => y, default: () => "" }),
});

export type TextToSQLState = typeof TextToSQLAnnotation.State;

/**
 * Returns the resolved provider config, throwing a clear error if it's missing.
 * `invokeTextToSQL` always seeds `modelConfig`; this guard protects any direct
 * `createTextToSQLGraph()` invocation that bypasses it (the annotation defaults
 * to null), turning a confusing undefined-spread into an explicit failure.
 */
export function requireModelConfig(state: TextToSQLState): ResolvedModelConfig {
    if (!state.modelConfig) {
        throw new Error(
            'Text-to-SQL graph was invoked without a resolved model config. Use invokeTextToSQL(), which resolves the tenant provider first.',
        );
    }
    return state.modelConfig;
}
