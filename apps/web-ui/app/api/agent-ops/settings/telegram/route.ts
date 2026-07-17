/**
 * AgentOps Telegram Settings API Route
 *
 * GET /api/agent-ops/settings/telegram — Returns Telegram config (secrets masked)
 * DELETE /api/agent-ops/settings/telegram — Resets (deletes) the stored config
 * PUT /api/agent-ops/settings/telegram — Validates and saves Telegram config to PostgreSQL
 */

import { NextResponse } from 'next/server';
import { TenantConfigService } from '@/lib/tenant-config-service';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import { AuditService } from '@/lib/audit-service';
import { authorize } from '@/lib/rbac/authorize';
import { getTelegramBotLinkRepository } from '@/lib/db/repository-factory';
import { TelegramBotLinkConflictError } from '@/lib/db/repositories/telegram-bot-link/interface';
import type { TelegramIntegrationConfig } from '@/lib/agent-ops/types';

const CONFIG_KEY = 'agent-ops-telegram';

function maskSecret(value: string | undefined): string {
    if (!value) return '';
    if (value.length <= 8) return '********';
    return value.slice(0, 4) + '****' + value.slice(-4);
}

export async function GET(req: Request) {
    try {
        const tenantId = await getSessionTenantId();
        const config = await TenantConfigService.getConfig<TelegramIntegrationConfig>(CONFIG_KEY, tenantId);

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
                eventType: 'agent.settings.telegram_secret_reveal',
                severity: 'high',
                apiRoute: 'GET /api/agent-ops/settings/telegram',
                httpMethod: 'GET',
                action: 'channel_secret_reveal',
                resourceType: 'agent',
                resourceId: 'telegram-integration',
                resourceName: 'Telegram Integration',
                user: session?.user?.email || 'unknown',
                userType: 'user',
                status: 'success',
                details: 'Revealed plaintext Telegram integration secrets',
                metadata: { tenantId },
            }).catch(() => {});
        }

        return NextResponse.json({
            configured: true,
            enabled: config.enabled,
            botToken: show(config.botToken),
            secretToken: show(config.secretToken),
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

        // "Leave blank to keep existing values": merge the incoming body over the
        // stored config so blank secret fields retain what's already saved.
        const existing = await TenantConfigService.getConfig<TelegramIntegrationConfig>(CONFIG_KEY, tenantId);

        const botToken = body.botToken?.trim() || existing?.botToken;
        const secretToken = body.secretToken?.trim() || existing?.secretToken;
        if (!botToken || !secretToken) {
            return NextResponse.json(
                { error: 'botToken and secretToken are required' },
                { status: 400 }
            );
        }

        // Inbound Telegram updates carry no tenant-identifying field — the secret
        // token is the only value that can resolve which tenant a request belongs
        // to (see TelegramBotLink), so keep the reverse-index in sync with every save.
        const linkRepo = getTelegramBotLinkRepository();
        if (secretToken !== existing?.secretToken) {
            // Secret is new or rotating — drop any previous link for this tenant so a
            // stale row from the old secret doesn't linger in the lookup table.
            await linkRepo.deleteLinkForTenant(tenantId);
        }
        try {
            await linkRepo.upsertLink({ secretToken, tenantId });
        } catch (error) {
            if (error instanceof TelegramBotLinkConflictError) {
                return NextResponse.json({ error: error.message }, { status: 409 });
            }
            throw error;
        }

        const config: TelegramIntegrationConfig = {
            botToken,
            secretToken,
            enabled: body.enabled ?? existing?.enabled ?? true,
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

/**
 * DELETE — reset the Telegram integration: removes the stored credentials so the
 * channel returns to its unconfigured state. Destructive and irreversible from
 * the UI (secrets are never echoed back), hence the explicit RBAC gate and a
 * high-severity audit record.
 */
export async function DELETE() {
    try {
        const authError = await authorize('delete', 'Agent');
        if (authError) return authError;

        const tenantId = await getSessionTenantId();
        await TenantConfigService.deleteConfig(CONFIG_KEY, tenantId);
        await getTelegramBotLinkRepository().deleteLinkForTenant(tenantId);

        console.log('[API /agent-ops/settings/telegram] Reset Telegram config for tenant:', tenantId);

        const session = await getAuthSession();
        AuditService.logUserAction({
            eventType: 'agent.settings.telegram_reset',
            severity: 'high',
            apiRoute: 'DELETE /api/agent-ops/settings/telegram',
            httpMethod: 'DELETE',
            action: 'Reset Telegram Settings',
            resourceType: 'agent',
            resourceId: 'telegram-integration',
            resourceName: 'Telegram Integration',
            user: session?.user?.email || 'unknown',
            userType: 'user',
            status: 'success',
            details: 'Reset Telegram integration settings — stored credentials deleted',
            metadata: { tenantId },
        }).catch(() => {});

        return NextResponse.json({ success: true, configured: false, enabled: false });
    } catch (error: any) {
        console.error('[API /agent-ops/settings/telegram] DELETE error:', error);
        return NextResponse.json(
            { error: error.message || 'Failed to reset Telegram settings' },
            { status: 500 }
        );
    }
}
