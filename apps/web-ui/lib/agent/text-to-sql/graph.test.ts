import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./nodes/describe-schema', () => ({ describeSchemaNode: vi.fn(async () => ({ schemaDescription: 's' })) }));
vi.mock('./nodes/generate-sql', () => ({ generateSQLNode: vi.fn(async () => ({ generatedSQL: 'SELECT 1' })) }));
vi.mock('./nodes/execute-sql', () => ({ executeSQLNode: vi.fn(async () => ({ sqlResult: { rows: [], rowCount: 0 } })) }));
vi.mock('./nodes/reflect', () => ({
    reflectNode: vi.fn(async (state: any) => ({ satisfied: state.iteration >= 1, iteration: state.iteration + 1 })),
}));
vi.mock('./nodes/synthesize', () => ({ synthesizeNode: vi.fn(async () => ({ finalAnswer: 'done' })) }));

import { createTextToSQLGraph } from './graph';

describe('createTextToSQLGraph', () => {
    beforeEach(() => vi.clearAllMocks());

    it('compiles a runnable graph', () => {
        const graph = createTextToSQLGraph();
        expect(graph).toBeDefined();
        expect(typeof graph.invoke).toBe('function');
    });

    it('runs describe_schema -> generate_sql -> execute_sql -> reflect -> synthesize to a final answer when reflect is immediately satisfied', async () => {
        const graph = createTextToSQLGraph();
        const result = await graph.invoke({
            question: 'q', tenantId: 't1', modelConfig: { provider: 'bedrock', modelId: 'x' } as any,
            conversationHistory: [], maxIterations: 3,
        });
        expect(result.finalAnswer).toBe('done');
        expect(result.satisfied).toBe(true);
    });

    it('loops back to generate_sql via the conditional edge when reflect is unsatisfied, then eventually synthesizes', async () => {
        const { reflectNode } = await import('./nodes/reflect');
        vi.mocked(reflectNode).mockImplementation(async (state: any) => ({
            satisfied: state.iteration >= 1,
            iteration: state.iteration + 1,
        }));

        const graph = createTextToSQLGraph();
        const result = await graph.invoke({
            question: 'q', tenantId: 't1', modelConfig: { provider: 'bedrock', modelId: 'x' } as any,
            conversationHistory: [], maxIterations: 3, iteration: 0,
        });

        expect(reflectNode).toHaveBeenCalledTimes(2);
        expect(result.finalAnswer).toBe('done');
    });

    it('routes to synthesize once maxIterations is reached even if unsatisfied', async () => {
        const { reflectNode } = await import('./nodes/reflect');
        vi.mocked(reflectNode).mockResolvedValue({ satisfied: false, iteration: 3 } as any);

        const graph = createTextToSQLGraph();
        const result = await graph.invoke({
            question: 'q', tenantId: 't1', modelConfig: { provider: 'bedrock', modelId: 'x' } as any,
            conversationHistory: [], maxIterations: 3, iteration: 3,
        });

        expect(result.finalAnswer).toBe('done');
    });
});
