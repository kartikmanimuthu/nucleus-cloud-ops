import { describe, it, expect } from 'vitest';
import { requireModelConfig, type TextToSQLState } from './state';

function baseState(overrides: Partial<TextToSQLState> = {}): TextToSQLState {
    return {
        question: 'how many ec2 instances',
        conversationHistory: [],
        tenantId: 'tenant-1',
        modelConfig: null,
        filters: undefined,
        schemaDescription: '',
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

describe('requireModelConfig', () => {
    it('throws a clear error when modelConfig is missing', () => {
        expect(() => requireModelConfig(baseState({ modelConfig: null }))).toThrow(
            /invoked without a resolved model config/,
        );
    });

    it('returns the resolved config when present', () => {
        const modelConfig = { provider: 'bedrock' as const, modelId: 'claude' };
        expect(requireModelConfig(baseState({ modelConfig }))).toBe(modelConfig);
    });
});
