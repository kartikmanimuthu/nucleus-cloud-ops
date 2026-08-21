import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import {
    ProviderModelService,
    isProviderType,
    type ProviderRuntimeConfig,
} from '@/lib/provider-model-service';
import { probeEmbeddingDimensions, REQUIRED_EMBEDDING_DIMENSIONS } from '@/lib/agent/embeddings-factory';
import { isProviderConfigError } from '@/lib/agent/provider-errors';
import type { RouteAuthz } from '@nucleus/rbac';

/**
 * Layer 1 permission declaration.
 *
 * Subject is Provider (the "LLM Provider" row under AI Ops), not Settings and no
 * longer the bare AIOps module. LLM providers exist to power the agents, the
 * page lives under /app/agent-ops/providers, and the nav groups it with Agentic
 * Ops. It first resolved to Settings by inference from the /api/settings/* path,
 * which is why a role holding AIOps could not reach its own providers; it then
 * gated on the AIOps catch-all, which the role editor hides, so the Provider row
 * it already rendered governed nothing. Now that row is the control.
 */
export const authz: RouteAuthz = {
    POST: { action: 'update', subject: 'Provider' },
};

/**
 * POST /api/settings/providers/probe-embedding
 *
 * Embeds a tiny probe string with the given embedding model and returns its
 * EFFECTIVE output dimension (after any text-embedding-3 reduction). The wizard
 * uses this to auto-detect + validate dimensions against the platform's fixed
 * 1024-dim pgvector columns before a provider is saved.
 *
 * Body: { providerType, embeddingModel, credentials?, region?, providerId? }
 *   - create flow: pass credentials (+ region for bedrock).
 *   - edit flow with kept credentials: pass providerId; saved creds are used.
 */
export async function POST(request: NextRequest) {
    const authError = await authorize('update', 'Provider');
    if (authError) return authError;

    try {
        const tenantId = await getSessionTenantId();
        const body = await request.json();
        const { providerType, embeddingModel, credentials, region, providerId } = body;

        if (!isProviderType(providerType)) {
            return NextResponse.json(
                { success: false, error: `Invalid provider type: ${providerType}` },
                { status: 400 },
            );
        }
        if (!embeddingModel || typeof embeddingModel !== 'string') {
            return NextResponse.json(
                { success: false, error: 'embeddingModel is required' },
                { status: 400 },
            );
        }

        const hasCreds =
            credentials &&
            (credentials.apiKey || credentials.accessKeyId || credentials.secretAccessKey || credentials.baseUrl);

        let config: ProviderRuntimeConfig;
        if (hasCreds) {
            // Create flow (or edit with re-entered creds) — build from plaintext input.
            config = {
                id: providerId ?? 'probe',
                provider: providerType,
                region: region || undefined,
                embeddingModel,
                baseUrl: credentials.baseUrl,
                apiKey: credentials.apiKey,
                accessKeyId: credentials.accessKeyId,
                secretAccessKey: credentials.secretAccessKey,
                models: [],
            };
        } else if (providerId) {
            // Edit flow with kept credentials — reuse the saved, decrypted config.
            const saved = await ProviderModelService.getConfigById(providerId, tenantId);
            if (!saved) {
                return NextResponse.json({ success: false, error: 'Provider not found' }, { status: 404 });
            }
            config = { ...saved, embeddingModel };
        } else {
            return NextResponse.json(
                { success: false, error: 'credentials or providerId is required' },
                { status: 400 },
            );
        }

        console.log(
            `[probe-embedding] attempting provider=${providerType} model="${embeddingModel}" region=${config.region ?? '(none)'} hasCreds=${Boolean(hasCreds)} providerId=${providerId ?? '(none)'}`,
        );

        let dimensions: number;
        try {
            dimensions = await probeEmbeddingDimensions(config);
        } catch (embedError) {
            // A failed invoke is a KNOWN outcome here, not a server error: the model
            // uses a request schema the platform can't speak (e.g. Cohere, Nova,
            // multimodal Titan/Marengo). Always return 200 with supported:false and
            // a clean reason that INCLUDES the underlying error, so the wizard shows
            // exactly why a model can't be used instead of swallowing it.
            const raw = embedError instanceof Error ? embedError.message : String(embedError);
            const clean = raw.replace(/^An error occurred while embedding documents with Bedrock:\s*/i, '');
            const isUnsupportedSchema =
                /Malformed|ValidationException|required (property|key)|input_?type|not found|one and only one schema/i.test(
                    raw,
                );
            console.log(
                `[probe-embedding] UNUSABLE provider=${providerType} model="${embeddingModel}" — ${raw}`,
            );
            return NextResponse.json({
                success: true,
                data: {
                    compatible: false,
                    supported: false,
                    dimensions: null,
                    required: REQUIRED_EMBEDDING_DIMENSIONS,
                    reason: isUnsupportedSchema
                        ? `This embedding model isn't supported here — its request format differs from Titan Text / OpenAI-compatible embeddings (${clean}). Pick a supported model.`
                        : `Couldn't use this embedding model: ${clean}`,
                },
            });
        }

        const compatible = dimensions === REQUIRED_EMBEDDING_DIMENSIONS;
        console.log(
            `[probe-embedding] OK provider=${providerType} model="${embeddingModel}" → ${dimensions} dims (required ${REQUIRED_EMBEDDING_DIMENSIONS}, compatible=${compatible})`,
        );
        return NextResponse.json({
            success: true,
            data: {
                compatible,
                supported: true,
                dimensions,
                required: REQUIRED_EMBEDDING_DIMENSIONS,
                reason: compatible
                    ? null
                    : `This model outputs ${dimensions}-dimension vectors, but the platform stores ${REQUIRED_EMBEDDING_DIMENSIONS}-dimension vectors. Choose a ${REQUIRED_EMBEDDING_DIMENSIONS}-dim embedding model.`,
            },
        });
    } catch (error) {
        console.error('API - Error probing embedding dimensions:', error);
        const message = error instanceof Error ? error.message : 'Failed to probe embedding model';
        const status = isProviderConfigError(error) ? 400 : 502;
        return NextResponse.json({ success: false, error: message }, { status });
    }
}
