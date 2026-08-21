import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import { ProviderModelService } from '@/lib/provider-model-service';
import { AuditService } from '@/lib/audit-service';
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
 * POST /api/settings/providers/[id]/set-default
 *
 * Marks the provider as the tenant default (clears the flag on all others).
 * The default provider is used by inference when no explicit model is selected.
 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    console.log(`API - POST /api/settings/providers/${id}/set-default`);
    const authError = await authorize('update', 'Provider');
    if (authError) return authError;

    try {
        const tenantId = await getSessionTenantId();
        const session = await getAuthSession();
        const callerEmail = session?.user?.email ?? 'unknown';

        const updated = await ProviderModelService.setDefault(id, tenantId);

        AuditService.logUserAction({
            eventType: 'integration.provider.updated',
            severity: 'medium',
            apiRoute: 'POST /api/settings/providers/[id]/set-default',
            httpMethod: 'POST',
            action: 'Set Default Provider',
            resourceType: 'integration',
            resourceId: id,
            resourceName: updated.name ?? id,
            user: callerEmail,
            userType: 'user',
            status: 'success',
            details: `Set "${updated.name ?? id}" as the default LLM provider`,
            metadata: { tenantId },
        }).catch(() => {});

        return NextResponse.json({
            success: true,
            data: ProviderModelService.toClientProvider(updated as never),
        });
    } catch (error) {
        console.error('API - Error setting default provider:', error);
        const message = error instanceof Error ? error.message : 'Failed to set default provider';
        return NextResponse.json({ success: false, error: message }, { status: message.includes('not found') ? 404 : 500 });
    }
}
