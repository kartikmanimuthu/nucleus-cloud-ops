import { createTextToSQLGraph } from "./graph";
import type { TextToSQLFilters } from "./state";

export interface TextToSQLInput {
    question: string;
    tenantId: string;
    conversationHistory?: Array<{ role: string; content: string }>;
    filters?: TextToSQLFilters;
}

export interface TextToSQLEvent {
    type: 'step' | 'sql' | 'result' | 'reflection' | 'token' | 'error' | 'done';
    [key: string]: unknown;
}

export async function* invokeTextToSQL(input: TextToSQLInput): AsyncGenerator<TextToSQLEvent> {
    const graph = createTextToSQLGraph();

    yield { type: 'step', step: 'describe_schema', status: 'running' };

    try {
        const result = await graph.invoke({
            question: input.question,
            tenantId: input.tenantId,
            conversationHistory: input.conversationHistory ?? [],
            filters: input.filters,
            maxIterations: 3,
        });

        yield { type: 'step', step: 'describe_schema', status: 'done' };

        if (result.generatedSQL) {
            yield { type: 'step', step: 'generate_sql', status: 'done', iteration: result.iteration };
            yield { type: 'sql', query: result.generatedSQL };
        }

        if (result.sqlResult) {
            yield { type: 'step', step: 'execute_sql', status: 'done' };
            yield { type: 'result', rowCount: result.sqlResult.rowCount, preview: result.sqlResult.rows.slice(0, 5) };
        }

        if (result.iteration > 0) {
            yield { type: 'step', step: 'reflect', status: 'done' };
            yield { type: 'reflection', satisfied: result.satisfied, feedback: result.reflectionFeedback || '' };
        }

        if (result.finalAnswer) {
            yield { type: 'step', step: 'synthesize', status: 'done' };
            yield { type: 'token', content: result.finalAnswer };
        }
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[TextToSQL] Graph invocation error:', message);
        yield { type: 'error', message };
    }

    yield { type: 'done' };
}

export type { TextToSQLFilters } from "./state";
export type { TextToSQLState } from "./state";
