import { getTenantClient } from '@/lib/db/pg-config';
import {
    encryptCredentials,
    decryptCredentials,
    credentialHint,
    type ProviderCredentials,
} from '@/lib/crypto/provider-credentials';

/**
 * Provider types a tenant can configure. `bedrock` uses the AWS Bedrock control
 * plane; `anthropic` uses the native Anthropic API; `openai`/`vllm`/`ollama`/
 * `lmstudio`/`litellm`/`openai-compatible` all speak the OpenAI `/v1` protocol.
 */
export const PROVIDER_TYPES = [
    'bedrock',
    'openai',
    'anthropic',
    'ollama',
    'vllm',
    'lmstudio',
    'litellm',
    'openai-compatible',
] as const;

export type ProviderType = (typeof PROVIDER_TYPES)[number];

export function isProviderType(value: unknown): value is ProviderType {
    return typeof value === 'string' && (PROVIDER_TYPES as readonly string[]).includes(value);
}

/**
 * Normalizes the base URL for the OpenAI-compatible transport (ChatOpenAI /
 * OpenAIEmbeddings, which POST to `{baseURL}/chat/completions` and
 * `{baseURL}/embeddings`). Ollama serves its OpenAI-compatible API under `/v1`,
 * but discovery stores the bare root (it talks to `/api/tags`), so we append
 * `/v1` for inference. Other OpenAI-compatible providers already store a `/v1`
 * base (their `/models` discovery requires it), so they're left as-is.
 */
export function normalizeOpenAICompatibleBaseUrl(provider: string, baseUrl?: string): string | undefined {
    if (!baseUrl) return baseUrl;
    const trimmed = baseUrl.replace(/\/+$/, '');
    if (provider === 'ollama' && !/\/v1$/i.test(trimmed)) return `${trimmed}/v1`;
    return trimmed;
}

/** A model entry stored on a provider record (discovered or manually entered). */
export interface ProviderModelEntry {
    id: string;
    label: string;
    capabilities?: string[];
    maxTokens?: number;
}

export interface ProviderModelInput {
    name: string;
    provider?: ProviderType;
    region?: string;
    /** Plaintext secrets — encrypted at rest into the `credentials` column. */
    credentials?: ProviderCredentials;
    /** Convenience non-secret base URL (also kept inside credentials for resolution). */
    baseUrl?: string;
    chatModel?: string;
    embeddingModel?: string;
    embeddingDimensions?: number;
    models: ProviderModelEntry[];
    isDefault?: boolean;
}

/**
 * A fully-resolved provider config with decrypted credentials, used by the
 * model-resolver / inference layer. Never returned to the client.
 */
export interface ProviderRuntimeConfig {
    id: string;
    provider: ProviderType;
    region?: string;
    chatModel?: string;
    embeddingModel?: string;
    embeddingDimensions?: number;
    baseUrl?: string;
    apiKey?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    models: ProviderModelEntry[];
}

type ProviderRecord = {
    id: string;
    tenantId: string;
    name: string;
    provider: string;
    baseUrl: string | null;
    apiKey: string | null;
    region: string | null;
    credentials: string | null;
    chatModel: string | null;
    embeddingModel: string | null;
    embeddingDimensions: number | null;
    models: unknown;
    isDefault: boolean;
    isEnabled: boolean;
    createdAt: Date;
    updatedAt: Date;
};

/** Client-safe provider shape — secrets stripped, replaced by a configured flag + masked hint. */
export interface ClientProvider {
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

/** Reads the decrypted credentials for a record, tolerating legacy plaintext rows. */
function readCredentials(record: ProviderRecord): ProviderCredentials {
    if (record.credentials) {
        try {
            return decryptCredentials(record.credentials);
        } catch {
            // fall through to legacy fields
        }
    }
    // Legacy rows: secrets lived in the plaintext apiKey/baseUrl columns.
    const legacy: ProviderCredentials = {};
    if (record.apiKey) legacy.apiKey = record.apiKey;
    if (record.baseUrl) legacy.baseUrl = record.baseUrl;
    return legacy;
}

export class ProviderModelService {
    static async listProviders(tenantId: string) {
        const prisma = getTenantClient(tenantId);
        return prisma.providerModel.findMany({
            where: { isEnabled: true },
            orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
        });
    }

    static async listAllProviders(tenantId: string) {
        const prisma = getTenantClient(tenantId);
        return prisma.providerModel.findMany({ orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] });
    }

    static async getProvider(id: string, tenantId: string) {
        const prisma = getTenantClient(tenantId);
        return prisma.providerModel.findFirst({ where: { id } });
    }

    static async createProvider(tenantId: string, input: ProviderModelInput) {
        const prisma = getTenantClient(tenantId);
        const creds = mergeCredentials(input);
        const created = await prisma.providerModel.create({
            data: {
                tenantId,
                name: input.name,
                provider: input.provider ?? 'openai-compatible',
                region: input.region ?? null,
                baseUrl: input.baseUrl ?? input.credentials?.baseUrl ?? null,
                credentials: creds ? encryptCredentials(creds) : null,
                chatModel: input.chatModel ?? null,
                embeddingModel: input.embeddingModel ?? null,
                embeddingDimensions: input.embeddingDimensions ?? null,
                models: input.models,
                isDefault: input.isDefault ?? false,
                isEnabled: true,
            },
        });
        if (input.isDefault) {
            await this.setDefault(created.id, tenantId);
        }
        return created;
    }

