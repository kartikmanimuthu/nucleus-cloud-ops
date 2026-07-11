/**
 * AgentOps Jira Settings API Route
 *
 * GET /api/agent-ops/settings/jira — Returns Jira config (secrets masked)
 * PUT /api/agent-ops/settings/jira — Validates and saves Jira config to PostgreSQL
 */

import { NextResponse } from 'next/server';
import { TenantConfigService } from '@/lib/tenant-config-service';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import { AuditService } from '@/lib/audit-service';
import { authorize } from '@/lib/rbac/authorize';
import type { JiraIntegrationConfig } from '@/lib/agent-ops/types';

const CONFIG_KEY = 'agent-ops-jira';

function maskSecret(value: string | undefined): string {
    if (!value) return '';
    if (value.length <= 8) return '********';
    return value.slice(0, 4) + '****' + value.slice(-4);
}

export async function GET(req: Request) {
    try {
        const tenantId = await getSessionTenantId();
        const config = await TenantConfigService.getConfig<JiraIntegrationConfig>(CONFIG_KEY, tenantId);

        if (!config) {
            return NextResponse.json({ configured: false, enabled: false });
        }

        // Plaintext secrets are only returned when explicitly revealed by the
        // authenticated tenant admin (eye toggle), never on the default load.
        const reveal = new URL(req.url).searchParams.get('reveal') === '1';

        if (reveal) {
            const authError = await authorize('update', 'Agent');
            if (authError) return authError;
        }

        const show = (value: string | undefined) => (reveal ? value ?? '' : maskSecret(value));

        if (reveal) {
            const session = await getAuthSession();
            AuditService.logUserAction({
                eventType: 'agent.settings.jira_secret_reveal',
                severity: 'high',
                apiRoute: 'GET /api/agent-ops/settings/jira',
                httpMethod: 'GET',
                action: 'channel_secret_reveal',
                resourceType: 'agent',
                resourceId: 'jira-integration',
                resourceName: 'Jira Integration',
                user: session?.user?.email || 'unknown',
                userType: 'user',
                status: 'success',
                details: 'Revealed plaintext Jira integration secrets',
                metadata: { tenantId },
            }).catch(() => {});
        }

        return NextResponse.json({
            configured: true,
            enabled: config.enabled,
            webhookSecret: show(config.webhookSecret),
            baseUrl: config.baseUrl || '',
            userEmail: config.userEmail || '',
            apiToken: show(config.apiToken),
            botAccountId: config.botAccountId || '',
            autoApprove: config.autoApprove ?? false,
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
        const tenantId = await getSessionTenantId();
        const body = await req.json() as Partial<JiraIntegrationConfig>;

        // "Leave blank to keep existing values": merge the incoming body over the
        // stored config so blank fields retain what's already saved rather than
        // wiping it (secrets especially can never be re-read from the masked GET).
        const existing = await TenantConfigService.getConfig<JiraIntegrationConfig>(CONFIG_KEY, tenantId);

        const webhookSecret = body.webhookSecret?.trim() || existing?.webhookSecret;
        if (!webhookSecret) {
            return NextResponse.json(
                { error: 'webhookSecret is required' },
                { status: 400 }
            );
        }

        const config: JiraIntegrationConfig = {
            webhookSecret,
            baseUrl: body.baseUrl?.trim() || existing?.baseUrl || undefined,
            userEmail: body.userEmail?.trim() || existing?.userEmail || undefined,
            apiToken: body.apiToken?.trim() || existing?.apiToken || undefined,
            botAccountId: body.botAccountId?.trim() || existing?.botAccountId || undefined,
            enabled: body.enabled ?? existing?.enabled ?? true,
            autoApprove: body.autoApprove ?? existing?.autoApprove ?? false,
        };

        await TenantConfigService.saveConfig(CONFIG_KEY, config, tenantId);

        console.log('[API /agent-ops/settings/jira] Saved Jira config');

        const session = await getAuthSession();
        AuditService.logUserAction({
            eventType: 'agent.settings.jira_updated',
            severity: 'medium',
            apiRoute: 'PUT /api/agent-ops/settings/jira',
            httpMethod: 'PUT',
            action: 'Updated Jira Settings',
            resourceType: 'agent',
            resourceId: 'jira-integration',
            resourceName: 'Jira Integration',
            user: session?.user?.email || 'unknown',
            userType: 'user',
            status: 'success',
            details: 'Updated Jira integration settings',
            metadata: { tenantId },
        }).catch(() => {});

        return NextResponse.json({
            success: true,
            configured: true,
            enabled: config.enabled,
            webhookSecret: maskSecret(config.webhookSecret),
            baseUrl: config.baseUrl || '',
            userEmail: config.userEmail || '',
            apiToken: maskSecret(config.apiToken),
            botAccountId: config.botAccountId || '',
            autoApprove: config.autoApprove ?? false,
        });
    } catch (error: any) {
        console.error('[API /agent-ops/settings/jira] PUT error:', error);
        return NextResponse.json(
            { error: error.message || 'Failed to save Jira settings' },
            { status: 500 }
        );
    }
}
