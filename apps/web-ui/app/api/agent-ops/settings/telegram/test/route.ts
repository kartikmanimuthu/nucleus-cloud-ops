/**
 * AgentOps Telegram Connection Test API Route
 *
 * POST /api/agent-ops/settings/telegram/test — Verifies a bot token against
 * Telegram's getMe endpoint and reports the current webhook status via
 * getWebhookInfo. Uses the token from the request body when the user has typed
 * a new (unsaved) value, otherwise falls back to the stored tenant config. The
 * token itself is never echoed back.
 */

import { NextResponse } from 'next/server';
import { TenantConfigService } from '@/lib/tenant-config-service';
import { getSessionTenantId } from '@/lib/auth-session';
import { authorize } from '@/lib/rbac/authorize';
import type { TelegramIntegrationConfig } from '@/lib/agent-ops/types';

const CONFIG_KEY = 'agent-ops-telegram';

export async function POST(req: Request) {
    try {
        // 'Channel', not 'Agent' — see the Slack test route.
        const authError = await authorize('update', 'Channel');
        if (authError) return authError;

        const tenantId = await getSessionTenantId();
        const body = (await req.json().catch(() => ({}))) as { botToken?: string };

        let botToken = body.botToken?.trim();
        if (!botToken) {
            const config = await TenantConfigService.getConfig<TelegramIntegrationConfig>(CONFIG_KEY, tenantId);
            botToken = config?.botToken;
        }

        if (!botToken) {
            return NextResponse.json(
                { success: false, error: 'No Bot Token to test. Enter a Bot Token above or save one first.' },
                { status: 400 }
            );
        }

        const meRes = await fetch(`https://api.telegram.org/bot${botToken}/getMe`, {
            signal: AbortSignal.timeout(10_000),
        });
        const me = (await meRes.json().catch(() => ({}))) as {
            ok?: boolean;
            description?: string;
            result?: { username?: string };
        };

        if (!me.ok) {
            return NextResponse.json(
                { success: false, error: `Telegram rejected the token: ${me.description || 'unknown error'}` },
                { status: 400 }
            );
        }

        const infoRes = await fetch(`https://api.telegram.org/bot${botToken}/getWebhookInfo`, {
            signal: AbortSignal.timeout(10_000),
        });
        const info = (await infoRes.json().catch(() => ({}))) as {
            ok?: boolean;
            result?: {
                url?: string;
                last_error_message?: string;
                pending_update_count?: number;
            };
        };

        const webhook = info.result || {};

        return NextResponse.json({
            success: true,
            data: {
                botUsername: me.result?.username || '',
                webhook: {
                    url: webhook.url || '',
                    isSet: Boolean(webhook.url),
                    lastErrorMessage: webhook.last_error_message || '',
                    pendingUpdateCount: webhook.pending_update_count ?? 0,
                },
            },
        });
    } catch (error: any) {
        console.error('[API /agent-ops/settings/telegram/test] POST error:', error);
        const message =
            error?.name === 'TimeoutError' || error?.name === 'AbortError'
                ? 'Telegram API did not respond within 10 seconds'
                : error.message || 'Connection test failed';
        return NextResponse.json({ success: false, error: message }, { status: 500 });
    }
}