    static async updateProvider(
        id: string,
        tenantId: string,
        input: Partial<ProviderModelInput> & { isEnabled?: boolean },
    ) {
        const existing = (await this.getProvider(id, tenantId)) as ProviderRecord | null;
        if (!existing) throw new Error('Provider not found');
        const prisma = getTenantClient(tenantId);

        // Merge credentials: only re-encrypt when new secrets are supplied; otherwise keep existing.
        let credentialsColumn: string | undefined;
        if (input.credentials !== undefined) {
            const existingCreds = readCredentials(existing);
            const merged = { ...existingCreds, ...mergeCredentials(input) };
            credentialsColumn = encryptCredentials(merged);
        }

        const updated = await prisma.providerModel.update({
            where: { id },
            data: {
                ...(input.name !== undefined && { name: input.name }),
                ...(input.provider !== undefined && { provider: input.provider }),
                ...(input.region !== undefined && { region: input.region }),
                ...(input.baseUrl !== undefined && { baseUrl: input.baseUrl }),
                ...(credentialsColumn !== undefined && { credentials: credentialsColumn }),
                ...(input.chatModel !== undefined && { chatModel: input.chatModel }),
                ...(input.embeddingModel !== undefined && { embeddingModel: input.embeddingModel }),
                ...(input.embeddingDimensions !== undefined && {
                    embeddingDimensions: input.embeddingDimensions,
                }),
                ...(input.models !== undefined && { models: input.models }),
                ...(input.isDefault !== undefined && { isDefault: input.isDefault }),
                ...(input.isEnabled !== undefined && { isEnabled: input.isEnabled }),
            },
        });
        if (input.isDefault) {
            await this.setDefault(id, tenantId);
        }
        return updated;
    }

    static async deleteProvider(id: string, tenantId: string) {
        const existing = await this.getProvider(id, tenantId);
        if (!existing) throw new Error('Provider not found');
        const prisma = getTenantClient(tenantId);
        return prisma.providerModel.delete({ where: { id } });
    }

    /** Marks one provider as the tenant default, clearing the flag on all others. */
    static async setDefault(id: string, tenantId: string) {
        const existing = await this.getProvider(id, tenantId);
        if (!existing) throw new Error('Provider not found');
        const prisma = getTenantClient(tenantId);
        await prisma.providerModel.updateMany({
            where: { isDefault: true, NOT: { id } },
            data: { isDefault: false },
        });
        return prisma.providerModel.update({ where: { id }, data: { isDefault: true } });
    }

    /** Re-runs discovery for a provider and stores the refreshed model list. */
    static async updateModels(id: string, tenantId: string, models: ProviderModelEntry[]) {
        const existing = await this.getProvider(id, tenantId);
        if (!existing) throw new Error('Provider not found');
        const prisma = getTenantClient(tenantId);
        return prisma.providerModel.update({ where: { id }, data: { models } });
    }

    /** Decrypted runtime config for a specific provider (for inference). */
    static async getConfigById(id: string, tenantId: string): Promise<ProviderRuntimeConfig | null> {
        const record = (await this.getProvider(id, tenantId)) as ProviderRecord | null;
        if (!record) return null;
        return toRuntimeConfig(record);
    }

    /** Decrypted runtime config for the tenant's default provider, if any. */
    static async getDefaultConfig(tenantId: string): Promise<ProviderRuntimeConfig | null> {
        const prisma = getTenantClient(tenantId);
        const record = (await prisma.providerModel.findFirst({
            where: { isDefault: true, isEnabled: true },
        })) as ProviderRecord | null;
        if (!record) return null;
        return toRuntimeConfig(record);
    }

    /** Strips secrets from a record for safe transmission to the client. */
    static toClientProvider(record: ProviderRecord): ClientProvider {
        const creds = (() => {
            try {
                return readCredentials(record);
            } catch {
                return null;
            }
        })();
        return {
            id: record.id,
            name: record.name,
            provider: record.provider,
            region: record.region,
            baseUrl: record.baseUrl,
            credentialsConfigured: !!(record.credentials || record.apiKey),
            credentialsHint: credentialHint(creds),
            chatModel: record.chatModel,
            embeddingModel: record.embeddingModel,
            embeddingDimensions: record.embeddingDimensions,
            models: (record.models as ProviderModelEntry[]) ?? [],
            isDefault: record.isDefault,
            isEnabled: record.isEnabled,
            createdAt: record.createdAt.toISOString(),
            updatedAt: record.updatedAt.toISOString(),
        };
    }
}

/** Collapses input.credentials + the convenience baseUrl into one bag (or undefined if empty). */
function mergeCredentials(input: Partial<ProviderModelInput>): ProviderCredentials | undefined {
    const creds: ProviderCredentials = { ...(input.credentials ?? {}) };
    if (input.baseUrl && !creds.baseUrl) creds.baseUrl = input.baseUrl;
    const hasAny = creds.apiKey || creds.accessKeyId || creds.secretAccessKey || creds.baseUrl;
    return hasAny ? creds : undefined;
}

function toRuntimeConfig(record: ProviderRecord): ProviderRuntimeConfig {
    const creds = readCredentials(record);
    return {
        id: record.id,
        provider: (isProviderType(record.provider) ? record.provider : 'openai-compatible') as ProviderType,
        region: record.region ?? undefined,
        chatModel: record.chatModel ?? undefined,
        embeddingModel: record.embeddingModel ?? undefined,
        embeddingDimensions: record.embeddingDimensions ?? undefined,
        baseUrl: creds.baseUrl ?? record.baseUrl ?? undefined,
        apiKey: creds.apiKey,
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        models: (record.models as ProviderModelEntry[]) ?? [],
    };
}
