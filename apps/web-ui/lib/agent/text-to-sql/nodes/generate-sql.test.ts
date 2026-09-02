import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AIMessage } from '@langchain/core/messages';

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/agent/model-factory', () => ({
    createAgentModels: vi.fn(() => ({ reflector: { invoke: invokeMock }, main: { invoke: invokeMock } })),
}));

import { generateSQLNode } from './generate-sql';
import type { TextToSQLState } from '../state';

function baseState(overrides: Partial<TextToSQLState> = {}): TextToSQLState {
    return {
        question: 'how many ec2 instances',
        conversationHistory: [],
        tenantId: 'tenant-1',
        modelConfig: { provider: 'bedrock', modelId: 'claude' } as any,
        filters: undefined,
        schemaDescription: 'id (uuid)',
        sampleRows: [],
        generatedSQL: '',
        sqlResult: null,
        sqlError: null,
        reflectionFeedback: '',
        iteration: 0,
        maxIterations: 3,
        satisfied: false,
        finalAnswer: '',
        ...overrides,
    };
}

describe('generateSQLNode', () => {
    beforeEach(() => vi.clearAllMocks());

    it('strips markdown SQL fences from the model output', async () => {
        invokeMock.mockResolvedValue(new AIMessage({ content: '```sql\nSELECT * FROM inventory_resources\n```' }));
        const result = await generateSQLNode(baseState());
        expect(result.generatedSQL).toBe('SELECT * FROM inventory_resources');
        expect(result.sqlError).toBeNull();
    });

    it('strips a bare fence with no language tag', async () => {
        invokeMock.mockResolvedValue(new AIMessage({ content: '```\nSELECT 1\n```' }));
        const result = await generateSQLNode(baseState());
        expect(result.generatedSQL).toBe('SELECT 1');
    });

    it('includes conversation history in the user message when present', async () => {
        invokeMock.mockResolvedValue(new AIMessage({ content: 'SELECT 1' }));
        await generateSQLNode(baseState({ conversationHistory: [{ role: 'user', content: 'earlier question' }] }));
        const humanMsg = invokeMock.mock.calls[0][0][1];
        expect(humanMsg.content).toContain('Conversation history:');
        expect(humanMsg.content).toContain('earlier question');
    });

    it('appends reflection feedback and the prior SQL error when retrying', async () => {
        invokeMock.mockResolvedValue(new AIMessage({ content: 'SELECT 1' }));
        await generateSQLNode(baseState({ reflectionFeedback: 'missing WHERE clause', sqlError: 'syntax error' }));
        const humanMsg = invokeMock.mock.calls[0][0][1];
        expect(humanMsg.content).toContain('Previous attempt feedback: missing WHERE clause');
        expect(humanMsg.content).toContain('Previous SQL error: syntax error');
    });

    it('throws via requireModelConfig when modelConfig is missing', async () => {
        await expect(generateSQLNode(baseState({ modelConfig: null }))).rejects.toThrow(/resolved model config/);
    });
});
