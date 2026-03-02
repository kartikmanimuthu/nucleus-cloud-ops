/**
 * AgentOps Jira Settings API Route
 *
 * GET /api/agent-ops/settings/jira — Returns Jira config (secrets masked)
 * PUT /api/agent-ops/settings/jira — Validates and saves Jira config to DynamoDB
 */

import { NextResponse } from 'next/server';
import { TenantConfigService } from '@/lib/tenant-config-service';
import type { JiraIntegrationConfig } from '@/lib/agent-ops/types';

const CONFIG_KEY = 'agent-ops-jira';

function maskSecret(value: string | undefined): string {
    if (!value) return '';
    if (value.length <= 8) return '********';
    return value.slice(0, 4) + '****' + value.slice(-4);
}

export async function GET() {
    try {
        const config = await TenantConfigService.getConfig<JiraIntegrationConfig>(CONFIG_KEY);

        if (!config) {
            return NextResponse.json({ configured: false, enabled: false });
        }

        return NextResponse.json({
            configured: true,
            enabled: config.enabled,
            webhookSecret: maskSecret(config.webhookSecret),
            baseUrl: config.baseUrl || '',
            userEmail: config.userEmail || '',
            apiToken: maskSecret(config.apiToken),
        });
    } catch (error: any) {
        console.error('[API /agent-ops/settings/jira] GET error:', error);
        return NextResponse.json(
            { error: error.message || 'Failed to fetch Jira settings' },
            { status: 500 }
        );
    }
}

export async function PUT(req: Request) {
    try {
        const body = await req.json() as Partial<JiraIntegrationConfig>;

        if (!body.webhookSecret || body.webhookSecret.trim() === '') {
            return NextResponse.json(
                { error: 'webhookSecret is required' },
                { status: 400 }
            );
        }

        const config: JiraIntegrationConfig = {
            webhookSecret: body.webhookSecret.trim(),
            baseUrl: body.baseUrl?.trim() || undefined,
            userEmail: body.userEmail?.trim() || undefined,
            apiToken: body.apiToken?.trim() || undefined,
            enabled: body.enabled !== false,
        };

        await TenantConfigService.saveConfig(CONFIG_KEY, config);

        console.log('[API /agent-ops/settings/jira] Saved Jira config');

        return NextResponse.json({
            success: true,
            configured: true,
            enabled: config.enabled,
            webhookSecret: maskSecret(config.webhookSecret),
            baseUrl: config.baseUrl || '',
            userEmail: config.userEmail || '',
            apiToken: maskSecret(config.apiToken),
        });
    } catch (error: any) {
        console.error('[API /agent-ops/settings/jira] PUT error:', error);
        return NextResponse.json(
            { error: error.message || 'Failed to save Jira settings' },
            { status: 500 }
        );
    }
}
