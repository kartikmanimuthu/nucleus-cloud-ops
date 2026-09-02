import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetProvider, mockGetConfigById, mockGetDefaultConfig } = vi.hoisted(() => ({
    mockGetProvider: vi.fn(),
    mockGetConfigById: vi.fn(),
    mockGetDefaultConfig: vi.fn(),
}));
vi.mock('@/lib/provider-model-service', () => ({
    ProviderModelService: { getProvider: mockGetProvider, getConfigById: mockGetConfigById, getDefaultConfig: mockGetDefaultConfig },
}));

import { resolveModelConfig, resolveDefaultModelConfig } from './model-resolver';

const UUID = '550e8400-e29b-41d4-a716-446655440000';

describe('resolveModelConfig', () => {
    beforeEach(() => vi.clearAllMocks());

    it('throws for a bare model ID — no implicit Bedrock fallback (SaaS)', async () => {
        await expect(resolveModelConfig('global.anthropic.claude-sonnet-4-6', 'tenant-1'))
            .rejects.toThrow('is not backed by a configured provider');
    });

    it('throws for a bedrock: native model ID without a provider record (SaaS)', async () => {
        await expect(resolveModelConfig('bedrock:global.anthropic.claude-sonnet-4-6', 'tenant-1'))
            .rejects.toThrow('is not backed by a configured provider');
    });

    it('resolves record-backed Bedrock model with explicit credentials', async () => {
        mockGetProvider.mockResolvedValue({
            id: UUID,
            name: 'Corp Bedrock',
            isEnabled: true,
            models: [{ id: 'us.anthropic.claude-sonnet-4-6-v1:0', label: 'Claude Sonnet 4.6', maxTokens: 8192 }],
        });
        mockGetConfigById.mockResolvedValue({
            id: UUID,
            provider: 'bedrock',
            region: 'us-west-2',
            accessKeyId: 'AKIA-test',
            secretAccessKey: 'secret-test',
        });
        const result = await resolveModelConfig(`bedrock:us.anthropic.claude-sonnet-4-6-v1:0:${UUID}`, 'tenant-1');
        expect(result).toEqual({
            provider: 'bedrock',
            modelId: 'us.anthropic.claude-sonnet-4-6-v1:0',
            region: 'us-west-2',
            accessKeyId: 'AKIA-test',
            secretAccessKey: 'secret-test',
            maxTokens: 8192,
        });
    });

    it('resolves openai-compatible model with DB lookup', async () => {
        mockGetProvider.mockResolvedValue({
            id: UUID,
            isEnabled: true,
            models: [{ id: 'meta-llama/Llama-3.3-70B', label: 'Llama 70B', maxTokens: 4096 }],
        });
        mockGetConfigById.mockResolvedValue({ baseUrl: 'http://vllm:8000/v1', apiKey: 'sk-test' });
        const result = await resolveModelConfig(`openai-compatible:meta-llama/Llama-3.3-70B:${UUID}`, 'tenant-1');
        expect(result).toEqual({
            provider: 'openai-compatible',
            modelId: 'meta-llama/Llama-3.3-70B',
            baseUrl: 'http://vllm:8000/v1',
            apiKey: 'sk-test',
            maxTokens: 4096,
        });
        expect(mockGetProvider).toHaveBeenCalledWith(UUID, 'tenant-1');
    });

    it('throws when provider record not found', async () => {
        mockGetProvider.mockResolvedValue(null);
        await expect(resolveModelConfig(`openai-compatible:llama:${UUID}`, 'tenant-1'))
            .rejects.toThrow('Provider not found or disabled');
    });

    it('throws when provider is disabled', async () => {
        mockGetProvider.mockResolvedValue({ id: UUID, isEnabled: false, models: [] });
        await expect(resolveModelConfig(`openai-compatible:llama:${UUID}`, 'tenant-1'))
            .rejects.toThrow('Provider not found or disabled');
    });

    it('resolves openai-compatible model with colon in model ID (e.g. qwen3.6:35b-a3b)', async () => {
        mockGetProvider.mockResolvedValue({
            id: UUID,
            isEnabled: true,
            models: [{ id: 'qwen3.6:35b-a3b', label: 'Qwen 3.6 35B' }],
        });
        mockGetConfigById.mockResolvedValue({ baseUrl: 'http://ollama:11434/v1', apiKey: undefined });
        const result = await resolveModelConfig(`openai-compatible:qwen3.6:35b-a3b:${UUID}`, 'tenant-1');
        expect(result).toEqual({
            provider: 'openai-compatible',
            modelId: 'qwen3.6:35b-a3b',
            baseUrl: 'http://ollama:11434/v1',
            apiKey: undefined,
            maxTokens: undefined,
        });
        expect(mockGetProvider).toHaveBeenCalledWith(UUID, 'tenant-1');
    });

    it('throws when model not in provider model list', async () => {
        mockGetProvider.mockResolvedValue({
            id: UUID, isEnabled: true,
            models: [{ id: 'other-model', label: 'Other' }],
        });
        await expect(resolveModelConfig(`openai-compatible:llama:${UUID}`, 'tenant-1'))
            .rejects.toThrow('Model "llama" is not available');
    });

    it('resolves anthropic model with DB lookup', async () => {
        mockGetProvider.mockResolvedValue({
            id: UUID,
            name: 'Anthropic',
            isEnabled: true,
            models: [{ id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4', maxTokens: 8192 }],
        });
        mockGetConfigById.mockResolvedValue({ baseUrl: 'https://api.anthropic.com/v1', apiKey: 'sk-ant-test' });
        const result = await resolveModelConfig(`anthropic:claude-sonnet-4-20250514:${UUID}`, 'tenant-1');
        expect(result).toEqual({
            provider: 'anthropic',
            modelId: 'claude-sonnet-4-20250514',
            baseUrl: 'https://api.anthropic.com/v1',
            apiKey: 'sk-ant-test',
            maxTokens: 8192,
        });
        expect(mockGetProvider).toHaveBeenCalledWith(UUID, 'tenant-1');
    });

    it('resolves ollama model with colon in model ID (e.g. llama3.3:70b)', async () => {
        mockGetProvider.mockResolvedValue({
            id: UUID,
            name: 'Local Ollama',
            isEnabled: true,
            models: [{ id: 'llama3.3:70b', label: 'Llama 3.3 70B' }],
        });
        mockGetConfigById.mockResolvedValue({ baseUrl: 'http://localhost:11434/v1', apiKey: undefined });
        const result = await resolveModelConfig(`ollama:llama3.3:70b:${UUID}`, 'tenant-1');
        expect(result).toEqual({
            provider: 'ollama',
            modelId: 'llama3.3:70b',
            baseUrl: 'http://localhost:11434/v1',
            apiKey: undefined,
            maxTokens: undefined,
        });
        expect(mockGetProvider).toHaveBeenCalledWith(UUID, 'tenant-1');
    });

    it('throws when the Bedrock provider config cannot be decrypted/found after passing the record check', async () => {
        mockGetProvider.mockResolvedValue({
            id: UUID, isEnabled: true,
            models: [{ id: 'model-x', label: 'Model X' }],
        });
        mockGetConfigById.mockResolvedValue(null);
        await expect(resolveModelConfig(`bedrock:model-x:${UUID}`, 'tenant-1'))
            .rejects.toThrow('Provider not found or disabled');
    });

    it('throws when a record-backed (non-Bedrock) provider config cannot be found after passing the record check', async () => {
        mockGetProvider.mockResolvedValue({
            id: UUID, isEnabled: true,
            models: [{ id: 'model-x', label: 'Model X' }],
        });
        mockGetConfigById.mockResolvedValue(null);
        await expect(resolveModelConfig(`anthropic:model-x:${UUID}`, 'tenant-1'))
            .rejects.toThrow('Provider not found or disabled');
    });
});

describe('resolveDefaultModelConfig', () => {
    beforeEach(() => vi.clearAllMocks());

    it('throws when the tenant has no default provider', async () => {
        mockGetDefaultConfig.mockResolvedValue(null);
        await expect(resolveDefaultModelConfig('tenant-1')).rejects.toThrow('provider');
    });

    it('throws when the default provider has no chat model selected', async () => {
        mockGetDefaultConfig.mockResolvedValue({ provider: 'anthropic', chatModel: undefined, models: [] });
        await expect(resolveDefaultModelConfig('tenant-1')).rejects.toThrow('no chat model selected');
    });

    it('resolves the tenant default config into a ResolvedModelConfig for Bedrock', async () => {
        mockGetDefaultConfig.mockResolvedValue({
            provider: 'bedrock', chatModel: 'claude-sonnet',
            region: 'us-east-1', accessKeyId: 'AK', secretAccessKey: 'SK',
            models: [{ id: 'claude-sonnet', maxTokens: 4096, temperature: 0.2 }],
        });
        const result = await resolveDefaultModelConfig('tenant-1');
        expect(result).toEqual({
            provider: 'bedrock', modelId: 'claude-sonnet', region: 'us-east-1',
            accessKeyId: 'AK', secretAccessKey: 'SK', maxTokens: 4096, temperature: 0.2,
        });
    });

    it('resolves the tenant default config for a non-Bedrock provider, defaulting maxTokens/temperature when the model entry is absent', async () => {
        mockGetDefaultConfig.mockResolvedValue({
            provider: 'openai', chatModel: 'gpt-4', baseUrl: undefined, apiKey: 'sk-x', models: [],
        });
        const result = await resolveDefaultModelConfig('tenant-1');
        expect(result).toEqual({
            provider: 'openai', modelId: 'gpt-4', baseUrl: undefined, apiKey: 'sk-x',
            maxTokens: undefined, temperature: undefined,
        });
    });
});
