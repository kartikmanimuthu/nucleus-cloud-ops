'use client';

/**
 * TanStack Query hooks for custom LLM providers (settings → providers).
 * Fetches inlined; create/delete/toggle invalidate the list. Test is a
 * one-shot mutation that returns the raw result for the caller to render.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

export interface ProviderModel {
    id: string;
    label: string;
    maxTokens?: number;
}

export interface Provider {
    id: string;
    name: string;
    provider: string;
    baseUrl: string;
    apiKey: string | null;
    models: ProviderModel[];
    isEnabled: boolean;
    createdAt: string;
    updatedAt: string;
}

const providersKey = ['settings', 'providers'] as const;

export function useProviders() {
    return useQuery({
        queryKey: providersKey,
        queryFn: async (): Promise<Provider[]> => {
            const res = await fetch('/api/settings/providers');
            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(json.error ?? 'Failed to load providers.');
            }
            return json.data.providers ?? [];
        },
    });
}

export function useCreateProvider() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async (body: {
            name: string;
            baseUrl: string;
            apiKey?: string;
            models: ProviderModel[];
        }) => {
            const res = await fetch('/api/settings/providers', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(json.error ?? 'Failed to create provider');
            }
            return json;
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: providersKey }),
    });
}

export function useDeleteProvider() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async (id: string) => {
            const res = await fetch(`/api/settings/providers/${id}`, { method: 'DELETE' });
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json.error ?? 'Failed to delete provider');
            return json;
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: providersKey }),
    });
}

export function useToggleProvider() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async ({ id, isEnabled }: { id: string; isEnabled: boolean }) => {
            const res = await fetch(`/api/settings/providers/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ isEnabled }),
            });
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json.error ?? 'Failed to update provider');
            return json;
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: providersKey }),
    });
}

/** One-shot connectivity test; returns the raw JSON for the caller to render. */
export function useTestProvider() {
    return useMutation({
        mutationFn: async (id: string) => {
            const res = await fetch(`/api/settings/providers/${id}/test`, { method: 'POST' });
            return res.json();
        },
    });
}
