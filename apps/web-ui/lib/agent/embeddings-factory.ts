/**
 * embeddings-factory.ts
 *
 * Single source of truth for embedding-model initialization. Mirrors
 * model-factory.ts (chat models) but for the Embeddings interface. Embeddings
 * always come from the tenant's configured provider — there is NO implicit
 * Bedrock fallback.
 *
 * NOTE on dimensions: the pgvector columns that store embeddings
 * (`kb_document_chunks.embedding`, `inventory_resources.embedding`,
 * `agent_memories.embedding`) are fixed at `vector(1024)`. Configuring an
 * embedding model whose output dimension differs from 1024 requires a schema
 * migration + full re-index of those tables. We guard against an explicit
 * mismatch here so the failure is a clear message rather than an opaque
 * Postgres dimension error at insert time.
 */

import { BedrockEmbeddings } from '@langchain/aws';
import { OpenAIEmbeddings } from '@langchain/openai';
import type { Embeddings } from '@langchain/core/embeddings';
import {
    ProviderModelService,
    normalizeOpenAICompatibleBaseUrl,
    type ProviderRuntimeConfig,
} from '@/lib/provider-model-service';
import { ProviderConfigError, NO_PROVIDER_MESSAGE } from './provider-errors';

/** Fixed dimension of every pgvector embedding column in the schema. */
export const REQUIRED_EMBEDDING_DIMENSIONS = 1024;

/**
 * OpenAI `text-embedding-3-*` models support the `dimensions` request param
 * (Matryoshka representation learning), so a 1536/3072-native model can emit a
 * 1024-dim vector that fits the platform's fixed columns. Any OpenAI-protocol
 * server (openai, litellm, etc.) serving a text-embedding-3 model should honor
 * it. Native ada-002 and most local models (ollama/vLLM) do NOT.
 */
function supportsDimensionReduction(model: string): boolean {
    return /text-embedding-3/i.test(model);
}

/**
 * Builds an Embeddings instance from a resolved provider runtime config.
 * Throws ProviderConfigError when the provider cannot produce 1024-dim
 * embeddings (no embedding model, wrong dimensions, unsupported provider, or
 * missing credentials).
 */
export function createEmbeddings(config: ProviderRuntimeConfig): Embeddings {
    if (!config.embeddingModel) {
        throw new ProviderConfigError(
            `Provider "${config.id}" has no embedding model configured. Set an embedding model on the provider in Settings → Providers.`,
        );
    }

    if (config.embeddingDimensions && config.embeddingDimensions !== REQUIRED_EMBEDDING_DIMENSIONS) {
        throw new ProviderConfigError(
            `Embedding model produces ${config.embeddingDimensions}-dim vectors but the platform stores ${REQUIRED_EMBEDDING_DIMENSIONS}-dim vectors. ` +
                `Choose a ${REQUIRED_EMBEDDING_DIMENSIONS}-dim embedding model, or migrate the pgvector columns and re-index.`,
        );
    }

    if (config.provider === 'bedrock') {
        if (!config.accessKeyId || !config.secretAccessKey || !config.region) {
            throw new ProviderConfigError(
                'Bedrock provider is missing an access key, secret key, or region. Re-configure the provider in Settings → Providers.',
            );
        }
        // Titan Text Embeddings V2 supports the `dimensions` request param
        // (256/512/1024) — request the platform's 1024 so it fits the fixed
        // pgvector columns. V1 is fixed at 1536 and ignores it.
        const titanV2 = /titan-embed-text-v2/i.test(config.embeddingModel);
        return new BedrockEmbeddings({
            region: config.region,
            model: config.embeddingModel,
            credentials: {
                accessKeyId: config.accessKeyId,
                secretAccessKey: config.secretAccessKey,
            },
            ...(titanV2 ? { dimensions: REQUIRED_EMBEDDING_DIMENSIONS } : {}),
        });
    }

    if (config.provider === 'anthropic') {
        throw new ProviderConfigError(
            'The Anthropic provider does not expose an embeddings API. Configure a Bedrock or OpenAI-compatible provider as the default for embedding-backed features (knowledge base, agent memory).',
        );
    }

    // Everything else (openai / ollama / vllm / lmstudio / litellm /
    // openai-compatible) speaks the OpenAI /v1/embeddings protocol. For
    // text-embedding-3-* models, request REQUIRED_EMBEDDING_DIMENSIONS so a
    // 1536/3072-native model is truncated to the platform's 1024 columns.
    return new OpenAIEmbeddings({
        model: config.embeddingModel,
        ...(supportsDimensionReduction(config.embeddingModel)
            ? { dimensions: REQUIRED_EMBEDDING_DIMENSIONS }
            : {}),
        configuration: {
            baseURL: normalizeOpenAICompatibleBaseUrl(config.provider, config.baseUrl),
            apiKey: config.apiKey || 'not-needed',
        },
    });
}

/**
 * Embeds a tiny probe string and returns the EFFECTIVE output dimension. Shares
 * createEmbeddings' code path (including the text-embedding-3 reduction above),
 * so the detected value is exactly what will be stored at runtime. Used by the
 * provider wizard to auto-detect + validate embedding dimensions before saving.
 */
export async function probeEmbeddingDimensions(config: ProviderRuntimeConfig): Promise<number> {
    const embeddings = createEmbeddings(config);
    const vector = await embeddings.embedQuery('dimension probe');
    return vector.length;
}

/**
 * Resolves the tenant's default provider and builds its embeddings instance.
 * Throws ProviderConfigError when no default provider exists.
 */
export async function getTenantEmbeddings(tenantId: string): Promise<Embeddings> {
    const config = await ProviderModelService.getDefaultConfig(tenantId);
    if (!config) {
        throw new ProviderConfigError(NO_PROVIDER_MESSAGE);
    }
    return createEmbeddings(config);
}
