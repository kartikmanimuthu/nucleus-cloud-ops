/**
 * AgentOps Telegram Settings API Route
 *
 * GET /api/agent-ops/settings/telegram — Returns Telegram config (secrets masked)
 * DELETE /api/agent-ops/settings/telegram — Resets (deletes) the stored config
 * POST /api/agent-ops/settings/telegram — Creates the config (first-time connect)
 * PUT /api/agent-ops/settings/telegram — Updates the existing config
 *
 * POST and PUT share one handler but are NOT interchangeable — see the Slack
 * route for why the create/update split has to be two methods.
 */

import { NextResponse } from 'next/server';
import { TenantConfigService } from '@/lib/tenant-config-service';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import { AuditService } from '@/lib/audit-service';
import { authorize } from '@/lib/rbac/authorize';
import { getTelegramBotLinkRepository } from '@/lib/db/repository-factory';
import { TelegramBotLinkConflictError } from '@/lib/db/repositories/telegram-bot-link/interface';
import type { TelegramIntegrationConfig } from '@/lib/agent-ops/types';
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

        // Always masked. Plaintext lives behind GET /reveal, which requires
        // `update` and audits — see lib/channels/secret-reveal.ts.
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

/** First-time connect. 409s if Telegram is already configured — that is PUT's job. */
export async function POST(req: Request) {
    return handleSave(req, 'create');
}

/** Edit an existing connection (credentials, enable toggle). */
export async function PUT(req: Request) {
    return handleSave(req, 'update');
}

async function handleSave(req: Request, mode: 'create' | 'update') {
    try {
        const tenantId = await getSessionTenantId();
        const body = await req.json() as Partial<TelegramIntegrationConfig>;

        // "Leave blank to keep existing values": merge the incoming body over the
        // stored config so blank secret fields retain what's already saved.
        const existing = await TenantConfigService.getConfig<TelegramIntegrationConfig>(CONFIG_KEY, tenantId);

        // The create/update boundary — see the Slack route for the full rationale.
        if (mode === 'create' && existing) {
            return NextResponse.json(
                { error: 'Telegram is already configured — use PUT to update the existing connection' },
                { status: 409 }
            );
        }
        if (mode === 'update' && !existing) {
            return NextResponse.json(
                { error: 'Telegram is not configured yet — use POST to create the connection' },
                { status: 404 }
            );
        }

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

        const created = mode === 'create';
        const session = await getAuthSession();
        AuditService.logUserAction({
            eventType: created ? 'agent.settings.telegram_created' : 'agent.settings.telegram_updated',
            severity: 'medium',
            apiRoute: `${created ? 'POST' : 'PUT'} /api/agent-ops/settings/telegram`,
            httpMethod: created ? 'POST' : 'PUT',
            action: created ? 'Connected Telegram' : 'Updated Telegram Settings',
            resourceType: 'agent',
            resourceId: 'telegram-integration',
            resourceName: 'Telegram Integration',
            user: session?.user?.email || 'unknown',
            userType: 'user',
            status: 'success',
            details: created
                ? 'Created the Telegram integration connection'
                : 'Updated Telegram integration settings',
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
        console.error(`[API /agent-ops/settings/telegram] ${mode} error:`, error);
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
        const authError = await authorize('delete', 'Channel');
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
