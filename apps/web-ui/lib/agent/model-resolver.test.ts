import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetProvider } = vi.hoisted(() => ({ mockGetProvider: vi.fn() }));
vi.mock('@/lib/provider-model-service', () => ({
    ProviderModelService: { getProvider: mockGetProvider },
}));

import { resolveModelConfig } from './model-resolver';

describe('resolveModelConfig', () => {
    beforeEach(() => vi.clearAllMocks());

    it('resolves bare Bedrock model ID (backward compat)', async () => {
        const result = await resolveModelConfig('global.anthropic.claude-sonnet-4-6', 'tenant-1');
        expect(result).toEqual({ provider: 'bedrock', modelId: 'global.anthropic.claude-sonnet-4-6' });
    });

    it('resolves bedrock: prefixed model ID', async () => {
        const result = await resolveModelConfig('bedrock:global.anthropic.claude-sonnet-4-6', 'tenant-1');
        expect(result).toEqual({ provider: 'bedrock', modelId: 'global.anthropic.claude-sonnet-4-6' });
    });

    it('resolves openai-compatible model with DB lookup', async () => {
        mockGetProvider.mockResolvedValue({
            id: 'prov-uuid',
            baseUrl: 'http://vllm:8000/v1',
            apiKey: 'sk-test',
            models: [{ id: 'meta-llama/Llama-3.3-70B', label: 'Llama 70B', maxTokens: 4096 }],
            isEnabled: true,
        });
        const result = await resolveModelConfig('openai-compatible:meta-llama/Llama-3.3-70B:prov-uuid', 'tenant-1');
        expect(result).toEqual({
            provider: 'openai-compatible',
            modelId: 'meta-llama/Llama-3.3-70B',
            baseUrl: 'http://vllm:8000/v1',
            apiKey: 'sk-test',
            maxTokens: 4096,
        });
        expect(mockGetProvider).toHaveBeenCalledWith('prov-uuid', 'tenant-1');
    });

    it('throws when provider record not found', async () => {
        mockGetProvider.mockResolvedValue(null);
        await expect(resolveModelConfig('openai-compatible:llama:bad-uuid', 'tenant-1'))
            .rejects.toThrow('Provider not found or disabled');
    });

    it('throws when provider is disabled', async () => {
        mockGetProvider.mockResolvedValue({ id: 'prov-uuid', isEnabled: false, models: [] });
        await expect(resolveModelConfig('openai-compatible:llama:prov-uuid', 'tenant-1'))
            .rejects.toThrow('Provider not found or disabled');
    });

    it('resolves openai-compatible model with colon in model ID (e.g. qwen3.6:35b-a3b)', async () => {
        mockGetProvider.mockResolvedValue({
            id: 'prov-uuid',
            baseUrl: 'http://ollama:11434/v1',
            apiKey: null,
            models: [{ id: 'qwen3.6:35b-a3b', label: 'Qwen 3.6 35B' }],
            isEnabled: true,
        });
        const result = await resolveModelConfig('openai-compatible:qwen3.6:35b-a3b:prov-uuid', 'tenant-1');
        expect(result).toEqual({
            provider: 'openai-compatible',
            modelId: 'qwen3.6:35b-a3b',
            baseUrl: 'http://ollama:11434/v1',
            apiKey: undefined,
            maxTokens: undefined,
        });
        expect(mockGetProvider).toHaveBeenCalledWith('prov-uuid', 'tenant-1');
    });

    it('throws when model not in provider model list', async () => {
        mockGetProvider.mockResolvedValue({
            id: 'prov-uuid', isEnabled: true, baseUrl: 'http://vllm:8000/v1',
            models: [{ id: 'other-model', label: 'Other' }],
        });
        await expect(resolveModelConfig('openai-compatible:llama:prov-uuid', 'tenant-1'))
            .rejects.toThrow('Model "llama" is not available');
    });
});
