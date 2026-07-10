/**
 * Connector OAuth Authorize
 *
 * GET /api/connections/[provider]/authorize — 302 to the provider consent
 * screen using the tenant's own OAuth app, with a signed `state` and a
 * matching httpOnly CSRF nonce cookie.
 */
import { NextResponse } from 'next/server';
import { getSessionTenantId } from '@/lib/auth-session';
import { authorize } from '@/lib/rbac/authorize';
import { getProviderConfig, isConnectorProvider } from '@/lib/connectors/providers';
import { resolveAppCredentials } from '@/lib/connectors/app-credentials';
import { signState } from '@/lib/connectors/oauth-state';
import { randomBytes } from 'crypto';
import type { ConnectorProvider } from '@/lib/db/repositories/connectors/interface';

type Ctx = { params: Promise<{ provider: string }> };

export async function GET(req: Request, { params }: Ctx) {
    const { provider } = await params;
    if (!isConnectorProvider(provider)) return NextResponse.json({ success: false, error: 'Unknown provider' }, { status: 400 });
    const forbidden = await authorize('update', 'Agent'); if (forbidden) return forbidden;
    const tenantId = await getSessionTenantId();
    const creds = await resolveAppCredentials(provider as ConnectorProvider, tenantId);
    if (!creds?.clientId) return NextResponse.json({ success: false, error: 'Connector app not configured' }, { status: 400 });

    const cfg = getProviderConfig(provider);
    const origin = new URL(req.url).origin;
    const nonce = randomBytes(16).toString('hex');
    const state = signState({ tenantId, provider, nonce });
    const url = new URL(cfg.authorizeUrl);
    url.searchParams.set('client_id', creds.clientId);
    url.searchParams.set('redirect_uri', `${origin}/api/connections/${provider}/callback`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', cfg.scopes.join(' '));
    url.searchParams.set('state', state);
    for (const [k, v] of Object.entries(cfg.extraAuthorizeParams ?? {})) url.searchParams.set(k, v);
    if (provider === 'slack') url.searchParams.set('user_scope', cfg.scopes.join(','));

    const res = NextResponse.redirect(url.toString());
    res.cookies.set('connector_oauth_nonce', nonce, { httpOnly: true, sameSite: 'lax', secure: origin.startsWith('https'), path: '/', maxAge: 600 });
    return res;
}
