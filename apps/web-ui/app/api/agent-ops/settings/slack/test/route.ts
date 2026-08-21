/**
 * AgentOps Slack Connection Test API Route
 *
 * POST /api/agent-ops/settings/slack/test — Verifies a bot token against
 * Slack's auth.test endpoint. Uses the token from the request body when the
 * user has typed a new (unsaved) value, otherwise falls back to the stored
 * tenant config. The token itself is never echoed back.
 */

import { NextResponse } from 'next/server';
import { TenantConfigService } from '@/lib/tenant-config-service';
import { getSessionTenantId } from '@/lib/auth-session';
import { authorize } from '@/lib/rbac/authorize';
import type { SlackIntegrationConfig } from '@/lib/agent-ops/types';

const CONFIG_KEY = 'agent-ops-slack';

export async function POST(req: Request) {
    try {
        // 'Channel', not 'Agent' — testing a connection is a channel operation, and
        // this page's Save/Reset now gate on Channel too. Both subjects resolve to
        // the AIOps module, so no role's effective access changes; what changes is
        // that one screen stops being guarded by two different subjects.
        const authError = await authorize('update', 'Channel');
        if (authError) return authError;

        const tenantId = await getSessionTenantId();
        const body = (await req.json().catch(() => ({}))) as { botToken?: string };

        let botToken = body.botToken?.trim();
        if (!botToken) {
            const config = await TenantConfigService.getConfig<SlackIntegrationConfig>(CONFIG_KEY, tenantId);
            botToken = config?.botToken;
        }

        if (!botToken) {
            return NextResponse.json(
                { success: false, error: 'No Bot Token to test. Enter a Bot Token above or save one first.' },
                { status: 400 }
            );
        }

        const res = await fetch('https://slack.com/api/auth.test', {
            method: 'POST',
            headers: { Authorization: `Bearer ${botToken}` },
            signal: AbortSignal.timeout(10_000),
        });
        const data = (await res.json().catch(() => ({}))) as {
            ok?: boolean;
            error?: string;
            team?: string;
            user?: string;
        };

        if (!data.ok) {
            return NextResponse.json(
                { success: false, error: `Slack rejected the token: ${data.error || 'unknown error'}` },
                { status: 400 }
            );
        }

        return NextResponse.json({
            success: true,
            data: { team: data.team || '', botUser: data.user || '' },
        });
    } catch (error: any) {
        console.error('[API /agent-ops/settings/slack/test] POST error:', error);
        const message =
            error?.name === 'TimeoutError' || error?.name === 'AbortError'
                ? 'Slack API did not respond within 10 seconds'
                : error.message || 'Connection test failed';
        return NextResponse.json({ success: false, error: message }, { status: 500 });
    }
}
