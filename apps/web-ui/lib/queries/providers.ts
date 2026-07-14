'use client';

/**
 * TanStack Query hooks for LLM providers (settings → providers).
 *
 * Full multi-provider model: a provider record carries encrypted credentials, a
 * discovered model list, a selected chat/embedding model, and a default flag.
 * Discovery is a one-shot mutation used by the wizard before the record exists;
 * test/refresh/set-default operate on saved records.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

/** Provider transport types a tenant can configure. */
export type ProviderType =
    | 'bedrock'
    | 'openai'
    | 'anthropic'
    | 'ollama'
    | 'vllm'
    | 'lmstudio'
    | 'litellm'
    | 'openai-compatible';

/** A model entry stored on a provider record. */
export interface ProviderModelEntry {
    id: string;
    label: string;
    capabilities?: string[];
    maxTokens?: number;
}

/** A model returned by discovery (before it's saved onto a record). */
export interface DiscoveredModel {
    id: string;
    name: string;
    capabilities: string[];
    contextWindow?: number;
}

/** Plaintext credentials submitted by the wizard (encrypted server-side). */
export interface ProviderCredentialsInput {
    apiKey?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    baseUrl?: string;
}

/** Client-safe provider record (secrets stripped, replaced by configured flag + hint). */
export interface Provider {
    id: string;
    name: string;
    provider: string;
    region: string | null;
    baseUrl: string | null;
    credentialsConfigured: boolean;
    credentialsHint: string | null;
    chatModel: string | null;
    embeddingModel: string | null;
    embeddingDimensions: number | null;
    models: ProviderModelEntry[];
    isDefault: boolean;
    isEnabled: boolean;
    createdAt: string;
    updatedAt: string;
}

export interface CreateProviderInput {
    name: string;
    provider: ProviderType;
    region?: string;
    credentials?: ProviderCredentialsInput;
    baseUrl?: string;
    chatModel?: string;
    embeddingModel?: string;
    embeddingDimensions?: number;
    models: ProviderModelEntry[];
    isDefault?: boolean;
}

export type UpdateProviderInput = Partial<CreateProviderInput> & { isEnabled?: boolean };

const providersKey = ['settings', 'providers'] as const;
const providerModelsKey = ['settings', 'providers', 'models'] as const;

/** A flat chat-model picker entry: composite id `{provider}:{modelId}:{recordId}`. */
export interface ProviderModelOption {
    id: string;
    label: string;
    provider: string;
    /** True for the default provider's selected chat model. At most one entry. */
    isDefault?: boolean;
}

/**
 * The model a picker should land on with no explicit user choice: the default
 * provider's chat model, else the first configured model. Keeps every dropdown
 * (AI Ops, Agent Ops, KB, deep agent) agreeing on the same initial selection.
 */
export function defaultModelId(models: ProviderModelOption[]): string {
    return (models.find((m) => m.isDefault) ?? models[0])?.id ?? '';
}

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

/**
 * The flat chat-model picker list, sourced ONLY from tenant-configured providers
 * (no hardcoded Bedrock baseline). Shared by every model dropdown so the fetch,
 * response shape, and caching live in one place.
 */
export function useProviderModels() {
    return useQuery({
        queryKey: providerModelsKey,
        queryFn: async (): Promise<ProviderModelOption[]> => {
            const res = await fetch('/api/settings/providers');
            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(json.error ?? 'Failed to load models.');
            }
            return (json.data.models ?? []) as ProviderModelOption[];
        },
    });
}

/** Convenience selector for a single provider from the cached list. */
export function useProvider(id: string | undefined) {
    const query = useProviders();
    return {
        ...query,
        data: id ? query.data?.find((p) => p.id === id) : undefined,
    };
}

export function useCreateProvider() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async (body: CreateProviderInput) => {
            const res = await fetch('/api/settings/providers', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json.error ?? 'Failed to create provider');
            return json.data as Provider;
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: providersKey }),
    });
}

export function useUpdateProvider() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async ({ id, ...body }: UpdateProviderInput & { id: string }) => {
            const res = await fetch(`/api/settings/providers/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json.error ?? 'Failed to update provider');
            return json.data as Provider;
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
            return json.data as Provider;
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: providersKey }),
    });
}

/** Marks a provider as the tenant default. */
export function useSetDefaultProvider() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async (id: string) => {
            const res = await fetch(`/api/settings/providers/${id}/set-default`, { method: 'POST' });
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json.error ?? 'Failed to set default provider');
            return json.data as Provider;
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: providersKey }),
    });
}

/** Re-runs discovery on a saved provider and persists the refreshed model list. */
export function useRefreshModels() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async (id: string) => {
            const res = await fetch(`/api/settings/providers/${id}/refresh-models`, { method: 'POST' });
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json.error ?? 'Failed to refresh models');
            return json.data as Provider;
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: providersKey }),
    });
}

/**
 * Validates credentials and discovers models BEFORE a record exists (wizard
 * step 2 → 3). One-shot; does not touch the providers cache.
 */
export function useDiscoverModels() {
    return useMutation({
        mutationFn: async (input: {
            providerType: ProviderType;
            credentials: ProviderCredentialsInput;
            region?: string;
        }): Promise<DiscoveredModel[]> => {
            const res = await fetch('/api/settings/providers/discover', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(input),
            });
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json.error ?? 'Failed to discover models');
            return (json.data?.models ?? []) as DiscoveredModel[];
        },
    });
}

export interface EmbeddingProbeResult {
    /** True only when the model is invocable AND outputs `required`-dim vectors. */
    compatible: boolean;
    /** False when the model's request schema isn't supported (Cohere/Nova/multimodal). */
    supported: boolean;
    /** Effective output dimension, or null when the model couldn't be invoked. */
    dimensions: number | null;
    required: number;
    /** Human-readable reason when not compatible; null when compatible. */
    reason: string | null;
}

/**
 * Probes an embedding model's effective output dimension (after any
 * text-embedding-3 reduction) so the wizard can auto-detect + validate it
 * against the platform's fixed vector columns. One-shot; no cache.
 */
export function useProbeEmbedding() {
    return useMutation({
        mutationFn: async (input: {
            providerType: ProviderType;
            embeddingModel: string;
            credentials?: ProviderCredentialsInput;
            region?: string;
            providerId?: string;
        }): Promise<EmbeddingProbeResult> => {
            const res = await fetch('/api/settings/providers/probe-embedding', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(input),
            });
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json.error ?? 'Failed to probe embedding model');
            return json.data as EmbeddingProbeResult;
        },
    });
}

/** One-shot connectivity test on a saved provider; returns the raw JSON. */
export function useTestProvider() {
    return useMutation({
        mutationFn: async (id: string) => {
            const res = await fetch(`/api/settings/providers/${id}/test`, { method: 'POST' });
            return res.json();
        },
    });
}
