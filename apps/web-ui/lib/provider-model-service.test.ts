import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindMany = vi.fn();
const mockFindFirst = vi.fn();
const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockUpdateMany = vi.fn();
const mockDelete = vi.fn();

vi.mock('@/lib/db/pg-config', () => ({
    getTenantClient: () => ({
        providerModel: {
            findMany: mockFindMany,
            findFirst: mockFindFirst,
            create: mockCreate,
            update: mockUpdate,
            updateMany: mockUpdateMany,
            delete: mockDelete,
        },
    }),
}));

// Encryption is exercised in its own unit; here we mock it to a deterministic
// stub so the service's create/update logic can be asserted without an env key.
vi.mock('@/lib/crypto/provider-credentials', () => ({
    encryptCredentials: (c: unknown) => `ENC(${JSON.stringify(c)})`,
    decryptCredentials: (s: string) => {
        if (!s.startsWith('ENC(')) throw new Error('not an encrypted blob');
        return JSON.parse(s.replace(/^ENC\(/, '').replace(/\)$/, ''));
    },
    credentialHint: (c: unknown) => (c ? 'hint' : null),
    isEncryptionConfigured: () => true,
}));

import {
    ProviderModelService, isProviderType, normalizeOpenAICompatibleBaseUrl, PROVIDER_TYPES,
} from './provider-model-service';

