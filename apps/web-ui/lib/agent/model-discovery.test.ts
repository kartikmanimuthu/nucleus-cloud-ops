import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const bedrockSend = vi.fn();
vi.mock('@aws-sdk/client-bedrock', () => ({
    BedrockClient: vi.fn().mockImplementation(function (this: any, opts: any) { this.opts = opts; this.send = bedrockSend; }),
    ListFoundationModelsCommand: vi.fn().mockImplementation(function (this: any, input: unknown) { this.input = input; this.__kind = 'ListFoundationModels'; }),
    ListInferenceProfilesCommand: vi.fn().mockImplementation(function (this: any, input: unknown) { this.input = input; this.__kind = 'ListInferenceProfiles'; }),
}));

import { BedrockClient } from '@aws-sdk/client-bedrock';
import { discoverModels } from './model-discovery';
import type { ProviderCredentials } from '@/lib/crypto/provider-credentials';

const creds = (overrides: Partial<ProviderCredentials> = {}): ProviderCredentials => ({
    accessKeyId: undefined, secretAccessKey: undefined, apiKey: undefined, baseUrl: undefined, ...overrides,
} as any);

describe('discoverModels — bedrock', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('prefers inference profiles for chat, and does not duplicate chat from foundation models once profiles exist', async () => {
        bedrockSend.mockImplementation((cmd: any) => {
            if (cmd.__kind === 'ListInferenceProfiles') {
                return Promise.resolve({
                    inferenceProfileSummaries: [
                        { inferenceProfileId: 'us.anthropic.claude', inferenceProfileName: 'Claude' },
                        { inferenceProfileId: 'us.amazon.titan-embed', inferenceProfileName: 'Titan Embed' },
                        { inferenceProfileId: '' },
                    ],
                });
            }
            return Promise.resolve({
                modelSummaries: [
                    { modelId: 'amazon.titan-embed-v2', modelName: 'Titan Embed v2', inferenceTypesSupported: ['ON_DEMAND'] },
                    { modelId: 'anthropic.claude-v2', modelName: 'Claude v2', inferenceTypesSupported: ['ON_DEMAND'] },
                ],
            });
        });

        const models = await discoverModels('bedrock', creds(), 'us-west-2');

        expect(models.find(m => m.id === 'us.anthropic.claude')).toBeTruthy();
        // The embed-named inference profile is excluded from the profile pass...
        expect(models.find(m => m.id === 'us.amazon.titan-embed')).toBeUndefined();
        // ...but the embedding foundation model is still surfaced.
        expect(models.find(m => m.id === 'amazon.titan-embed-v2')?.capabilities).toEqual(['embedding']);
        // Chat already satisfied by a profile — the foundation chat model is NOT duplicated.
        expect(models.find(m => m.id === 'anthropic.claude-v2')).toBeUndefined();
    });

    it('falls back to foundation-model chat models when ListInferenceProfiles is unavailable in the region', async () => {
        bedrockSend.mockImplementation((cmd: any) => {
            if (cmd.__kind === 'ListInferenceProfiles') return Promise.reject(new Error('not supported in this region'));
            return Promise.resolve({
                modelSummaries: [
                    { modelId: 'anthropic.claude-v2', modelName: 'Claude v2', inferenceTypesSupported: ['ON_DEMAND'] },
                    { modelId: 'anthropic.claude-old', inferenceTypesSupported: ['PROVISIONED'] },
                ],
            });
        });

        const models = await discoverModels('bedrock', creds());
        expect(models).toEqual([{ id: 'anthropic.claude-v2', name: 'Claude v2', capabilities: ['chat'] }]);
    });

    it('skips foundation models with no modelId, and embedding models without ON_DEMAND support', async () => {
        bedrockSend.mockImplementation((cmd: any) => {
            if (cmd.__kind === 'ListInferenceProfiles') return Promise.resolve({});
            return Promise.resolve({
                modelSummaries: [
                    { modelId: undefined },
                    { modelId: 'amazon.titan-embed-v1', inferenceTypesSupported: ['PROVISIONED'] },
                ],
            });
        });

        const models = await discoverModels('bedrock', creds());
        expect(models).toEqual([]);
    });

    it('passes explicit static credentials to BedrockClient when both keys are present', async () => {
        bedrockSend.mockResolvedValue({});
        await discoverModels('bedrock', creds({ accessKeyId: 'AK', secretAccessKey: 'SK' }), 'eu-west-1');

        expect(BedrockClient).toHaveBeenCalledWith({
            region: 'eu-west-1',
            credentials: { accessKeyId: 'AK', secretAccessKey: 'SK' },
        });
    });

    it('falls back to the host/task-role credential chain when keys are absent, and defaults region to us-east-1', async () => {
        bedrockSend.mockResolvedValue({});
        await discoverModels('bedrock', creds());

        expect(BedrockClient).toHaveBeenCalledWith({ region: 'us-east-1', credentials: undefined });
    });
});

