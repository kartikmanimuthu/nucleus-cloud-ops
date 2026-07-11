/**
 * AgentOps Slack Settings API Route
 *
 * GET /api/agent-ops/settings/slack — Returns Slack config (secrets masked)
 * PUT /api/agent-ops/settings/slack — Validates and saves Slack config to PostgreSQL
 */

import { NextResponse } from 'next/server';
import { TenantConfigService } from '@/lib/tenant-config-service';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import { AuditService } from '@/lib/audit-service';
import type { SlackIntegrationConfig } from '@/lib/agent-ops/types';

const CONFIG_KEY = 'agent-ops-slack';

function maskSecret(value: string | undefined): string {
    if (!value) return '';
    if (value.length <= 8) return '********';
    return value.slice(0, 4) + '****' + value.slice(-4);
}

export async function GET(req: Request) {
    try {
        const tenantId = await getSessionTenantId();
        const config = await TenantConfigService.getConfig<SlackIntegrationConfig>(CONFIG_KEY, tenantId);

        if (!config) {
            return NextResponse.json({ configured: false, enabled: false });
        }

        // Plaintext secrets are only returned when explicitly revealed by the
        // authenticated tenant admin (eye toggle), never on the default load.
        const reveal = new URL(req.url).searchParams.get('reveal') === '1';
        const show = (value: string | undefined) => (reveal ? value ?? '' : maskSecret(value));

        return NextResponse.json({
            configured: true,
            enabled: config.enabled,
            signingSecret: show(config.signingSecret),
            botToken: show(config.botToken),
        });
    } catch (error: any) {
        console.error('[API /agent-ops/settings/slack] GET error:', error);
        return NextResponse.json(
            { error: error.message || 'Failed to fetch Slack settings' },
            { status: 500 }
        );
    }
}

export async function PUT(req: Request) {
    try {
        const tenantId = await getSessionTenantId();
        const body = await req.json() as Partial<SlackIntegrationConfig>;

        // "Leave blank to keep existing values": merge the incoming body over the
        // stored config so blank secret fields retain what's already saved rather
        // than wiping it.
        const existing = await TenantConfigService.getConfig<SlackIntegrationConfig>(CONFIG_KEY, tenantId);

        const signingSecret = body.signingSecret?.trim() || existing?.signingSecret;
        if (!signingSecret) {
            return NextResponse.json(
                { error: 'signingSecret is required' },
                { status: 400 }
            );
        }

        const config: SlackIntegrationConfig = {
            signingSecret,
            botToken: body.botToken?.trim() || existing?.botToken || undefined,
            enabled: body.enabled ?? existing?.enabled ?? true,
        };

        await TenantConfigService.saveConfig(CONFIG_KEY, config, tenantId);

        console.log('[API /agent-ops/settings/slack] Saved Slack config');

        const session = await getAuthSession();
        AuditService.logUserAction({
            eventType: 'agent.settings.slack_updated',
            severity: 'medium',
            apiRoute: 'PUT /api/agent-ops/settings/slack',
            httpMethod: 'PUT',
            action: 'Updated Slack Settings',
            resourceType: 'agent',
            resourceId: 'slack-integration',
            resourceName: 'Slack Integration',
            user: session?.user?.email || 'unknown',
            userType: 'user',
            status: 'success',
            details: 'Updated Slack integration settings',
            metadata: { tenantId },
        }).catch(() => {});

        return NextResponse.json({
            success: true,
            configured: true,
            enabled: config.enabled,
            signingSecret: maskSecret(config.signingSecret),
            botToken: maskSecret(config.botToken),
        });
    } catch (error: any) {
        console.error('[API /agent-ops/settings/slack] PUT error:', error);
        return NextResponse.json(
            { error: error.message || 'Failed to save Slack settings' },
            { status: 500 }
        );
    }
}
