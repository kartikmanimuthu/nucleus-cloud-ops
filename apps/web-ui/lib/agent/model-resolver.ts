import { ProviderModelService, type ProviderRuntimeConfig } from '@/lib/provider-model-service';
import type { ResolvedModelConfig } from './agent-shared';
import { OPENAI_COMPATIBLE_PROVIDERS } from './agent-shared';
import { ProviderConfigError, NO_PROVIDER_MESSAGE } from './provider-errors';

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
 * Builds a ResolvedModelConfig from a decrypted provider runtime config.
 * `provider` is authoritative (parsed from the model string / default record),
 * not read from the config blob. Carries provider-appropriate credentials
 * (Bedrock keys/region, or baseUrl/apiKey for the rest).
 */
function toResolvedConfig(
    provider: ResolvedModelConfig['provider'],
    config: Pick<ProviderRuntimeConfig, 'region' | 'accessKeyId' | 'secretAccessKey' | 'baseUrl' | 'apiKey'>,
    modelId: string,
    maxTokens?: number,
): ResolvedModelConfig {
    if (provider === 'bedrock') {
        return {
            provider: 'bedrock',
            modelId,
            region: config.region,
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
            maxTokens,
        };
    }
    return {
        provider,
        modelId,
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        maxTokens,
    };
}

/**
 * Resolves a model identifier string into a provider-agnostic config.
 *
 * Every model MUST be backed by a tenant-configured provider record — the
 * platform is SaaS-style with NO implicit Bedrock fallback. Bare model IDs,
 * `global.*` ids, and bedrock ids without a provider-record UUID all throw a
 * ProviderConfigError so the caller can surface a "configure a provider"
 * message instead of silently using host/task-role credentials.
 *
 * Format: {provider}:{modelId}:{providerRecordId}
 * Examples:
 *   bedrock:us.anthropic.claude-sonnet-4-6-v1:0:<uuid>      → record-backed Bedrock (explicit creds)
 *   openai-compatible:meta-llama/Llama-3.3-70B:<uuid>       → record-backed OpenAI-compatible
 *   anthropic:claude-sonnet-4-20250514:<uuid>               → record-backed Anthropic
 *   ollama:llama3.3:70b:<uuid>                              → record-backed Ollama
 */
export async function resolveModelConfig(
    modelString: string,
    tenantId: string,
): Promise<ResolvedModelConfig> {
    const parts = modelString.split(':');
    const providerType = parts[0];
    const last = parts[parts.length - 1];

    if (providerType === 'bedrock' && parts.length >= 3 && UUID_RE.test(last)) {
        const modelId = parts.slice(1, -1).join(':');
        const { record, modelEntry } = await loadRecordModel(last, modelId, tenantId);
        const config = await ProviderModelService.getConfigById(record.id, tenantId);
        if (!config) throw new ProviderConfigError('Provider not found or disabled');
        return toResolvedConfig('bedrock', config, modelId, modelEntry.maxTokens);
    }

    // Record-backed providers (anthropic + the OpenAI-compatible family).
    if (isRecordBackedProvider(providerType) && parts.length >= 3 && UUID_RE.test(last)) {
        // providerRecordId is always the last segment (UUID); modelId is everything in between.
        // This handles model IDs that contain colons (e.g. "qwen3.6:35b-a3b", "llama3.3:70b").
        const modelId = parts.slice(1, -1).join(':');
        const { record, modelEntry } = await loadRecordModel(last, modelId, tenantId);
        // Secrets live in the encrypted `credentials` blob — resolve via getConfigById (decrypts).
        const config = await ProviderModelService.getConfigById(record.id, tenantId);
        if (!config) throw new ProviderConfigError('Provider not found or disabled');
        return toResolvedConfig(providerType, config, modelId, modelEntry.maxTokens);
    }

    throw new ProviderConfigError(
        `Model "${modelString}" is not backed by a configured provider. ${NO_PROVIDER_MESSAGE}`,
    );
}

/**
 * Resolves the tenant's default provider into a ResolvedModelConfig using its
 * configured chat model. Throws ProviderConfigError when no default provider is
 * set or it has no chat model — used wherever a request doesn't carry an
 * explicit model selection (Ask-AI, enhance-prompt, text-to-SQL, agent-ops).
 */
export async function resolveDefaultModelConfig(tenantId: string): Promise<ResolvedModelConfig> {
    const config = await ProviderModelService.getDefaultConfig(tenantId);
    if (!config) throw new ProviderConfigError(NO_PROVIDER_MESSAGE);
    if (!config.chatModel) {
        throw new ProviderConfigError(
            'The default LLM provider has no chat model selected. Pick a chat model on the provider in Settings → Providers.',
        );
    }
    const modelEntry = config.models.find((m) => m.id === config.chatModel);
    return toResolvedConfig(config.provider, config, config.chatModel, modelEntry?.maxTokens);
}
