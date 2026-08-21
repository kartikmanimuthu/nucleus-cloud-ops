import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { ProviderModelService, isProviderType } from '@/lib/provider-model-service';
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
 * POST /api/settings/providers/[id]/test
 *
 * Connectivity check for an existing provider — runs discovery with the stored
 * (decrypted) credentials and reports how many models are reachable. Works for
 * every provider type (Bedrock included) via the shared discovery layer.
 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    console.log(`API - POST /api/settings/providers/${id}/test - Testing connectivity`);
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

        const models = await discoverModels(
            config.provider,
            {
                apiKey: config.apiKey,
                accessKeyId: config.accessKeyId,
                secretAccessKey: config.secretAccessKey,
                baseUrl: config.baseUrl,
            },
            config.region,
        );

        return NextResponse.json({
            success: true,
            data: {
                status: 'connected',
                availableModels: models.map((m) => ({ id: m.id, name: m.name })),
            },
        });
    } catch (error) {
        console.error('API - Error testing provider:', error);
        const message = error instanceof Error ? error.message : 'Connection failed';
        return NextResponse.json({ success: false, error: message }, { status: 502 });
    }
}
