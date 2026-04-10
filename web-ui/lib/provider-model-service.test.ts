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
            orderBy: { createdAt: 'asc' },
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

    it('createProvider creates with correct data', async () => {
        const input = { name: 'Ollama', baseUrl: 'http://ollama:11434/v1', models: [{ id: 'mistral', label: 'Mistral 7B' }] };
        const created = { id: 'p2', tenantId, ...input };
        mockCreate.mockResolvedValue(created);
        const result = await ProviderModelService.createProvider(tenantId, input);
        expect(result).toEqual(created);
        expect(mockCreate).toHaveBeenCalledWith({
            data: { tenantId, name: 'Ollama', provider: 'openai-compatible', baseUrl: 'http://ollama:11434/v1', apiKey: undefined, models: input.models, isEnabled: true },
        });
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
