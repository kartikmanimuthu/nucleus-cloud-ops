/**
 * AgentOps Telegram Webhook Registration API Route
 *
 * POST /api/agent-ops/settings/telegram/webhook — Registers the webhook with
 * Telegram on the user's behalf (one-click alternative to the manual setWebhook
 * curl). Uses the token/secret from the request body when the user has typed
 * new (unsaved) values, otherwise falls back to the stored tenant config.
 * Telegram requires an HTTPS URL, so this cannot target localhost.
 */

import { NextResponse } from 'next/server';
import { TenantConfigService } from '@/lib/tenant-config-service';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import { AuditService } from '@/lib/audit-service';
import { authorize } from '@/lib/rbac/authorize';
import type { TelegramIntegrationConfig } from '@/lib/agent-ops/types';

const CONFIG_KEY = 'agent-ops-telegram';

export async function POST(req: Request) {
    try {
        // 'Channel', not 'Agent' — see the Slack test route.
        const authError = await authorize('update', 'Channel');
        if (authError) return authError;

        const tenantId = await getSessionTenantId();
        const body = (await req.json().catch(() => ({}))) as {
            webhookUrl?: string;
            botToken?: string;
            secretToken?: string;
        };

        const existing = await TenantConfigService.getConfig<TelegramIntegrationConfig>(CONFIG_KEY, tenantId);

        const webhookUrl = body.webhookUrl?.trim() || '';
        const botToken = body.botToken?.trim() || existing?.botToken;
        const secretToken = body.secretToken?.trim() || existing?.secretToken;

        if (!botToken || !secretToken) {
            return NextResponse.json(
                { success: false, error: 'Bot Token and Secret Token are both required. Enter them above or save them first.' },
                { status: 400 }
            );
        }
        if (!webhookUrl.startsWith('https://')) {
            return NextResponse.json(
                { success: false, error: "Telegram requires an HTTPS webhook URL — this won't work from localhost." },
                { status: 400 }
            );
        }

        const res = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: webhookUrl, secret_token: secretToken }),
            signal: AbortSignal.timeout(10_000),
        });
        const data = (await res.json().catch(() => ({}))) as {
            ok?: boolean;
            description?: string;
        };

        if (!data.ok) {
            return NextResponse.json(
                { success: false, error: `Telegram rejected the webhook: ${data.description || 'unknown error'}` },
                { status: 400 }
            );
        }

        const session = await getAuthSession();
        AuditService.logUserAction({
            eventType: 'agent.settings.telegram_webhook_registered',
            severity: 'medium',
            apiRoute: 'POST /api/agent-ops/settings/telegram/webhook',
            httpMethod: 'POST',
            action: 'Registered Telegram Webhook',
            resourceType: 'agent',
            resourceId: 'telegram-integration',
            resourceName: 'Telegram Integration',
            user: session?.user?.email || 'unknown',
            userType: 'user',
            status: 'success',
            details: 'Registered Telegram webhook with Telegram',
            metadata: { tenantId },
        }).catch(() => {});

        return NextResponse.json({ success: true, data: { url: webhookUrl } });
    } catch (error: any) {
        console.error('[API /agent-ops/settings/telegram/webhook] POST error:', error);
        const message =
            error?.name === 'TimeoutError' || error?.name === 'AbortError'
                ? 'Telegram API did not respond within 10 seconds'
                : error.message || 'Failed to register webhook';
        return NextResponse.json({ success: false, error: message }, { status: 500 });
    }
}
