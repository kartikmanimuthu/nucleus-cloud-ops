// @vitest-environment jsdom
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

import {
    defaultModelId,
    useProviders,
    useProviderModels,
    useProvider,
    useCreateProvider,
    useUpdateProvider,
    useDeleteProvider,
    useToggleProvider,
    useSetDefaultProvider,
    useRefreshModels,
    useDiscoverModels,
    useProbeEmbedding,
    useTestProvider,
    type ProviderModelOption,
} from './providers';

function createWrapper() {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const wrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(QueryClientProvider, { client: queryClient }, children);
    return { queryClient, wrapper };
}

const jsonRes = (body: unknown, opts: { ok?: boolean } = {}) => ({
    ok: opts.ok ?? true,
    json: () => Promise.resolve(body),
});

describe('defaultModelId', () => {
    it('returns the model flagged isDefault', () => {
        const models: ProviderModelOption[] = [
            { id: 'm1', label: 'm1', provider: 'bedrock' },
            { id: 'm2', label: 'm2', provider: 'openai', isDefault: true },
        ];
        expect(defaultModelId(models)).toBe('m2');
    });

    it('falls back to the first model when none is default', () => {
        const models: ProviderModelOption[] = [
            { id: 'm1', label: 'm1', provider: 'bedrock' },
            { id: 'm2', label: 'm2', provider: 'openai' },
        ];
        expect(defaultModelId(models)).toBe('m1');
    });

    it('returns an empty string for an empty list', () => {
        expect(defaultModelId([])).toBe('');
    });
});

