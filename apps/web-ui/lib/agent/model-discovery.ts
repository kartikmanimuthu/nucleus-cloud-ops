/**
 * model-discovery.ts
 *
 * Polymorphic model discovery for LLM providers, ported from the chatbot
 * project's discovery layer. Given a provider type + credentials, fetches the
 * list of available models from the provider's API. Used by the provider
 * wizard's "Validate & Discover Models" step and by the refresh-models route.
 *
 * Provider taxonomy uses nucleus's lowercase strings so it stays aligned with
 * model-resolver / model-factory:
 *   bedrock | openai | anthropic | ollama | vllm | lmstudio | litellm | openai-compatible
 */
import {
    BedrockClient,
    ListFoundationModelsCommand,
    ListInferenceProfilesCommand,
} from '@aws-sdk/client-bedrock';
import type { ProviderType } from '@/lib/provider-model-service';
import type { ProviderCredentials } from '@/lib/crypto/provider-credentials';

export interface DiscoveredModel {
    id: string;
    name: string;
    capabilities: string[]; // 'chat' | 'embedding'
    contextWindow?: number;
}

/** OpenAI-compatible default base URLs by provider type. */
const DEFAULT_BASE_URLS: Partial<Record<ProviderType, string>> = {
    openai: 'https://api.openai.com/v1',
    ollama: 'http://localhost:11434',
    lmstudio: 'http://localhost:1234/v1',
    litellm: 'http://localhost:4000/v1',
};

function stripTrailingSlash(url: string): string {
    return url.replace(/\/+$/, '');
}

/** Bedrock: inference profiles (preferred for on-demand chat) + foundation models. */
async function discoverBedrock(creds: ProviderCredentials, region?: string): Promise<DiscoveredModel[]> {
    const effectiveRegion = region || 'us-east-1';
    const client = new BedrockClient({
        region: effectiveRegion,
        // Explicit keys when provided; otherwise fall back to the host/task-role chain.
        credentials:
            creds.accessKeyId && creds.secretAccessKey
                ? { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey }
                : undefined,
    });

    const models: DiscoveredModel[] = [];

    // 1. Inference profiles — on-demand invocation IDs (e.g. us.anthropic.claude-...).
    try {
        const profiles = await client.send(new ListInferenceProfilesCommand({}));
        for (const profile of profiles.inferenceProfileSummaries ?? []) {
            if (!profile.inferenceProfileId) continue;
            if (profile.inferenceProfileId.toLowerCase().includes('embed')) continue;
            models.push({
                id: profile.inferenceProfileId,
                name: profile.inferenceProfileName ?? profile.inferenceProfileId,
                capabilities: ['chat'],
            });
        }
    } catch {
        // ListInferenceProfiles is not available in all regions — fall back below.
    }

    // 2. Foundation models — embeddings, plus chat models if no profiles were found.
    const haveChatModels = models.some((m) => m.capabilities.includes('chat'));
    const response = await client.send(new ListFoundationModelsCommand({}));
    for (const model of response.modelSummaries ?? []) {
        if (!model.modelId) continue;
        const id = model.modelId.toLowerCase();

        if (id.includes('embed')) {
            if (model.inferenceTypesSupported?.includes('ON_DEMAND')) {
                models.push({
                    id: model.modelId,
                    name: model.modelName ?? model.modelId,
                    capabilities: ['embedding'],
                });
            }
            continue;
        }

        if (!haveChatModels && model.inferenceTypesSupported?.includes('ON_DEMAND')) {
            models.push({
                id: model.modelId,
                name: model.modelName ?? model.modelId,
                capabilities: ['chat'],
            });
        }
    }

    return models;
}

/** OpenAI / vLLM / LM Studio / LiteLLM / generic — GET {baseUrl}/models. */
async function discoverOpenAICompatible(
    providerType: ProviderType,
    creds: ProviderCredentials,
): Promise<DiscoveredModel[]> {
    const baseUrl = stripTrailingSlash(creds.baseUrl || DEFAULT_BASE_URLS[providerType] || '');
    if (!baseUrl) {
        throw new Error(`${providerType} requires a base URL`);
    }
    // vLLM/LM Studio/LiteLLM expose /models at the OpenAI-compatible root; if the
    // base URL already ends in /v1 we hit /v1/models, else append /models directly.
    const url = `${baseUrl}/models`;
    const headers: Record<string, string> = {};
    if (creds.apiKey) headers.Authorization = `Bearer ${creds.apiKey}`;

    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
        throw new Error(`${providerType} API error: ${res.status} ${res.statusText}`);
    }

    const data: any = await res.json();
    // OpenAI / vLLM: { data: [...] }; LM Studio native: { models: [...] }
    const rawModels = data.data ?? data.models ?? [];

    const models: DiscoveredModel[] = [];
    for (const m of rawModels) {
        const id = (m.id ?? m.path ?? m.model ?? m.name ?? m.model_name ?? m.title ?? m.alias) as string;
        if (!id) continue;
        const capabilities: string[] = [];
        if (id.toLowerCase().includes('embed')) capabilities.push('embedding');
        if (capabilities.length === 0) capabilities.push('chat');
        models.push({ id, name: id, capabilities });
    }
    return models;
}

/** Ollama — GET {baseUrl}/api/tags. */
async function discoverOllama(creds: ProviderCredentials): Promise<DiscoveredModel[]> {
    const baseUrl = stripTrailingSlash(creds.baseUrl || 'http://localhost:11434').replace(/\/v1$/, '');
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
        throw new Error(`Ollama API error: ${res.status} ${res.statusText}`);
    }
    const data: any = await res.json();
    return (data.models ?? []).map((m: any) => ({
        id: m.model ?? m.name,
        name: m.name ?? m.model,
        capabilities: ['chat'],
    }));
}

/** Anthropic — GET https://api.anthropic.com/v1/models (or custom baseUrl). */
async function discoverAnthropic(creds: ProviderCredentials): Promise<DiscoveredModel[]> {
    if (!creds.apiKey) throw new Error('Anthropic requires an API key');
    const base = stripTrailingSlash(creds.baseUrl || 'https://api.anthropic.com');
    const url = /\/v1$/.test(base) ? `${base}/models` : `${base}/v1/models`;
    const res = await fetch(url, {
        headers: { 'x-api-key': creds.apiKey, 'anthropic-version': '2023-06-01' },
        signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
        throw new Error(`Anthropic API error: ${res.status} ${res.statusText}`);
    }
    const data: any = await res.json();
    return (data.data ?? []).map((m: any) => ({
        id: m.id,
        name: m.display_name ?? m.id,
        capabilities: ['chat'],
    }));
}

/**
 * Discovers the available models for a provider. Throws a descriptive error on
 * connectivity / auth failures so the wizard can surface it.
 */
export async function discoverModels(
    providerType: ProviderType,
    creds: ProviderCredentials,
    region?: string,
): Promise<DiscoveredModel[]> {
    switch (providerType) {
        case 'bedrock':
            return discoverBedrock(creds, region);
        case 'anthropic':
            return discoverAnthropic(creds);
        case 'ollama':
            return discoverOllama(creds);
        case 'openai':
        case 'vllm':
        case 'lmstudio':
        case 'litellm':
        case 'openai-compatible':
            return discoverOpenAICompatible(providerType, creds);
        default:
            throw new Error(`Unsupported provider type: ${providerType}`);
    }
}
