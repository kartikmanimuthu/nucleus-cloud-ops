import { ProviderModelService } from '@/lib/provider-model-service';
import type { ResolvedModelConfig } from './agent-shared';
import { OPENAI_COMPATIBLE_PROVIDERS } from './agent-shared';

/**
 * Provider prefixes that resolve via a ProviderModel DB record: anthropic plus
 * the OpenAI-compatible family (openai, openai-compatible, ollama, vllm,
 * litellm, lmstudio). Bedrock is handled specially — it can be either a native
 * (host/task-role) model id or a record-backed model with explicit credentials.
 */
const RECORD_BACKED_PROVIDERS = ['anthropic', ...OPENAI_COMPATIBLE_PROVIDERS] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecordBackedProvider(p: string): p is ResolvedModelConfig['provider'] {
    return (RECORD_BACKED_PROVIDERS as readonly string[]).includes(p);
}

/** Looks up a provider record + validates the requested model exists on it. */
async function loadRecordModel(providerRecordId: string, modelId: string, tenantId: string) {
    if (!providerRecordId) {
        throw new Error('Provider record ID is required');
    }
    const record = await ProviderModelService.getProvider(providerRecordId, tenantId);
    if (!record || !record.isEnabled) {
        throw new Error('Provider not found or disabled');
    }
    const models = record.models as Array<{ id: string; label: string; maxTokens?: number }>;
    const modelEntry = models.find((m) => m.id === modelId);
    if (!modelEntry) {
        throw new Error(`Model "${modelId}" is not available on provider "${record.name}"`);
    }
    return { record, modelEntry };
}

/**
 * Resolves a model identifier string into a provider-agnostic config.
 *
 * Format: {provider}:{modelId}:{providerRecordId}
 * Examples:
 *   global.anthropic.claude-sonnet-4-6                       → native Bedrock
 *   bedrock:global.anthropic.claude-sonnet-4-6              → native Bedrock
 *   bedrock:us.anthropic.claude-sonnet-4-6-v1:0:<uuid>      → record-backed Bedrock (explicit creds)
 *   openai-compatible:meta-llama/Llama-3.3-70B:<uuid>       → record-backed OpenAI-compatible
 *   anthropic:claude-sonnet-4-20250514:<uuid>               → record-backed Anthropic
 *   ollama:llama3.3:70b:<uuid>                              → record-backed Ollama
 *
 * Bare strings (no colon prefix) are treated as native Bedrock for backward compat.
 */
export async function resolveModelConfig(
    modelString: string,
    tenantId: string,
): Promise<ResolvedModelConfig> {
    // Backward compat: bare Bedrock model IDs have no colon-separated provider prefix
    if (!modelString.includes(':') || modelString.startsWith('global.')) {
        return { provider: 'bedrock', modelId: modelString };
    }

    const parts = modelString.split(':');
    const providerType = parts[0];

    if (providerType === 'bedrock') {
        // Record-backed Bedrock when the last segment is a provider-record UUID;
        // otherwise it's a native Bedrock model id (uses host/task-role creds).
        const last = parts[parts.length - 1];
        if (parts.length >= 3 && UUID_RE.test(last)) {
            const modelId = parts.slice(1, -1).join(':');
            const { record, modelEntry } = await loadRecordModel(last, modelId, tenantId);
            const config = await ProviderModelService.getConfigById(record.id, tenantId);
            return {
                provider: 'bedrock',
                modelId,
                region: config?.region,
                accessKeyId: config?.accessKeyId,
                secretAccessKey: config?.secretAccessKey,
                maxTokens: modelEntry.maxTokens,
            };
        }
        return { provider: 'bedrock', modelId: parts.slice(1).join(':') };
    }

    // Record-backed providers (anthropic + the OpenAI-compatible family).
    if (isRecordBackedProvider(providerType)) {
        // providerRecordId is always the last segment (UUID); modelId is everything in between.
        // This handles model IDs that contain colons (e.g. "qwen3.6:35b-a3b", "llama3.3:70b").
        const providerRecordId = parts[parts.length - 1];
        const modelId = parts.slice(1, -1).join(':');
        const { record, modelEntry } = await loadRecordModel(providerRecordId, modelId, tenantId);
        // Secrets live in the encrypted `credentials` blob — resolve via getConfigById (decrypts).
        const config = await ProviderModelService.getConfigById(record.id, tenantId);

        return {
            provider: providerType,
            modelId,
            baseUrl: config?.baseUrl,
            apiKey: config?.apiKey,
            maxTokens: modelEntry.maxTokens,
        };
    }

    // Unknown provider prefix — treat as native Bedrock
    return { provider: 'bedrock', modelId: modelString };
}
