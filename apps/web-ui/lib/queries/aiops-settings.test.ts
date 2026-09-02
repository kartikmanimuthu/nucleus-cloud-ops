// @vitest-environment jsdom
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

import {
    useAiopsSubagentSettings,
    useSaveAiopsSubagentSettings,
    useSaveAiopsFeatureSettings,
    type SubagentBudget,
    type AiopsFeatureConfig,
} from './aiops-settings';
import { queryKeys } from './query-keys';

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

const budget: SubagentBudget = {
    enabled: true, maxConcurrentSubagents: 2, maxSubagentsPerRun: 5,
    maxSubagentTokensPerRun: 1000, subagentMaxIterations: 10, subagentTimeoutMs: 60000,
};
const features: AiopsFeatureConfig = {
    chatTriageEnabled: true, workingMemoryEnabled: true, episodicMemoryEnabled: false,
    proceduralMemoryEnabled: false, memoryReconcileEnabled: false, autoSkillCreationEnabled: false,
    autoSkillMaturityThreshold: 3, skillSynthesisMinRules: 5, maxIterations: 10,
};

describe('aiops-settings queries', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
    });
    afterEach(() => vi.unstubAllGlobals());

    describe('useAiopsSubagentSettings', () => {
        it('returns the settings payload', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: { budget, features, platformEnabled: true } }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useAiopsSubagentSettings(), { wrapper });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/settings/aiops');
            expect(result.current.data?.platformEnabled).toBe(true);
        });

        it('throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useAiopsSubagentSettings(), { wrapper });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to load AI Ops settings');
        });

        it('treats an unparsable body as a failure', async () => {
            (fetch as Mock).mockResolvedValue({ ok: false, json: () => Promise.reject(new Error('bad json')) });
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useAiopsSubagentSettings(), { wrapper });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to load AI Ops settings');
        });
    });

    describe('useSaveAiopsSubagentSettings', () => {
        it('PUTs the budget and invalidates aiopsSettings.all, returning data.budget', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: { budget } }));
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useSaveAiopsSubagentSettings(), { wrapper });
            result.current.mutate(budget);
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/settings/aiops', expect.objectContaining({
                method: 'PUT', body: JSON.stringify(budget),
            }));
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.aiopsSettings.all });
            expect(result.current.data).toEqual(budget);
        });

        it('throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSaveAiopsSubagentSettings(), { wrapper });
            result.current.mutate(budget);
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to save AI Ops settings');
        });
    });

    describe('useSaveAiopsFeatureSettings', () => {
        it('PUTs { features } and invalidates aiopsSettings.all, returning data.features', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: { features } }));
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useSaveAiopsFeatureSettings(), { wrapper });
            result.current.mutate(features);
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/settings/aiops', expect.objectContaining({
                method: 'PUT', body: JSON.stringify({ features }),
            }));
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.aiopsSettings.all });
            expect(result.current.data).toEqual(features);
        });

        it('throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSaveAiopsFeatureSettings(), { wrapper });
            result.current.mutate(features);
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to save AI Ops settings');
        });
    });
});
