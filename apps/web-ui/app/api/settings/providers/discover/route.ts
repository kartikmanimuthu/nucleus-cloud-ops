import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { isProviderType } from '@/lib/provider-model-service';
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
 * POST /api/settings/providers/discover
 *
 * Validates credentials and auto-discovers the available models for a provider
 * BEFORE a record is created (used by the wizard's "Validate & Discover" step).
 * Body: { providerType, credentials: { apiKey?, accessKeyId?, secretAccessKey?, baseUrl? }, region? }
 */
export async function POST(request: NextRequest) {
    console.log('API - POST /api/settings/providers/discover - Discovering models');
    const authError = await authorize('update', 'Provider');
    if (authError) return authError;

    try {
        const body = await request.json();
        const { providerType, credentials, region } = body;

        if (!isProviderType(providerType)) {
            return NextResponse.json(
                { success: false, error: `Invalid provider type: ${providerType}` },
                { status: 400 },
            );
        }

        const models = await discoverModels(providerType, credentials ?? {}, region);
        return NextResponse.json({ success: true, data: { models } });
    } catch (error) {
        console.error('API - Error discovering models:', error);
        const message = error instanceof Error ? error.message : 'Failed to discover models';
        return NextResponse.json({ success: false, error: message }, { status: 502 });
    }
}