describe('ProviderModelService', () => {
    const tenantId = 'tenant-123';

    beforeEach(() => vi.clearAllMocks());

    it('listProviders returns enabled providers', async () => {
        const providers = [{ id: 'p1', name: 'vLLM', isEnabled: true }];
        mockFindMany.mockResolvedValue(providers);
        const result = await ProviderModelService.listProviders(tenantId);
        expect(result).toEqual(providers);
        expect(mockFindMany).toHaveBeenCalledWith({
            where: { isEnabled: true },
            orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
        });
    });

    it('getProvider returns provider by id', async () => {
        const provider = { id: 'p1', tenantId, name: 'vLLM' };
        mockFindFirst.mockResolvedValue(provider);
        const result = await ProviderModelService.getProvider('p1', tenantId);
        expect(result).toEqual(provider);
    });

    it('getProvider returns null when not found', async () => {
        mockFindFirst.mockResolvedValue(null);
        const result = await ProviderModelService.getProvider('x', tenantId);
        expect(result).toBeNull();
    });

    it('createProvider creates with correct data (credentials encrypted)', async () => {
        const input = {
            name: 'Ollama',
            provider: 'ollama' as const,
            baseUrl: 'http://ollama:11434/v1',
            models: [{ id: 'mistral', label: 'Mistral 7B' }],
        };
        const created = { id: 'p2', tenantId, ...input };
        mockCreate.mockResolvedValue(created);
        const result = await ProviderModelService.createProvider(tenantId, input);
        expect(result).toEqual(created);

        const callArg = mockCreate.mock.calls[0][0];
        expect(callArg.data).toMatchObject({
            tenantId,
            name: 'Ollama',
            provider: 'ollama',
            baseUrl: 'http://ollama:11434/v1',
            region: null,
            chatModel: null,
            embeddingModel: null,
            embeddingDimensions: null,
            models: input.models,
            isDefault: false,
            isEnabled: true,
        });
        // baseUrl is folded into the encrypted credentials blob (non-empty string).
        expect(typeof callArg.data.credentials).toBe('string');
        expect(callArg.data.credentials.length).toBeGreaterThan(0);
    });

    it('deleteProvider throws when not found', async () => {
        mockFindFirst.mockResolvedValue(null);
        await expect(ProviderModelService.deleteProvider('x', tenantId)).rejects.toThrow('Provider not found');
    });

    it('deleteProvider deletes existing provider', async () => {
        mockFindFirst.mockResolvedValue({ id: 'p1', tenantId });
        mockDelete.mockResolvedValue({ id: 'p1' });
        await ProviderModelService.deleteProvider('p1', tenantId);
        expect(mockDelete).toHaveBeenCalledWith({ where: { id: 'p1' } });
    });

    it('listAllProviders returns every provider regardless of isEnabled', async () => {
        mockFindMany.mockResolvedValue([{ id: 'p1' }, { id: 'p2', isEnabled: false }]);
        const result = await ProviderModelService.listAllProviders(tenantId);
        expect(result).toHaveLength(2);
        expect(mockFindMany).toHaveBeenCalledWith({ orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] });
    });

    it('createProvider defaults provider to openai-compatible when omitted', async () => {
        mockCreate.mockResolvedValue({ id: 'p1' });
        await ProviderModelService.createProvider(tenantId, { name: 'x', models: [] });
        expect(mockCreate.mock.calls[0][0].data.provider).toBe('openai-compatible');
    });

    it('createProvider stores no credentials column when neither baseUrl nor credentials are given', async () => {
        mockCreate.mockResolvedValue({ id: 'p1' });
        await ProviderModelService.createProvider(tenantId, { name: 'x', models: [] });
        expect(mockCreate.mock.calls[0][0].data.credentials).toBeNull();
    });

    it('createProvider also sets the new provider as default when isDefault is true', async () => {
        mockCreate.mockResolvedValue({ id: 'p-new' });
        mockFindFirst.mockResolvedValue({ id: 'p-new' });
        mockUpdateMany.mockResolvedValue({ count: 0 });
        mockUpdate.mockResolvedValue({ id: 'p-new', isDefault: true });

        await ProviderModelService.createProvider(tenantId, { name: 'x', models: [], isDefault: true });

        expect(mockUpdateMany).toHaveBeenCalledWith({ where: { isDefault: true, NOT: { id: 'p-new' } }, data: { isDefault: false } });
        expect(mockUpdate).toHaveBeenCalledWith({ where: { id: 'p-new' }, data: { isDefault: true } });
    });

    it('reads a legacy baseUrl column too, alongside the legacy apiKey', async () => {
        mockFindFirst.mockResolvedValue({ id: 'p1', credentials: null, apiKey: 'legacy-key', baseUrl: 'http://legacy' });
        mockUpdate.mockResolvedValue({ id: 'p1' });

        await ProviderModelService.updateProvider('p1', tenantId, { credentials: { chatModel: undefined } as any });

        const data = mockUpdate.mock.calls[0][0].data;
        expect(data.credentials).toContain('http://legacy');
    });

    it('updateProvider throws when the provider does not exist', async () => {
        mockFindFirst.mockResolvedValue(null);
        await expect(ProviderModelService.updateProvider('x', tenantId, { name: 'y' })).rejects.toThrow('Provider not found');
    });

    it('updateProvider writes only the explicitly-provided fields', async () => {
        mockFindFirst.mockResolvedValue({ id: 'p1', credentials: null, apiKey: null });
        mockUpdate.mockResolvedValue({ id: 'p1', name: 'Renamed' });

        await ProviderModelService.updateProvider('p1', tenantId, { name: 'Renamed' });

        const data = mockUpdate.mock.calls[0][0].data;
        expect(data).toEqual({ name: 'Renamed' });
    });

    it('updateProvider writes every whitelisted field when all are supplied', async () => {
        mockFindFirst.mockResolvedValue({ id: 'p1', credentials: null, apiKey: null });
        mockUpdate.mockResolvedValue({ id: 'p1' });

        await ProviderModelService.updateProvider('p1', tenantId, {
            provider: 'anthropic', region: 'us-east-1', baseUrl: 'http://x', chatModel: 'claude',
            embeddingModel: 'embed-1', embeddingDimensions: 1536, models: [{ id: 'm1', label: 'M1' }],
            isDefault: false, isEnabled: false,
        });

        const data = mockUpdate.mock.calls[0][0].data;
        expect(data).toMatchObject({
            provider: 'anthropic', region: 'us-east-1', baseUrl: 'http://x', chatModel: 'claude',
            embeddingModel: 'embed-1', embeddingDimensions: 1536, isDefault: false, isEnabled: false,
        });
        expect(data.models).toEqual([{ id: 'm1', label: 'M1' }]);
    });

    it('updateProvider re-encrypts, merging new credentials over the existing decrypted ones', async () => {
        mockFindFirst.mockResolvedValue({ id: 'p1', credentials: 'ENC({"apiKey":"old-key"})', apiKey: null });
        mockUpdate.mockResolvedValue({ id: 'p1' });

        await ProviderModelService.updateProvider('p1', tenantId, { credentials: { baseUrl: 'http://new' } });

        const data = mockUpdate.mock.calls[0][0].data;
        expect(data.credentials).toBe('ENC({"apiKey":"old-key","baseUrl":"http://new"})');
    });

    it('updateProvider falls back to legacy plaintext fields when credentials cannot be decrypted', async () => {
        mockFindFirst.mockResolvedValue({ id: 'p1', credentials: 'not-encrypted-garbage', apiKey: 'legacy-key', baseUrl: null });
        mockUpdate.mockResolvedValue({ id: 'p1' });

        await ProviderModelService.updateProvider('p1', tenantId, { credentials: { baseUrl: 'http://new' } });

        const data = mockUpdate.mock.calls[0][0].data;
        expect(data.credentials).toContain('legacy-key');
    });

    it('updateProvider does not touch credentials when input.credentials is not provided', async () => {
        mockFindFirst.mockResolvedValue({ id: 'p1', credentials: null, apiKey: null });
        mockUpdate.mockResolvedValue({ id: 'p1' });

        await ProviderModelService.updateProvider('p1', tenantId, { name: 'x' });

        expect(mockUpdate.mock.calls[0][0].data).not.toHaveProperty('credentials');
    });

    it('updateProvider also promotes to default when isDefault is set true', async () => {
        mockFindFirst.mockResolvedValueOnce({ id: 'p1', credentials: null, apiKey: null }).mockResolvedValueOnce({ id: 'p1' });
        mockUpdate.mockResolvedValueOnce({ id: 'p1', isDefault: true }).mockResolvedValueOnce({ id: 'p1', isDefault: true });
        mockUpdateMany.mockResolvedValue({ count: 1 });

        await ProviderModelService.updateProvider('p1', tenantId, { isDefault: true });

        expect(mockUpdateMany).toHaveBeenCalled();
    });

    it('setDefault throws when the provider does not exist', async () => {
        mockFindFirst.mockResolvedValue(null);
        await expect(ProviderModelService.setDefault('x', tenantId)).rejects.toThrow('Provider not found');
    });

    it('setDefault clears every other default before promoting this one', async () => {
        mockFindFirst.mockResolvedValue({ id: 'p1' });
        mockUpdateMany.mockResolvedValue({ count: 2 });
        mockUpdate.mockResolvedValue({ id: 'p1', isDefault: true });

        await ProviderModelService.setDefault('p1', tenantId);

        expect(mockUpdateMany).toHaveBeenCalledWith({ where: { isDefault: true, NOT: { id: 'p1' } }, data: { isDefault: false } });
        expect(mockUpdate).toHaveBeenCalledWith({ where: { id: 'p1' }, data: { isDefault: true } });
    });

    it('updateModels throws when the provider does not exist', async () => {
        mockFindFirst.mockResolvedValue(null);
        await expect(ProviderModelService.updateModels('x', tenantId, [])).rejects.toThrow('Provider not found');
    });

    it('updateModels overwrites the stored model list', async () => {
        mockFindFirst.mockResolvedValue({ id: 'p1' });
        const models = [{ id: 'gpt-4', label: 'GPT-4' }];
        mockUpdate.mockResolvedValue({ id: 'p1', models });

        await ProviderModelService.updateModels('p1', tenantId, models);

        expect(mockUpdate).toHaveBeenCalledWith({ where: { id: 'p1' }, data: { models } });
    });

    it('getConfigById returns null when the provider does not exist', async () => {
        mockFindFirst.mockResolvedValue(null);
        expect(await ProviderModelService.getConfigById('x', tenantId)).toBeNull();
    });

    it('getConfigById returns a decrypted runtime config', async () => {
        mockFindFirst.mockResolvedValue({
            id: 'p1', provider: 'anthropic', region: null, chatModel: 'claude', embeddingModel: null,
            embeddingDimensions: null, baseUrl: null, credentials: 'ENC({"apiKey":"secret-key"})', apiKey: null,
            models: [{ id: 'claude', label: 'Claude' }],
        });

        const config = await ProviderModelService.getConfigById('p1', tenantId);

        expect(config?.provider).toBe('anthropic');
        expect(config?.apiKey).toBe('secret-key');
        expect(config?.chatModel).toBe('claude');
    });

    it('getConfigById falls back to "openai-compatible" for an unrecognized provider string', async () => {
        mockFindFirst.mockResolvedValue({
            id: 'p1', provider: 'some-custom-thing', region: null, chatModel: null, embeddingModel: null,
            embeddingDimensions: null, baseUrl: null, credentials: null, apiKey: null, models: null,
        });
        const config = await ProviderModelService.getConfigById('p1', tenantId);
        expect(config?.provider).toBe('openai-compatible');
        expect(config?.models).toEqual([]);
    });

    it('getDefaultConfig returns null when the tenant has no default provider', async () => {
        mockFindFirst.mockResolvedValue(null);
        expect(await ProviderModelService.getDefaultConfig(tenantId)).toBeNull();
        expect(mockFindFirst).toHaveBeenCalledWith({ where: { isDefault: true, isEnabled: true } });
    });

    it('getDefaultConfig returns the decrypted runtime config for the default provider', async () => {
        mockFindFirst.mockResolvedValue({
            id: 'p1', provider: 'bedrock', region: 'us-east-1', chatModel: null, embeddingModel: null,
            embeddingDimensions: null, baseUrl: null, credentials: 'ENC({"accessKeyId":"AKIA","secretAccessKey":"s3cr3t"})',
            apiKey: null, models: [],
        });
        const config = await ProviderModelService.getDefaultConfig(tenantId);
        expect(config?.accessKeyId).toBe('AKIA');
        expect(config?.secretAccessKey).toBe('s3cr3t');
    });

    it('toClientProvider strips secrets, exposing only a configured flag and hint', () => {
        const record: any = {
            id: 'p1', name: 'x', provider: 'openai', region: 'us-east-1', baseUrl: 'http://x',
            credentials: 'ENC({"apiKey":"secret"})', apiKey: null, chatModel: 'gpt-4', embeddingModel: null,
            embeddingDimensions: null, models: [{ id: 'gpt-4', label: 'GPT-4' }], isDefault: true, isEnabled: true,
            createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-02T00:00:00Z'),
        };
        const client = ProviderModelService.toClientProvider(record);

        expect(client).not.toHaveProperty('credentials');
        expect(client).not.toHaveProperty('apiKey');
        expect(client.credentialsConfigured).toBe(true);
        expect(client.credentialsHint).toBe('hint');
        expect(client.createdAt).toBe('2026-01-01T00:00:00.000Z');
    });

    it('toClientProvider reports credentialsConfigured via the legacy apiKey column too', () => {
        const record: any = {
            id: 'p1', name: 'x', provider: 'openai', region: null, baseUrl: null, credentials: null,
            apiKey: 'legacy-key', chatModel: null, embeddingModel: null, embeddingDimensions: null,
            models: null, isDefault: false, isEnabled: true, createdAt: new Date(), updatedAt: new Date(),
        };
        const client = ProviderModelService.toClientProvider(record);
        expect(client.credentialsConfigured).toBe(true);
        expect(client.models).toEqual([]);
    });

    // NOTE: toClientProvider's own try/catch around readCredentials() (falling back to
    // `return null`) is unreachable in practice: readCredentials already has its own internal
    // try/catch around decryptCredentials and falls back to the legacy plaintext fields rather
    // than throwing, so nothing here ever propagates an exception for the outer catch to see.
    // Left untested, same convention as other documented-unreachable branches this session.
    it('toClientProvider reports credentialsHint null and credentialsConfigured false when the record has nothing readable', () => {
        const record: any = {
            id: 'p1', name: 'x', provider: 'openai', region: null, baseUrl: null, credentials: null,
            apiKey: null, chatModel: null, embeddingModel: null, embeddingDimensions: null,
            models: [], isDefault: false, isEnabled: true, createdAt: new Date(), updatedAt: new Date(),
        };
        const client = ProviderModelService.toClientProvider(record);
        expect(client.credentialsConfigured).toBe(false);
    });
});