describe('providers queries', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
    });
    afterEach(() => vi.unstubAllGlobals());

    describe('useProviders', () => {
        it('unwraps data.providers', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: { providers: [{ id: 'p1' }] } }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useProviders(), { wrapper });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/settings/providers');
            expect(result.current.data).toEqual([{ id: 'p1' }]);
        });

        it('defaults to an empty array when data.providers is missing', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: {} }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useProviders(), { wrapper });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(result.current.data).toEqual([]);
        });

        it('throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useProviders(), { wrapper });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to load providers.');
        });
    });

    describe('useProviderModels', () => {
        it('unwraps data.models', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: { models: [{ id: 'm1' }] } }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useProviderModels(), { wrapper });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(result.current.data).toEqual([{ id: 'm1' }]);
        });

        it('throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useProviderModels(), { wrapper });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to load models.');
        });
    });

    describe('useProvider', () => {
        it('selects the provider matching id from the cached list', async () => {
            (fetch as Mock).mockResolvedValue(
                jsonRes({ success: true, data: { providers: [{ id: 'p1' }, { id: 'p2' }] } }),
            );
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useProvider('p2'), { wrapper });
            await waitFor(() => expect(result.current.data).toEqual({ id: 'p2' }));
        });

        it('returns undefined when id is undefined', async () => {
            (fetch as Mock).mockResolvedValue(
                jsonRes({ success: true, data: { providers: [{ id: 'p1' }] } }),
            );
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useProvider(undefined), { wrapper });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(result.current.data).toBeUndefined();
        });
    });

    describe('mutations', () => {
        it('useCreateProvider POSTs the body and invalidates providers', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: { id: 'p1' } }));
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useCreateProvider(), { wrapper });
            const body = { name: 'n', provider: 'bedrock' as const, models: [] };
            result.current.mutate(body);
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/settings/providers', expect.objectContaining({
                method: 'POST', body: JSON.stringify(body),
            }));
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['settings', 'providers'] });
        });

        it('useCreateProvider throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useCreateProvider(), { wrapper });
            result.current.mutate({ name: 'n', provider: 'bedrock', models: [] });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to create provider');
        });

        it('useUpdateProvider strips id from the body and PUTs to /:id', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: { id: 'p1' } }));
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useUpdateProvider(), { wrapper });
            result.current.mutate({ id: 'p1', name: 'renamed' });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/settings/providers/p1', expect.objectContaining({
                method: 'PUT', body: JSON.stringify({ name: 'renamed' }),
            }));
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['settings', 'providers'] });
        });

        it('useUpdateProvider throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useUpdateProvider(), { wrapper });
            result.current.mutate({ id: 'p1' });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to update provider');
        });

        it('useDeleteProvider DELETEs by id and invalidates providers', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true }));
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useDeleteProvider(), { wrapper });
            result.current.mutate('p1');
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/settings/providers/p1', { method: 'DELETE' });
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['settings', 'providers'] });
        });

        it('useDeleteProvider throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useDeleteProvider(), { wrapper });
            result.current.mutate('p1');
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to delete provider');
        });

        it('useToggleProvider PUTs isEnabled and invalidates providers', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: { id: 'p1' } }));
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useToggleProvider(), { wrapper });
            result.current.mutate({ id: 'p1', isEnabled: false });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/settings/providers/p1', expect.objectContaining({
                method: 'PUT', body: JSON.stringify({ isEnabled: false }),
            }));
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['settings', 'providers'] });
        });

        it('useToggleProvider throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useToggleProvider(), { wrapper });
            result.current.mutate({ id: 'p1', isEnabled: true });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to update provider');
        });

        it('useSetDefaultProvider POSTs to set-default and invalidates providers', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: { id: 'p1' } }));
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useSetDefaultProvider(), { wrapper });
            result.current.mutate('p1');
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/settings/providers/p1/set-default', { method: 'POST' });
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['settings', 'providers'] });
        });

        it('useSetDefaultProvider throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSetDefaultProvider(), { wrapper });
            result.current.mutate('p1');
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to set default provider');
        });

        it('useRefreshModels POSTs to refresh-models and invalidates providers', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: { id: 'p1' } }));
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useRefreshModels(), { wrapper });
            result.current.mutate('p1');
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/settings/providers/p1/refresh-models', { method: 'POST' });
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['settings', 'providers'] });
        });

        it('useRefreshModels throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useRefreshModels(), { wrapper });
            result.current.mutate('p1');
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to refresh models');
        });

        it('useDiscoverModels POSTs input and unwraps data.models without touching the cache', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: { models: [{ id: 'm1' }] } }));
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useDiscoverModels(), { wrapper });
            result.current.mutate({ providerType: 'bedrock', credentials: {} });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/settings/providers/discover', expect.objectContaining({ method: 'POST' }));
            expect(result.current.data).toEqual([{ id: 'm1' }]);
            expect(invalidateSpy).not.toHaveBeenCalled();
        });

        it('useDiscoverModels defaults to an empty array when data.models is missing', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: {} }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useDiscoverModels(), { wrapper });
            result.current.mutate({ providerType: 'bedrock', credentials: {} });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(result.current.data).toEqual([]);
        });

        it('useDiscoverModels throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useDiscoverModels(), { wrapper });
            result.current.mutate({ providerType: 'bedrock', credentials: {} });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to discover models');
        });

        it('useProbeEmbedding POSTs input and returns the probe result', async () => {
            (fetch as Mock).mockResolvedValue(
                jsonRes({ success: true, data: { compatible: true, supported: true, dimensions: 1536, required: 1536, reason: null } }),
            );
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useProbeEmbedding(), { wrapper });
            result.current.mutate({ providerType: 'openai', embeddingModel: 'text-embedding-3-small' });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/settings/providers/probe-embedding', expect.objectContaining({ method: 'POST' }));
            expect(result.current.data?.compatible).toBe(true);
        });

        it('useProbeEmbedding throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useProbeEmbedding(), { wrapper });
            result.current.mutate({ providerType: 'openai', embeddingModel: 'x' });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to probe embedding model');
        });

        it('useTestProvider POSTs to /:id/test and returns the raw JSON regardless of success', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false, error: 'unreachable' }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useTestProvider(), { wrapper });
            result.current.mutate('p1');
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/settings/providers/p1/test', { method: 'POST' });
            expect(result.current.data).toEqual({ success: false, error: 'unreachable' });
        });
    });
});
