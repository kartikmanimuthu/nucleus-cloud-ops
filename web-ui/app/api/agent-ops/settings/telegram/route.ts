/**
 * AgentOps Telegram Settings API Route
 *
 * GET /api/agent-ops/settings/telegram — Returns Telegram config (secrets masked)
 * PUT /api/agent-ops/settings/telegram — Validates and saves Telegram config to PostgreSQL
 */

import { NextResponse } from 'next/server';
import { TenantConfigService } from '@/lib/tenant-config-service';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import { AuditService } from '@/lib/audit-service';
import type { TelegramIntegrationConfig } from '@/lib/agent-ops/types';

const CONFIG_KEY = 'agent-ops-telegram';

function maskSecret(value: string | undefined): string {
    if (!value) return '';
    if (value.length <= 8) return '********';
    return value.slice(0, 4) + '****' + value.slice(-4);
}

export async function GET() {
    try {
        const tenantId = await getSessionTenantId();
        const config = await TenantConfigService.getConfig<TelegramIntegrationConfig>(CONFIG_KEY, tenantId);

        if (!config) {
            return NextResponse.json({ configured: false, enabled: false });
        }

        return NextResponse.json({
            configured: true,
            enabled: config.enabled,
            botToken: maskSecret(config.botToken),
            secretToken: maskSecret(config.secretToken),
        });
    } catch (error: any) {
        console.error('[API /agent-ops/settings/telegram] GET error:', error);
        return NextResponse.json(
            { error: error.message || 'Failed to fetch Telegram settings' },
            { status: 500 }
        );
    }
}

export async function PUT(req: Request) {
    try {
        const tenantId = await getSessionTenantId();
        const body = await req.json() as Partial<TelegramIntegrationConfig>;

        if (!body.botToken?.trim() || !body.secretToken?.trim()) {
            return NextResponse.json(
                { error: 'botToken and secretToken are required' },
                { status: 400 }
            );
        }

        const config: TelegramIntegrationConfig = {
            botToken: body.botToken.trim(),
            secretToken: body.secretToken.trim(),
            enabled: body.enabled !== false,
        };

        await TenantConfigService.saveConfig(CONFIG_KEY, config, tenantId);

        console.log('[API /agent-ops/settings/telegram] Saved Telegram config');

        const session = await getAuthSession();
        AuditService.logUserAction({
            eventType: 'agent.settings.telegram_updated',
            severity: 'medium',
            apiRoute: 'PUT /api/agent-ops/settings/telegram',
            httpMethod: 'PUT',
            action: 'Updated Telegram Settings',
            resourceType: 'agent',
            resourceId: 'telegram-integration',
            resourceName: 'Telegram Integration',
            user: session?.user?.email || 'unknown',
            userType: 'user',
            status: 'success',
            details: 'Updated Telegram integration settings',
            metadata: { tenantId },
        }).catch(() => {});

        return NextResponse.json({
            success: true,
            configured: true,
            enabled: config.enabled,
            botToken: maskSecret(config.botToken),
            secretToken: maskSecret(config.secretToken),
        });
    } catch (error: any) {
        console.error('[API /agent-ops/settings/telegram] PUT error:', error);
        return NextResponse.json(
            { error: error.message || 'Failed to save Telegram settings' },
            { status: 500 }
        );
    }
}
