import { createTextToSQLGraph } from "./graph";
import type { TextToSQLFilters, TextToSQLState } from "./state";

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

/**
 * Invoke the Text-to-SQL graph and yield SSE events in real-time
 * as each node completes. Uses graph.stream() with streamMode: 'updates'
 * so the frontend sees step indicators progress live.
 */
export async function* invokeTextToSQL(input: TextToSQLInput): AsyncGenerator<TextToSQLEvent> {
    const graph = createTextToSQLGraph();

    try {
        const stream = await graph.stream(
            {
                question: input.question,
                tenantId: input.tenantId,
                conversationHistory: input.conversationHistory ?? [],
                filters: input.filters,
                maxIterations: 3,
            },
            { streamMode: 'updates' }
        );

        let lastSQL = '';
        let lastIteration = 0;

        for await (const chunk of stream) {
            // streamMode: 'updates' yields { [nodeName]: Partial<State> }
            const entries = Object.entries(chunk) as [string, Partial<TextToSQLState>][];

            for (const [nodeName, update] of entries) {
                // Emit step completion for each node
                yield { type: 'step', step: nodeName, status: 'done' };

                switch (nodeName) {
                    case 'generate_sql':
                        if (update.generatedSQL) {
                            lastSQL = update.generatedSQL;
                            lastIteration = (update as any).iteration ?? lastIteration;
                            yield { type: 'sql', query: update.generatedSQL };
                        }
                        break;

                    case 'execute_sql':
                        if (update.sqlResult) {
                            yield {
                                type: 'result',
                                rowCount: update.sqlResult.rowCount,
                                preview: update.sqlResult.rows.slice(0, 5),
                            };
                        }
                        if (update.sqlError) {
                            yield { type: 'step', step: 'execute_sql', status: 'done', detail: 'error' };
                        }
                        break;

                    case 'reflect':
                        if (update.satisfied !== undefined) {
                            yield {
                                type: 'reflection',
                                satisfied: update.satisfied,
                                feedback: update.reflectionFeedback || '',
                                iteration: update.iteration ?? lastIteration,
                            };
                        }
                        break;

                    case 'synthesize':
                        if (update.finalAnswer) {
                            yield { type: 'token', content: update.finalAnswer };
                        }
                        break;
                }
            }
        }
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[TextToSQL] Graph stream error:', message);
        yield { type: 'error', message };
    }

    yield { type: 'done' };
}

export type { TextToSQLFilters } from "./state";
export type { TextToSQLState } from "./state";
