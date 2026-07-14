/**
 * AgentOps Slack Settings API Route
 *
 * GET /api/agent-ops/settings/slack — Returns Slack config (secrets masked)
 * DELETE /api/agent-ops/settings/slack — Resets (deletes) the stored config
 * PUT /api/agent-ops/settings/slack — Validates and saves Slack config to PostgreSQL
 */

import { NextResponse } from 'next/server';
import { TenantConfigService } from '@/lib/tenant-config-service';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import { AuditService } from '@/lib/audit-service';
import { authorize } from '@/lib/rbac/authorize';
import { getSlackWorkspaceLinkRepository } from '@/lib/db/repository-factory';
import { SlackWorkspaceLinkConflictError } from '@/lib/db/repositories/slack-workspace-link/interface';
import type { SlackIntegrationConfig } from '@/lib/agent-ops/types';

const CONFIG_KEY = 'agent-ops-slack';

/**
 * Resolve the Slack team_id + bot_id for a bot token via Slack's auth.test API.
 * Used at save time to (re)establish the SlackWorkspaceLink used for inbound
 * request routing — a token that fails verification can't be linked.
 */
async function verifyBotToken(botToken: string): Promise<{ teamId: string; botUserId: string | null } | { error: string }> {
    try {
        const res = await fetch('https://slack.com/api/auth.test', {
            method: 'POST',
            headers: { Authorization: `Bearer ${botToken}` },
            signal: AbortSignal.timeout(10_000),
        });
        const data = (await res.json().catch(() => ({}))) as {
            ok?: boolean;
            error?: string;
            team_id?: string;
            bot_id?: string;
        };
        if (!data.ok || !data.team_id) {
            return { error: data.error || 'Slack rejected the Bot Token' };
        }
        return { teamId: data.team_id, botUserId: data.bot_id || null };
    } catch (error: any) {
        const message =
            error?.name === 'TimeoutError' || error?.name === 'AbortError'
                ? 'Slack API did not respond within 10 seconds'
                : error.message || 'Connection to Slack failed';
        return { error: message };
    }
}

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

        if (reveal) {
            const authError = await authorize('update', 'Agent');
            if (authError) return authError;
        }

        const show = (value: string | undefined) => (reveal ? value ?? '' : maskSecret(value));
        const link = await getSlackWorkspaceLinkRepository().getLinkForTenant(tenantId);

        if (reveal) {
            const session = await getAuthSession();
            AuditService.logUserAction({
                eventType: 'agent.settings.slack_secret_reveal',
                severity: 'high',
                apiRoute: 'GET /api/agent-ops/settings/slack',
                httpMethod: 'GET',
                action: 'channel_secret_reveal',
                resourceType: 'agent',
                resourceId: 'slack-integration',
                resourceName: 'Slack Integration',
                user: session?.user?.email || 'unknown',
                userType: 'user',
                status: 'success',
                details: 'Revealed plaintext Slack integration secrets',
                metadata: { tenantId },
            }).catch(() => {});
        }

        return NextResponse.json({
            configured: true,
            enabled: config.enabled,
            signingSecret: show(config.signingSecret),
            botToken: show(config.botToken),
            teamId: link?.teamId ?? null,
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
        const body = await req.json() as Partial<SlackIntegrationConfig> & { teamId?: string };

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

        const botToken = body.botToken?.trim() || existing?.botToken || undefined;
        const newBotTokenProvided = !!body.botToken?.trim();

        // Bare `{ enabled }` toggle calls (useToggleChannelEnabled) never touch
        // credentials, so they must keep working without requiring a team_id link —
        // only enforce link resolution on an actual credentials save.
        const isCredentialSave =
            body.signingSecret !== undefined || body.botToken !== undefined || body.teamId !== undefined;

        const linkRepo = getSlackWorkspaceLinkRepository();
        const existingLink = await linkRepo.getLinkForTenant(tenantId);

        // Resolve the Slack workspace this tenant is linked to. Inbound requests only
        // carry team_id, never our tenantId, so this link is what makes signature
        // verification and run routing resolvable at all — see SlackWorkspaceLink.
        let teamId: string | undefined = existingLink?.teamId;
        let botUserId: string | null | undefined = existingLink?.botUserId;

        if (isCredentialSave) {
            if (botToken) {
                if (newBotTokenProvided || !existingLink) {
                    const verified = await verifyBotToken(botToken);
                    if ('error' in verified) {
                        return NextResponse.json(
                            { error: `Could not verify Bot Token against Slack: ${verified.error}` },
                            { status: 400 }
                        );
                    }
                    teamId = verified.teamId;
                    botUserId = verified.botUserId;
                }
            } else {
                teamId = body.teamId?.trim() || existingLink?.teamId;
                if (!teamId) {
                    return NextResponse.json(
                        { error: 'Slack Workspace/Team ID is required when no Bot Token is set — find it in your Slack workspace URL (starts with "T")' },
                        { status: 400 }
                    );
                }
            }

            if (!teamId) {
                // Unreachable given the branches above, but keeps upsertLink's
                // required `teamId: string` honest without an unsafe cast.
                return NextResponse.json(
                    { error: 'Could not resolve a Slack workspace to link' },
                    { status: 500 }
                );
            }

            try {
                await linkRepo.upsertLink({ teamId, tenantId, botUserId });
            } catch (error) {
                if (error instanceof SlackWorkspaceLinkConflictError) {
                    return NextResponse.json({ error: error.message }, { status: 409 });
                }
                throw error;
            }
        }

        const config: SlackIntegrationConfig = {
            signingSecret,
            botToken,
            enabled: body.enabled ?? existing?.enabled ?? true,
        };

        await TenantConfigService.saveConfig(CONFIG_KEY, config, tenantId);

        console.log('[API /agent-ops/settings/slack] Saved Slack config, linked team:', teamId);

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
            teamId,
        });
    } catch (error: any) {
        console.error('[API /agent-ops/settings/slack] PUT error:', error);
        return NextResponse.json(
            { error: error.message || 'Failed to save Slack settings' },
            { status: 500 }
        );
    }
}

