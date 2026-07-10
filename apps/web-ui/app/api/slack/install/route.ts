/**
 * Slack Workspace-Bot Install — start
 *
 * GET /api/slack/install — 302 to Slack's app-install consent (bot scopes),
 * using the tenant's own Slack OAuth app. Distinct from the per-account
 * "Connect Slack" flow: this installs the bot for slash commands + posting.
 */
import { NextResponse } from 'next/server';
import { getConnectorRepository } from '@/lib/db/repository-factory';
import { getSessionTenantId } from '@/lib/auth-session';
import { authorize } from '@/lib/rbac/authorize';
import { signState } from '@/lib/connectors/oauth-state';
import { randomBytes } from 'crypto';

const BOT_SCOPES = ['chat:write', 'commands', 'channels:read'];

export async function GET(req: Request) {
    const forbidden = await authorize('update', 'Agent'); if (forbidden) return forbidden;
    const tenantId = await getSessionTenantId();
    const app = await getConnectorRepository().getApp('slack', tenantId);
    if (!app?.clientId) return NextResponse.json({ success: false, error: 'Slack app not configured' }, { status: 400 });
    const origin = new URL(req.url).origin;
    const nonce = randomBytes(16).toString('hex');
    const state = signState({ tenantId, provider: 'slack', nonce });
    const url = new URL('https://slack.com/oauth/v2/authorize');
    url.searchParams.set('client_id', app.clientId);
    url.searchParams.set('scope', BOT_SCOPES.join(','));
    url.searchParams.set('redirect_uri', `${origin}/api/slack/install/callback`);
    url.searchParams.set('state', state);
    const res = NextResponse.redirect(url.toString());
    res.cookies.set('connector_oauth_nonce', nonce, { httpOnly: true, sameSite: 'lax', secure: origin.startsWith('https'), path: '/', maxAge: 600 });
    return res;
}
