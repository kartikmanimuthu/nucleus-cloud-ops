import { Annotation } from "@langchain/langgraph";

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
