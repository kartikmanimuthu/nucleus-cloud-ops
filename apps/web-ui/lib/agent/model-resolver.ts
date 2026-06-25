import { ProviderModelService } from '@/lib/provider-model-service';
import type { ResolvedModelConfig } from './agent-shared';

/**
 * Resolves a model identifier string into a provider-agnostic config.
 *
 * Format: {provider}:{modelId}:{providerRecordId}
 * Examples:
 *   bedrock:global.anthropic.claude-sonnet-4-6
 *   openai-compatible:meta-llama/Llama-3.3-70B:uuid
 *
 * Bare strings (no colon prefix) are treated as Bedrock for backward compatibility.
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
        return { provider: 'bedrock', modelId: parts.slice(1).join(':') };
    }

    if (providerType === 'openai-compatible') {
        // providerRecordId is always the last segment (UUID); modelId is everything in between
        // This handles model IDs that contain colons (e.g. "qwen3.6:35b-a3b")
        const providerRecordId = parts[parts.length - 1];
        const modelId = parts.slice(1, -1).join(':');

        if (!providerRecordId) {
            throw new Error('Provider record ID is required for openai-compatible models');
        }

        const record = await ProviderModelService.getProvider(providerRecordId, tenantId);
        if (!record || !record.isEnabled) {
            throw new Error('Provider not found or disabled');
        }

        const models = record.models as Array<{ id: string; label: string; maxTokens?: number }>;
        const modelEntry = models.find(m => m.id === modelId);
        if (!modelEntry) {
            throw new Error(`Model "${modelId}" is not available on provider "${record.name}"`);
        }

        return {
            provider: 'openai-compatible',
            modelId,
            baseUrl: record.baseUrl,
            apiKey: record.apiKey || undefined,
            maxTokens: modelEntry.maxTokens,
        };
    }

    // Unknown provider prefix — treat as Bedrock
    return { provider: 'bedrock', modelId: modelString };
}
