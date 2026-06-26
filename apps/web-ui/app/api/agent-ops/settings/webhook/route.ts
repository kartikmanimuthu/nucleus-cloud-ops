/**
 * AgentOps Webhook Settings API Route
 *
 * GET /api/agent-ops/settings/webhook — Returns Webhook config (secrets masked)
 * PUT /api/agent-ops/settings/webhook — Validates and saves Webhook config to PostgreSQL
 */

import { NextResponse } from 'next/server';
import { TenantConfigService } from '@/lib/tenant-config-service';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import { AuditService } from '@/lib/audit-service';
import type { WebhookIntegrationConfig } from '@/lib/agent-ops/types';

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

export async function PUT(req: Request) {
    try {
        const tenantId = await getSessionTenantId();
        const body = await req.json() as Partial<WebhookIntegrationConfig>;

        if (!body.webhookSecret?.trim()) {
            return NextResponse.json(
                { error: 'webhookSecret is required' },
                { status: 400 }
            );
        }

        const config: WebhookIntegrationConfig = {
            webhookSecret: body.webhookSecret.trim(),
            enabled: body.enabled !== false,
        };

        await TenantConfigService.saveConfig(CONFIG_KEY, config, tenantId);

        console.log('[API /agent-ops/settings/webhook] Saved Webhook config');

        const session = await getAuthSession();
        AuditService.logUserAction({
            eventType: 'agent.settings.webhook_updated',
            severity: 'medium',
            apiRoute: 'PUT /api/agent-ops/settings/webhook',
            httpMethod: 'PUT',
            action: 'Updated Webhook Settings',
            resourceType: 'agent',
            resourceId: 'webhook-integration',
            resourceName: 'Webhook Integration',
            user: session?.user?.email || 'unknown',
            userType: 'user',
            status: 'success',
            details: 'Updated Webhook integration settings',
            metadata: { tenantId },
        }).catch(() => {});

        return NextResponse.json({
            success: true,
            configured: true,
            enabled: config.enabled,
            webhookSecret: maskSecret(config.webhookSecret),
        });
    } catch (error: any) {
        console.error('[API /agent-ops/settings/webhook] PUT error:', error);
        return NextResponse.json(
            { error: error.message || 'Failed to save Webhook settings' },
            { status: 500 }
        );
    }
}
