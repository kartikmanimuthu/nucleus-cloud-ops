/**
 * Connector OAuth Callback
 *
 * GET /api/connections/[provider]/callback — verifies signed state + CSRF
 * nonce, exchanges the code for tokens, resolves the account identity, and
 * stores an encrypted ConnectorConnection. Redirects back to the connector
 * settings page with ?connected=1 or ?error=...
 */
import { NextResponse } from 'next/server';
import { getConnectorRepository } from '@/lib/db/repository-factory';
import { verifyState } from '@/lib/connectors/oauth-state';
import { exchangeCode, fetchIdentity } from '@/lib/connectors/token-exchange';
import { resolveAppCredentials } from '@/lib/connectors/app-credentials';
import { encryptJson } from '@/lib/crypto/provider-credentials';
import { isConnectorProvider } from '@/lib/connectors/providers';
import { AuditService } from '@/lib/audit-service';
import type { ConnectorProvider } from '@/lib/db/repositories/connectors/interface';

type Ctx = { params: Promise<{ provider: string }> };

function redirectPage(origin: string, provider: string, query: string) {
    return NextResponse.redirect(`${origin}/app/channels/${provider}-settings?${query}`);
}

export async function GET(req: Request, { params }: Ctx) {
    const { provider } = await params;
    const origin = new URL(req.url).origin;
    if (!isConnectorProvider(provider)) return NextResponse.json({ success: false, error: 'Unknown provider' }, { status: 400 });

    try {
        const url = new URL(req.url);
        const code = url.searchParams.get('code');
        const stateToken = url.searchParams.get('state');
        if (url.searchParams.get('error')) throw new Error(url.searchParams.get('error') || 'consent_denied');
        if (!code || !stateToken) throw new Error('Missing code/state');

        const state = verifyState(stateToken);
        if (state.provider !== provider) throw new Error('State provider mismatch');
        const cookieNonce = req.headers.get('cookie')?.match(/connector_oauth_nonce=([^;]+)/)?.[1];
        if (!cookieNonce || cookieNonce !== state.nonce) throw new Error('CSRF nonce mismatch');

        const tenantId = state.tenantId;
        const repo = getConnectorRepository();
        const creds = await resolveAppCredentials(provider as ConnectorProvider, tenantId);
        if (!creds) throw new Error('Connector app not configured');

        const redirectUri = `${origin}/api/connections/${provider}/callback`;
        const tokens = await exchangeCode(provider as ConnectorProvider, creds, code, redirectUri);
        const identity = await fetchIdentity(provider as ConnectorProvider, tokens.accessToken);

        await repo.upsertConnection({
            provider: provider as ConnectorProvider,
            accountLabel: identity.accountLabel,
            externalAccountId: identity.externalAccountId,
            accessTokenEnc: encryptJson(tokens.accessToken),
            refreshTokenEnc: tokens.refreshToken ? encryptJson(tokens.refreshToken) : undefined,
            expiresAt: tokens.expiresInSec ? new Date(Date.now() + tokens.expiresInSec * 1000) : null,
            scopes: tokens.scopes,
            tokenType: 'user',
            metadata: identity.metadata,
        }, tenantId, 'user');

        AuditService.logUserAction({
            eventType: 'connector.connected', severity: 'medium',
            apiRoute: `GET /api/connections/${provider}/callback`, httpMethod: 'GET',
            action: 'Connected Connector', resourceType: 'agent',
            resourceId: `${provider}-connection`, resourceName: `${provider}: ${identity.accountLabel}`,
            user: 'user', userType: 'user', status: 'success',
            details: `Connected ${provider} account ${identity.accountLabel}`, metadata: { tenantId },
        }).catch(() => {});

        const res = redirectPage(origin, provider, 'connected=1');
        res.cookies.delete('connector_oauth_nonce');
        return res;
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'oauth_failed';
        console.error(`[connectors/callback/${provider}]`, msg);
        return redirectPage(origin, provider, `error=${encodeURIComponent(msg)}`);
    }
}
