import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindMany = vi.fn();
const mockFindFirst = vi.fn();
const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();

vi.mock('@/lib/db/pg-config', () => ({
    getTenantClient: () => ({
        providerModel: {
            findMany: mockFindMany,
            findFirst: mockFindFirst,
            create: mockCreate,
            update: mockUpdate,
            delete: mockDelete,
        },
    }),
}));

// Encryption is exercised in its own unit; here we mock it to a deterministic
// stub so the service's create/update logic can be asserted without an env key.
vi.mock('@/lib/crypto/provider-credentials', () => ({
    encryptCredentials: (c: unknown) => `ENC(${JSON.stringify(c)})`,
    decryptCredentials: (s: string) => JSON.parse(s.replace(/^ENC\(/, '').replace(/\)$/, '')),
    credentialHint: () => null,
    isEncryptionConfigured: () => true,
}));

import { ProviderModelService } from './provider-model-service';

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
});
