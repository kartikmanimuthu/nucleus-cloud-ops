/**
 * AgentOps Jira Connection Test API Route
 *
 * POST /api/agent-ops/settings/jira/test — Verifies Base URL + User Email +
 * API Token by calling Jira's /rest/api/3/myself. Values from the request
 * body (unsaved form input) win; blank fields fall back to the stored tenant
 * config. Returns the authenticated account's displayName and accountId so
 * the UI can auto-fill the Bot Account ID field. Secrets are never echoed.
 */

import { NextResponse } from 'next/server';
import { TenantConfigService } from '@/lib/tenant-config-service';
import { getSessionTenantId } from '@/lib/auth-session';
import { authorize } from '@/lib/rbac/authorize';
import type { JiraIntegrationConfig } from '@/lib/agent-ops/types';

const CONFIG_KEY = 'agent-ops-jira';

export async function POST(req: Request) {
    try {
        // 'Channel', not 'Agent' — see the Slack test route.
        const authError = await authorize('update', 'Channel');
        if (authError) return authError;

        const tenantId = await getSessionTenantId();
        const body = (await req.json().catch(() => ({}))) as {
            baseUrl?: string;
            userEmail?: string;
            apiToken?: string;
        };

        const existing = await TenantConfigService.getConfig<JiraIntegrationConfig>(CONFIG_KEY, tenantId);

        const baseUrl = (body.baseUrl?.trim() || existing?.baseUrl || '').replace(/\/+$/, '');
        const userEmail = body.userEmail?.trim() || existing?.userEmail;
        const apiToken = body.apiToken?.trim() || existing?.apiToken;

        if (!baseUrl || !userEmail || !apiToken) {
            return NextResponse.json(
                { success: false, error: 'Base URL, User Email, and API Token are all required to test the connection.' },
                { status: 400 }
            );
        }
        if (!baseUrl.startsWith('https://')) {
            return NextResponse.json(
                { success: false, error: 'Base URL must start with https:// (e.g. https://your-org.atlassian.net).' },
                { status: 400 }
            );
        }

        const auth = Buffer.from(`${userEmail}:${apiToken}`).toString('base64');
        const res = await fetch(`${baseUrl}/rest/api/3/myself`, {
            headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
            signal: AbortSignal.timeout(10_000),
        });

        if (res.status === 401 || res.status === 403) {
            return NextResponse.json(
                { success: false, error: 'Jira rejected the credentials — check the User Email and API Token.' },
                { status: 400 }
            );
        }
        if (!res.ok) {
            return NextResponse.json(
                { success: false, error: `Jira returned HTTP ${res.status} — check the Base URL.` },
                { status: 400 }
            );
        }

        const me = (await res.json().catch(() => ({}))) as {
            displayName?: string;
            accountId?: string;
            emailAddress?: string;
        };

        return NextResponse.json({
            success: true,
            data: {
                displayName: me.displayName || '',
                accountId: me.accountId || '',
                emailAddress: me.emailAddress || '',
            },
        });
    } catch (error: any) {
        console.error('[API /agent-ops/settings/jira/test] POST error:', error);
        const message =
            error?.name === 'TimeoutError' || error?.name === 'AbortError'
                ? 'Jira did not respond within 10 seconds — check the Base URL'
                : error.message || 'Connection test failed';
        return NextResponse.json({ success: false, error: message }, { status: 500 });
    }
}
