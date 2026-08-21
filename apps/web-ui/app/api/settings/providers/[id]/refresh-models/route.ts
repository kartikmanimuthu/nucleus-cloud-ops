import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import {
    ProviderModelService,
    isProviderType,
    type ProviderModelEntry,
} from '@/lib/provider-model-service';
import { discoverModels } from '@/lib/agent/model-discovery';
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
 * POST /api/settings/providers/[id]/refresh-models
 *
 * Re-runs discovery for an existing provider using its stored (decrypted)
 * credentials, then persists the refreshed model list.
 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    console.log(`API - POST /api/settings/providers/${id}/refresh-models`);
    const authError = await authorize('update', 'Provider');
    if (authError) return authError;

    try {
        const tenantId = await getSessionTenantId();
        const config = await ProviderModelService.getConfigById(id, tenantId);
        if (!config) {
            return NextResponse.json({ success: false, error: 'Provider not found' }, { status: 404 });
        }
        if (!isProviderType(config.provider)) {
            return NextResponse.json({ success: false, error: `Invalid provider type: ${config.provider}` }, { status: 400 });
        }

        const discovered = await discoverModels(
            config.provider,
            {
                apiKey: config.apiKey,
                accessKeyId: config.accessKeyId,
                secretAccessKey: config.secretAccessKey,
                baseUrl: config.baseUrl,
            },
            config.region,
        );

        // Preserve any manually-set maxTokens for models that still exist.
        const prevById = new Map(config.models.map((m) => [m.id, m]));
        const models: ProviderModelEntry[] = discovered.map((m) => ({
            id: m.id,
            label: m.name,
            capabilities: m.capabilities,
            maxTokens: prevById.get(m.id)?.maxTokens,
        }));

        const updated = await ProviderModelService.updateModels(id, tenantId, models);
        return NextResponse.json({
            success: true,
            data: ProviderModelService.toClientProvider(updated as never),
        });
    } catch (error) {
        console.error('API - Error refreshing models:', error);
        const message = error instanceof Error ? error.message : 'Failed to refresh models';
        return NextResponse.json({ success: false, error: message }, { status: 502 });
    }
}