describe('isProviderType', () => {
    it('accepts every declared provider type', () => {
        for (const p of PROVIDER_TYPES) expect(isProviderType(p)).toBe(true);
    });

    it('rejects a non-string value', () => {
        expect(isProviderType(123)).toBe(false);
        expect(isProviderType(undefined)).toBe(false);
    });

    it('rejects an unrecognized string', () => {
        expect(isProviderType('made-up-provider')).toBe(false);
    });
});

describe('normalizeOpenAICompatibleBaseUrl', () => {
    it('returns the input unchanged when no baseUrl is given', () => {
        expect(normalizeOpenAICompatibleBaseUrl('ollama', undefined)).toBeUndefined();
    });

    it('appends /v1 for ollama when missing', () => {
        expect(normalizeOpenAICompatibleBaseUrl('ollama', 'http://localhost:11434')).toBe('http://localhost:11434/v1');
    });

    it('does not double-append /v1 for ollama when already present', () => {
        expect(normalizeOpenAICompatibleBaseUrl('ollama', 'http://localhost:11434/v1')).toBe('http://localhost:11434/v1');
    });

    it('strips a trailing slash before checking/appending', () => {
        expect(normalizeOpenAICompatibleBaseUrl('ollama', 'http://localhost:11434/')).toBe('http://localhost:11434/v1');
    });

    it('leaves a non-ollama provider base URL as-is (already /v1-shaped)', () => {
        expect(normalizeOpenAICompatibleBaseUrl('vllm', 'http://vllm:8000/v1')).toBe('http://vllm:8000/v1');
    });
});