describe('discoverModels — OpenAI-compatible providers', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('uses the provider default base URL and includes an Authorization header when an API key is set', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ data: [{ id: 'gpt-4o' }, { id: 'text-embedding-3-small' }] }),
        });
        vi.stubGlobal('fetch', fetchMock);

        const models = await discoverModels('openai', creds({ apiKey: 'sk-1' }));

        expect(fetchMock).toHaveBeenCalledWith('https://api.openai.com/v1/models', expect.objectContaining({
            headers: { Authorization: 'Bearer sk-1' },
        }));
        expect(models).toEqual([
            { id: 'gpt-4o', name: 'gpt-4o', capabilities: ['chat'] },
            { id: 'text-embedding-3-small', name: 'text-embedding-3-small', capabilities: ['embedding'] },
        ]);
    });

    it('strips a trailing slash from a custom base URL and omits Authorization when no API key is set', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ models: [] }) });
        vi.stubGlobal('fetch', fetchMock);

        await discoverModels('lmstudio', creds({ baseUrl: 'http://localhost:1234/v1/' }));

        expect(fetchMock).toHaveBeenCalledWith('http://localhost:1234/v1/models', expect.objectContaining({ headers: {} }));
    });

    it('throws when a provider with no built-in default has no base URL configured', async () => {
        await expect(discoverModels('openai-compatible', creds())).rejects.toThrow(/requires a base URL/);
    });

    it('throws a descriptive error on a non-ok response', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized' }));
        await expect(discoverModels('openai', creds({ apiKey: 'bad' }))).rejects.toThrow(/openai API error: 401 Unauthorized/);
    });

    it('derives the model id from whichever field is present, and skips entries with none', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                data: [
                    { path: 'models/llama-3' },
                    { model: 'mistral-7b' },
                    { name: 'phi-3' },
                    { model_name: 'qwen2' },
                    { title: 'gemma-2' },
                    { alias: 'aliased-model' },
                    { nothingUseful: true },
                ],
            }),
        }));
        const models = await discoverModels('vllm', creds({ baseUrl: 'http://vllm-host:8000' }));
        expect(models.map(m => m.id)).toEqual(['models/llama-3', 'mistral-7b', 'phi-3', 'qwen2', 'gemma-2', 'aliased-model']);
    });
});

describe('discoverModels — Ollama', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('defaults to localhost and strips a /v1 suffix from a custom base URL', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ models: [] }) });
        vi.stubGlobal('fetch', fetchMock);

        await discoverModels('ollama', creds({ baseUrl: 'http://ollama-host:11434/v1' }));
        expect(fetchMock).toHaveBeenCalledWith('http://ollama-host:11434/api/tags', expect.anything());
    });

    it('maps the tags response, falling back between model/name fields', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ models: [{ model: 'llama3:8b', name: 'Llama 3 8B' }, { name: 'mistral' }] }),
        }));
        const models = await discoverModels('ollama', creds());
        expect(models).toEqual([
            { id: 'llama3:8b', name: 'Llama 3 8B', capabilities: ['chat'] },
            { id: 'mistral', name: 'mistral', capabilities: ['chat'] },
        ]);
    });

    it('throws a descriptive error on a non-ok response', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: 'Server Error' }));
        await expect(discoverModels('ollama', creds())).rejects.toThrow(/Ollama API error: 500 Server Error/);
    });
});

describe('discoverModels — Anthropic', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('throws when no API key is configured', async () => {
        await expect(discoverModels('anthropic', creds())).rejects.toThrow(/requires an API key/);
    });

    it('hits the default base URL with the correct auth headers', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });
        vi.stubGlobal('fetch', fetchMock);

        await discoverModels('anthropic', creds({ apiKey: 'sk-ant-1' }));

        expect(fetchMock).toHaveBeenCalledWith('https://api.anthropic.com/v1/models', {
            headers: { 'x-api-key': 'sk-ant-1', 'anthropic-version': '2023-06-01' },
            signal: expect.anything(),
        });
    });

    it('appends /v1/models to a custom base URL that does not already end in /v1', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });
        vi.stubGlobal('fetch', fetchMock);
        await discoverModels('anthropic', creds({ apiKey: 'k', baseUrl: 'https://proxy.internal' }));
        expect(fetchMock).toHaveBeenCalledWith('https://proxy.internal/v1/models', expect.anything());
    });

    it('appends only /models to a custom base URL that already ends in /v1', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });
        vi.stubGlobal('fetch', fetchMock);
        await discoverModels('anthropic', creds({ apiKey: 'k', baseUrl: 'https://proxy.internal/v1' }));
        expect(fetchMock).toHaveBeenCalledWith('https://proxy.internal/v1/models', expect.anything());
    });

    it('throws a descriptive error on a non-ok response', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403, statusText: 'Forbidden' }));
        await expect(discoverModels('anthropic', creds({ apiKey: 'k' }))).rejects.toThrow(/Anthropic API error: 403 Forbidden/);
    });

    it('maps id + display_name, falling back to id when no display_name is present', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ data: [{ id: 'claude-x', display_name: 'Claude X' }, { id: 'claude-y' }] }),
        }));
        const models = await discoverModels('anthropic', creds({ apiKey: 'k' }));
        expect(models).toEqual([
            { id: 'claude-x', name: 'Claude X', capabilities: ['chat'] },
            { id: 'claude-y', name: 'claude-y', capabilities: ['chat'] },
        ]);
    });
});

describe('discoverModels — dispatch', () => {
    it('throws for an unsupported provider type', async () => {
        await expect(discoverModels('unknown-provider' as any, creds())).rejects.toThrow(/Unsupported provider type/);
    });
});
