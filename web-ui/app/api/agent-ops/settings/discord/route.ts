/**
 * AgentOps Discord Settings API Route
 *
 * GET /api/agent-ops/settings/discord — Returns Discord config (secrets masked)
 * PUT /api/agent-ops/settings/discord — Validates and saves Discord config to PostgreSQL
 */

import { NextResponse } from 'next/server';
import { TenantConfigService } from '@/lib/tenant-config-service';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import { AuditService } from '@/lib/audit-service';
import type { DiscordIntegrationConfig } from '@/lib/agent-ops/types';

const CONFIG_KEY = 'agent-ops-discord';

function maskSecret(value: string | undefined): string {
    if (!value) return '';
    if (value.length <= 8) return '********';
    return value.slice(0, 4) + '****' + value.slice(-4);
}

export async function GET() {
    try {
        const tenantId = await getSessionTenantId();
        const config = await TenantConfigService.getConfig<DiscordIntegrationConfig>(CONFIG_KEY, tenantId);

        if (!config) {
            return NextResponse.json({ configured: false, enabled: false });
        }

        return NextResponse.json({
            configured: true,
            enabled: config.enabled,
            applicationId: config.applicationId || '',
            publicKey: maskSecret(config.publicKey),
            botToken: maskSecret(config.botToken),
        });
    } catch (error: any) {
        console.error('[API /agent-ops/settings/discord] GET error:', error);
        return NextResponse.json(
            { error: error.message || 'Failed to fetch Discord settings' },
            { status: 500 }
        );
    }
}

export async function PUT(req: Request) {
    try {
        const tenantId = await getSessionTenantId();
        const body = await req.json() as Partial<DiscordIntegrationConfig>;

        if (!body.applicationId?.trim() || !body.publicKey?.trim() || !body.botToken?.trim()) {
            return NextResponse.json(
                { error: 'applicationId, publicKey, and botToken are required' },
                { status: 400 }
            );
        }

        const config: DiscordIntegrationConfig = {
            applicationId: body.applicationId.trim(),
            publicKey: body.publicKey.trim(),
            botToken: body.botToken.trim(),
            enabled: body.enabled !== false,
        };

        await TenantConfigService.saveConfig(CONFIG_KEY, config, tenantId);

        console.log('[API /agent-ops/settings/discord] Saved Discord config');

        const session = await getAuthSession();
        AuditService.logUserAction({
            eventType: 'agent.settings.discord_updated',
            severity: 'medium',
            apiRoute: 'PUT /api/agent-ops/settings/discord',
            httpMethod: 'PUT',
            action: 'Updated Discord Settings',
            resourceType: 'agent',
            resourceId: 'discord-integration',
            resourceName: 'Discord Integration',
            user: session?.user?.email || 'unknown',
            userType: 'user',
            status: 'success',
            details: 'Updated Discord integration settings',
            metadata: { tenantId },
        }).catch(() => {});

        return NextResponse.json({
            success: true,
            configured: true,
            enabled: config.enabled,
            applicationId: config.applicationId,
            publicKey: maskSecret(config.publicKey),
            botToken: maskSecret(config.botToken),
        });
    } catch (error: any) {
        console.error('[API /agent-ops/settings/discord] PUT error:', error);
        return NextResponse.json(
            { error: error.message || 'Failed to save Discord settings' },
            { status: 500 }
        );
    }
}
