/**
 * AgentOps Webhook Settings API Route
 *
 * GET /api/agent-ops/settings/webhook — Returns Webhook config (secrets masked)
 * DELETE /api/agent-ops/settings/webhook — Resets (deletes) the stored config
 * POST /api/agent-ops/settings/webhook — Creates the config (first-time connect)
 * PUT /api/agent-ops/settings/webhook — Updates the existing config
 *
 * POST and PUT share one handler but are NOT interchangeable — see the Slack
 * route for why the create/update split has to be two methods.
 */

import { NextResponse } from 'next/server';
import { TenantConfigService } from '@/lib/tenant-config-service';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import { AuditService } from '@/lib/audit-service';
import { authorize } from '@/lib/rbac/authorize';
import type { WebhookIntegrationConfig } from '@/lib/agent-ops/types';
import type { RouteAuthz } from '@nucleus/rbac';

/**
 * Layer 1 permission declaration — see lib/rbac/rbac-allowlist.ts for the public set.
 * Subject is 'Channel' (→ AIOps), and GET is declared `read` so it is not
 * inferred from a stricter in-body gate. Full rationale on the Slack route.
 */
export const authz: RouteAuthz = {
    GET: { action: 'read', subject: 'Channel' },
    POST: { action: 'create', subject: 'Channel' },
    PUT: { action: 'update', subject: 'Channel' },
    DELETE: { action: 'delete', subject: 'Channel' },
};

const CONFIG_KEY = 'agent-ops-webhook';

function maskSecret(value: string | undefined): string {
    if (!value) return '';
    if (value.length <= 8) return '********';
    return value.slice(0, 4) + '****' + value.slice(-4);
}

export async function GET() {
    try {
        const tenantId = await getSessionTenantId();
        const config = await TenantConfigService.getConfig<WebhookIntegrationConfig>(CONFIG_KEY, tenantId);

        if (!config) {
            return NextResponse.json({ configured: false, enabled: false });
        }

        // Always masked. Plaintext lives behind GET /reveal, which requires
        // `update` and audits — see lib/channels/secret-reveal.ts.
        return NextResponse.json({
            configured: true,
            enabled: config.enabled,
            webhookSecret: maskSecret(config.webhookSecret),
        });
    } catch (error: any) {
        console.error('[API /agent-ops/settings/webhook] GET error:', error);
        return NextResponse.json(
            { error: error.message || 'Failed to fetch Webhook settings' },
            { status: 500 }
        );
    }
}

/** First-time connect. 409s if the webhook is already configured — that is PUT's job. */
export async function POST(req: Request) {
    return handleSave(req, 'create');
}

/** Edit an existing connection (secret, enable toggle). */
export async function PUT(req: Request) {
    return handleSave(req, 'update');
}

async function handleSave(req: Request, mode: 'create' | 'update') {
    try {
        const tenantId = await getSessionTenantId();
        const body = await req.json() as Partial<WebhookIntegrationConfig>;

        // "Leave blank to keep existing values": merge the incoming body over the
        // stored config so a blank secret retains what's already saved.
        const existing = await TenantConfigService.getConfig<WebhookIntegrationConfig>(CONFIG_KEY, tenantId);

        // The create/update boundary — see the Slack route for the full rationale.
        if (mode === 'create' && existing) {
            return NextResponse.json(
                { error: 'The webhook is already configured — use PUT to update the existing connection' },
                { status: 409 }
            );
        }
        if (mode === 'update' && !existing) {
            return NextResponse.json(
                { error: 'The webhook is not configured yet — use POST to create the connection' },
                { status: 404 }
            );
        }

        const webhookSecret = body.webhookSecret?.trim() || existing?.webhookSecret;
        if (!webhookSecret) {
            return NextResponse.json(
                { error: 'webhookSecret is required' },
                { status: 400 }
            );
        }

        const config: WebhookIntegrationConfig = {
            webhookSecret,
            enabled: body.enabled ?? existing?.enabled ?? true,
        };

        await TenantConfigService.saveConfig(CONFIG_KEY, config, tenantId);

        console.log('[API /agent-ops/settings/webhook] Saved Webhook config');

        const created = mode === 'create';
        const session = await getAuthSession();
        AuditService.logUserAction({
            eventType: created ? 'agent.settings.webhook_created' : 'agent.settings.webhook_updated',
            severity: 'medium',
            apiRoute: `${created ? 'POST' : 'PUT'} /api/agent-ops/settings/webhook`,
            httpMethod: created ? 'POST' : 'PUT',
            action: created ? 'Connected Webhook' : 'Updated Webhook Settings',
            resourceType: 'agent',
            resourceId: 'webhook-integration',
            resourceName: 'Webhook Integration',
            user: session?.user?.email || 'unknown',
            userType: 'user',
            status: 'success',
            details: created ? 'Created the Webhook integration connection' : 'Updated Webhook integration settings',
            metadata: { tenantId },
        }).catch(() => {});

        return NextResponse.json({
            success: true,
            configured: true,
            enabled: config.enabled,
            webhookSecret: maskSecret(config.webhookSecret),
        });
    } catch (error: any) {
        console.error(`[API /agent-ops/settings/webhook] ${mode} error:`, error);
        return NextResponse.json(
            { error: error.message || 'Failed to save Webhook settings' },
            { status: 500 }
        );
    }
}

/**
 * DELETE — reset the Webhook integration: removes the stored credentials so the
 * channel returns to its unconfigured state. Destructive and irreversible from
 * the UI (secrets are never echoed back), hence the explicit RBAC gate and a
 * high-severity audit record.
 */
export async function DELETE() {
    try {
        const authError = await authorize('delete', 'Channel');
        if (authError) return authError;

        const tenantId = await getSessionTenantId();
        await TenantConfigService.deleteConfig(CONFIG_KEY, tenantId);

        console.log('[API /agent-ops/settings/webhook] Reset Webhook config for tenant:', tenantId);

        const session = await getAuthSession();
        AuditService.logUserAction({
            eventType: 'agent.settings.webhook_reset',
            severity: 'high',
            apiRoute: 'DELETE /api/agent-ops/settings/webhook',
            httpMethod: 'DELETE',
            action: 'Reset Webhook Settings',
            resourceType: 'agent',
            resourceId: 'webhook-integration',
            resourceName: 'Webhook Integration',
            user: session?.user?.email || 'unknown',
            userType: 'user',
            status: 'success',
            details: 'Reset Webhook integration settings — stored credentials deleted',
            metadata: { tenantId },
        }).catch(() => {});

        return NextResponse.json({ success: true, configured: false, enabled: false });
    } catch (error: any) {
        console.error('[API /agent-ops/settings/webhook] DELETE error:', error);
        return NextResponse.json(
            { error: error.message || 'Failed to reset Webhook settings' },
            { status: 500 }
        );
    }
}
