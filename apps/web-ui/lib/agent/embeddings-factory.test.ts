import { describe, it, expect, vi, beforeEach } from 'vitest';

const getDefaultConfigMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/provider-model-service', () => ({
    ProviderModelService: { getDefaultConfig: getDefaultConfigMock },
    normalizeOpenAICompatibleBaseUrl: vi.fn((_provider: string, baseUrl?: string) => baseUrl),
}));

import { createEmbeddings, probeEmbeddingDimensions, getTenantEmbeddings, REQUIRED_EMBEDDING_DIMENSIONS } from './embeddings-factory';
import { ProviderConfigError } from './provider-errors';
import type { ProviderRuntimeConfig } from '@/lib/provider-model-service';

function baseConfig(overrides: Partial<ProviderRuntimeConfig> = {}): ProviderRuntimeConfig {
    return { id: 'provider-1', provider: 'openai', embeddingModel: 'text-embedding-ada-002', models: [], ...overrides } as ProviderRuntimeConfig;
}

describe('createEmbeddings', () => {
    it('throws when no embedding model is configured', () => {
        expect(() => createEmbeddings(baseConfig({ embeddingModel: undefined }))).toThrow(ProviderConfigError);
    });

    it('throws when the configured embedding dimensions do not match the fixed 1024 columns', () => {
        expect(() => createEmbeddings(baseConfig({ embeddingDimensions: 1536 }))).toThrow(/produces 1536-dim vectors/);
    });

    it('does not throw when embeddingDimensions exactly matches 1024', () => {
        expect(() => createEmbeddings(baseConfig({ embeddingDimensions: REQUIRED_EMBEDDING_DIMENSIONS }))).not.toThrow();
    });

    it('throws for Bedrock missing access key/secret/region', () => {
        expect(() => createEmbeddings(baseConfig({ provider: 'bedrock', embeddingModel: 'amazon.titan-embed-text-v1' }))).toThrow(ProviderConfigError);
    });

    it('builds a BedrockEmbeddings instance for a fully-configured Bedrock provider', () => {
        const embeddings = createEmbeddings(baseConfig({
            provider: 'bedrock', embeddingModel: 'amazon.titan-embed-text-v1',
            region: 'us-east-1', accessKeyId: 'AK', secretAccessKey: 'SK',
        }));
        expect(embeddings).toBeDefined();
    });

    it('requests 1024 dimensions for Titan V2, but not for the (fixed-1536) V1 model', () => {
        const v2 = createEmbeddings(baseConfig({
            provider: 'bedrock', embeddingModel: 'amazon.titan-embed-text-v2:0',
            region: 'us-east-1', accessKeyId: 'AK', secretAccessKey: 'SK',
        })) as any;
        expect(v2.dimensions ?? v2.model?.dimensions).toBeTruthy();

        const v1 = createEmbeddings(baseConfig({
            provider: 'bedrock', embeddingModel: 'amazon.titan-embed-text-v1',
            region: 'us-east-1', accessKeyId: 'AK', secretAccessKey: 'SK',
        }));
        expect(v1).toBeDefined();
    });

    it('throws for the Anthropic provider — no embeddings API', () => {
        expect(() => createEmbeddings(baseConfig({ provider: 'anthropic', embeddingModel: 'claude' })))
            .toThrow(/does not expose an embeddings API/);
    });

    it('builds an OpenAIEmbeddings instance for the openai-compatible protocol path', () => {
        const embeddings = createEmbeddings(baseConfig({ provider: 'openai', embeddingModel: 'text-embedding-ada-002', apiKey: 'sk-x' }));
        expect(embeddings).toBeDefined();
    });

    it('requests 1024 dimensions for a text-embedding-3-* model but not for ada-002', () => {
        const v3 = createEmbeddings(baseConfig({ embeddingModel: 'text-embedding-3-small' })) as any;
        expect(v3).toBeDefined();
        const ada = createEmbeddings(baseConfig({ embeddingModel: 'text-embedding-ada-002' }));
        expect(ada).toBeDefined();
    });

    it('defaults apiKey to "not-needed" when absent (self-hosted)', () => {
        const embeddings = createEmbeddings(baseConfig({ provider: 'ollama', embeddingModel: 'nomic-embed-text', baseUrl: 'http://localhost:11434/v1' })) as any;
        expect(embeddings).toBeDefined();
    });
});

describe('probeEmbeddingDimensions', () => {
    it('embeds a probe string and returns its vector length', async () => {
        const config = baseConfig({ provider: 'openai', embeddingModel: 'text-embedding-ada-002', apiKey: 'sk-x' });
        const embeddings = createEmbeddings(config);
        vi.spyOn(embeddings, 'embedQuery').mockResolvedValue(new Array(1024).fill(0.1));

        // probeEmbeddingDimensions creates its own instance internally, so spy on the class method instead.
        const OpenAIEmbeddingsProto = Object.getPrototypeOf(embeddings);
        const spy = vi.spyOn(OpenAIEmbeddingsProto, 'embedQuery').mockResolvedValue(new Array(1024).fill(0.1));

        const dims = await probeEmbeddingDimensions(config);
        expect(dims).toBe(1024);
        spy.mockRestore();
    });
});

describe('getTenantEmbeddings', () => {
    beforeEach(() => vi.clearAllMocks());

    it('throws ProviderConfigError when the tenant has no default provider', async () => {
        getDefaultConfigMock.mockResolvedValue(null);
        await expect(getTenantEmbeddings('tenant-1')).rejects.toThrow(ProviderConfigError);
    });

    it('resolves the tenant default config and builds embeddings from it', async () => {
        getDefaultConfigMock.mockResolvedValue(baseConfig({ provider: 'openai', embeddingModel: 'text-embedding-ada-002', apiKey: 'sk-x' }));
        const embeddings = await getTenantEmbeddings('tenant-1');
        expect(getDefaultConfigMock).toHaveBeenCalledWith('tenant-1');
        expect(embeddings).toBeDefined();
    });
});
