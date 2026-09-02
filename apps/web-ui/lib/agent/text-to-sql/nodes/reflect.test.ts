import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AIMessage } from '@langchain/core/messages';

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/agent/model-factory', () => ({
    createAgentModels: vi.fn(() => ({ reflector: { invoke: invokeMock }, main: { invoke: invokeMock } })),
}));

import { reflectNode } from './reflect';
import type { TextToSQLState } from '../state';

function baseState(overrides: Partial<TextToSQLState> = {}): TextToSQLState {
    return {
        question: 'q',
        conversationHistory: [],
        tenantId: 'tenant-1',
        modelConfig: { provider: 'bedrock', modelId: 'claude' } as any,
        filters: undefined,
        schemaDescription: '',
        sampleRows: [],
        generatedSQL: 'SELECT 1',
        sqlResult: { rows: [], rowCount: 0 },
        sqlError: null,
        reflectionFeedback: '',
        iteration: 0,
        maxIterations: 3,
        satisfied: false,
        finalAnswer: '',
        ...overrides,
    };
}

describe('reflectNode', () => {
    beforeEach(() => vi.clearAllMocks());

    it('short-circuits on a SQL error without calling the LLM, and asks for a retry', async () => {
        const result = await reflectNode(baseState({ sqlError: 'bad column', iteration: 0, maxIterations: 3 }));
        expect(invokeMock).not.toHaveBeenCalled();
        expect(result).toEqual({ satisfied: false, iteration: 1, reflectionFeedback: 'SQL error: bad column. Please fix the query.' });
    });

    it('forces satisfied when a SQL error persists into the last allowed iteration', async () => {
        const result = await reflectNode(baseState({ sqlError: 'bad column', iteration: 2, maxIterations: 3 }));
        expect(result).toEqual({ satisfied: true, iteration: 3, reflectionFeedback: '' });
    });

    it('parses a satisfied JSON verdict from the model', async () => {
        invokeMock.mockResolvedValue(new AIMessage({ content: '{"satisfied": true, "feedback": "looks right"}' }));
        const result = await reflectNode(baseState());
        expect(result).toEqual({ satisfied: true, iteration: 1, reflectionFeedback: '' });
    });

    it('parses an unsatisfied JSON verdict and carries the feedback', async () => {
        invokeMock.mockResolvedValue(new AIMessage({ content: '{"satisfied": false, "feedback": "wrong aggregation"}' }));
        const result = await reflectNode(baseState());
        expect(result).toEqual({ satisfied: false, iteration: 1, reflectionFeedback: 'wrong aggregation' });
    });

    it('extracts JSON even when surrounded by extra prose', async () => {
        invokeMock.mockResolvedValue(new AIMessage({ content: 'Sure, here is my verdict:\n{"satisfied": true, "feedback": "ok"}\nThanks!' }));
        const result = await reflectNode(baseState());
        expect(result.satisfied).toBe(true);
    });

    it('assumes satisfied when the response has no parseable JSON', async () => {
        invokeMock.mockResolvedValue(new AIMessage({ content: 'I could not evaluate this.' }));
        const result = await reflectNode(baseState());
        expect(result).toEqual({ satisfied: true, iteration: 1, reflectionFeedback: '' });
    });

    it('assumes satisfied when the JSON is malformed', async () => {
        invokeMock.mockResolvedValue(new AIMessage({ content: '{"satisfied": true, "feedback"' }));
        const result = await reflectNode(baseState());
        expect(result.satisfied).toBe(true);
    });

    it('forces satisfied when unsatisfied at the max iteration boundary', async () => {
        invokeMock.mockResolvedValue(new AIMessage({ content: '{"satisfied": false, "feedback": "still wrong"}' }));
        const result = await reflectNode(baseState({ iteration: 2, maxIterations: 3 }));
        expect(result).toEqual({ satisfied: true, iteration: 3, reflectionFeedback: '' });
    });
});
