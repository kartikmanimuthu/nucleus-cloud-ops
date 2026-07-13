/**
 * Reflector model budget — regression test for the reflector token starvation.
 *
 * Claude Sonnet 5 (Bedrock) emits a reasoning_content block before its text.
 * The reflector was capped at min(maxTokens, 2048); the model spent the entire
 * budget on reasoning, stopped at max_tokens with ZERO text, and the empty
 * critique drove the fast-agent reflection loop in circles.
 */

import { describe, it, expect } from 'vitest';
import { createAgentModels, DEFAULT_MAX_OUTPUT_TOKENS } from '../../lib/agent/model-factory';
import type { ResolvedModelConfig } from '../../lib/agent/agent-shared';

const bedrockConfig: ResolvedModelConfig = {
    provider: 'bedrock',
    modelId: 'global.anthropic.claude-sonnet-5',
    region: 'ap-south-1',
    accessKeyId: 'test-key',
    secretAccessKey: 'test-secret',
};

describe('createAgentModels reflector budget', () => {
    it('gives the Bedrock reflector the full default output budget (no 2048 clamp)', () => {
        const { reflector } = createAgentModels(bedrockConfig);
        expect((reflector as any).maxTokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    });

    it('gives the Anthropic reflector the full default output budget (no 2048 clamp)', () => {
        const { reflector } = createAgentModels({
            provider: 'anthropic',
            modelId: 'claude-sonnet-5',
            apiKey: 'test-key',
        });
        expect((reflector as any).maxTokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    });
});
