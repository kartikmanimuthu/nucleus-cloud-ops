import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AIMessage } from '@langchain/core/messages';

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/agent/model-factory', () => ({
    createAgentModels: vi.fn(() => ({ reflector: { invoke: invokeMock }, main: { invoke: invokeMock } })),
}));

import { synthesizeNode } from './synthesize';
import type { TextToSQLState } from '../state';

function baseState(overrides: Partial<TextToSQLState> = {}): TextToSQLState {
    return {
        question: 'how many ec2 instances',
        conversationHistory: [],
        tenantId: 'tenant-1',
        modelConfig: { provider: 'bedrock', modelId: 'claude' } as any,
        filters: undefined,
        schemaDescription: '',
        sampleRows: [],
        generatedSQL: 'SELECT * FROM inventory_resources',
        sqlResult: { rows: [{ id: '1', name: 'web-1' }], rowCount: 1 },
        sqlError: null,
        reflectionFeedback: '',
        iteration: 0,
        maxIterations: 3,
        satisfied: true,
        finalAnswer: '',
        ...overrides,
    };
}

describe('synthesizeNode', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns an error-specific message when there is no result and a sqlError', async () => {
        const result = await synthesizeNode(baseState({ sqlResult: null, sqlError: 'timeout' }));
        expect(result.finalAnswer).toContain('Error: timeout');
        expect(invokeMock).not.toHaveBeenCalled();
    });

    it('returns a generic message when there is no result and no error', async () => {
        const result = await synthesizeNode(baseState({ sqlResult: null, sqlError: null }));
        expect(result.finalAnswer).toContain('try rephrasing');
    });

    it('synthesizes the LLM answer on success', async () => {
        invokeMock.mockResolvedValue(new AIMessage({ content: 'You have 1 EC2 instance: web-1.' }));
        const result = await synthesizeNode(baseState());
        expect(result.finalAnswer).toBe('You have 1 EC2 instance: web-1.');
    });

    it('mentions the retry in the prompt when the iteration is > 0', async () => {
        invokeMock.mockResolvedValue(new AIMessage({ content: 'answer' }));
        await synthesizeNode(baseState({ iteration: 2 }));
        const humanMsg = invokeMock.mock.calls[0][0][1];
        expect(humanMsg.content).toContain('required multiple attempts');
    });

    it('falls back to a markdown table of raw rows when the LLM invoke throws', async () => {
        invokeMock.mockRejectedValue(new Error('model unavailable'));
        const result = await synthesizeNode(baseState({ sqlResult: { rows: [{ id: '1', name: 'web-1' }], rowCount: 1 } }));
        expect(result.finalAnswer).toContain('| id | name |');
        expect(result.finalAnswer).toContain('| 1 | web-1 |');
        expect(result.finalAnswer).toContain('Showing 1 of 1 results');
    });

    it('falls back to "No matching resources found." when the LLM throws and rows are empty', async () => {
        invokeMock.mockRejectedValue(new Error('model unavailable'));
        const result = await synthesizeNode(baseState({ sqlResult: { rows: [], rowCount: 0 } }));
        expect(result.finalAnswer).toBe('No matching resources found.');
    });

    it('renders a blank placeholder for a null/undefined cell in the fallback table', async () => {
        invokeMock.mockRejectedValue(new Error('model unavailable'));
        const result = await synthesizeNode(baseState({ sqlResult: { rows: [{ id: '1', name: null }], rowCount: 1 } }));
        expect(result.finalAnswer).toContain('| 1 |  |');
    });

    it('throws via requireModelConfig when modelConfig is missing and sqlResult is present', async () => {
        await expect(synthesizeNode(baseState({ modelConfig: null }))).rejects.toThrow(/resolved model config/);
    });
});
