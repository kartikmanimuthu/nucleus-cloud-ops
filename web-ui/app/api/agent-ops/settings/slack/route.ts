/**
 * AgentOps Slack Settings API Route
 *
 * GET /api/agent-ops/settings/slack — Returns Slack config (secrets masked)
 * PUT /api/agent-ops/settings/slack — Validates and saves Slack config to DynamoDB
 */

import { NextResponse } from 'next/server';
import { TenantConfigService } from '@/lib/tenant-config-service';
import type { SlackIntegrationConfig } from '@/lib/agent-ops/types';

const CONFIG_KEY = 'agent-ops-slack';

function maskSecret(value: string | undefined): string {
    if (!value) return '';
    if (value.length <= 8) return '********';
    return value.slice(0, 4) + '****' + value.slice(-4);
}

export async function GET() {
    try {
        const config = await TenantConfigService.getConfig<SlackIntegrationConfig>(CONFIG_KEY);

        if (!config) {
            return NextResponse.json({ configured: false, enabled: false });
        }

        return NextResponse.json({
            configured: true,
            enabled: config.enabled,
            signingSecret: maskSecret(config.signingSecret),
            botToken: maskSecret(config.botToken),
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
        const body = await req.json() as Partial<SlackIntegrationConfig>;

        if (!body.signingSecret || body.signingSecret.trim() === '') {
            return NextResponse.json(
                { error: 'signingSecret is required' },
                { status: 400 }
            );
        }

        const config: SlackIntegrationConfig = {
            signingSecret: body.signingSecret.trim(),
            botToken: body.botToken?.trim() || undefined,
            enabled: body.enabled !== false,
        };

        await TenantConfigService.saveConfig(CONFIG_KEY, config);

        console.log('[API /agent-ops/settings/slack] Saved Slack config');

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