/**
 * DELETE — reset the Slack integration: removes the stored credentials so the
 * channel returns to its unconfigured state. Destructive and irreversible from
 * the UI (secrets are never echoed back), hence the explicit RBAC gate and a
 * high-severity audit record.
 *
 * Also drops the tenant's SlackWorkspaceLink. A link left behind would keep
 * mapping the workspace's team_id to a tenant that no longer holds a signing
 * secret, so inbound slash commands would fail signature verification instead
 * of being cleanly rejected as unlinked.
 */
export async function DELETE() {
    try {
        const authError = await authorize('delete', 'Agent');
        if (authError) return authError;

        const tenantId = await getSessionTenantId();
        await TenantConfigService.deleteConfig(CONFIG_KEY, tenantId);
        await getSlackWorkspaceLinkRepository().deleteLinkForTenant(tenantId);

        console.log('[API /agent-ops/settings/slack] Reset Slack config for tenant:', tenantId);

        const session = await getAuthSession();
        AuditService.logUserAction({
            eventType: 'agent.settings.slack_reset',
            severity: 'high',
            apiRoute: 'DELETE /api/agent-ops/settings/slack',
            httpMethod: 'DELETE',
            action: 'Reset Slack Settings',
            resourceType: 'agent',
            resourceId: 'slack-integration',
            resourceName: 'Slack Integration',
            user: session?.user?.email || 'unknown',
            userType: 'user',
            status: 'success',
            details: 'Reset Slack integration settings — stored credentials deleted',
            metadata: { tenantId },
        }).catch(() => {});

        return NextResponse.json({ success: true, configured: false, enabled: false });
    } catch (error: any) {
        console.error('[API /agent-ops/settings/slack] DELETE error:', error);
        return NextResponse.json(
            { error: error.message || 'Failed to reset Slack settings' },
            { status: 500 }
        );
    }
}
