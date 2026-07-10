/**
 * token-exchange.ts
 *
 * OAuth authorization-code exchange, refresh, and identity resolution for each
 * connector provider. The per-tenant client secret is decrypted from the
 * ConnectorApp record inside these functions and never leaves this module.
 */
import { getProviderConfig } from './providers';
import { decryptJson } from '@/lib/crypto/provider-credentials';
import type { ConnectorProvider, ConnectorAppRecord } from '@/lib/db/repositories/connectors/interface';

export interface TokenResult { accessToken: string; refreshToken?: string; expiresInSec?: number; scopes: string[]; }
export interface Identity { accountLabel: string; externalAccountId: string; metadata: Record<string, unknown>; }

function clientSecret(app: Pick<ConnectorAppRecord, 'clientSecretEnc'>): string {
    return decryptJson<string>(app.clientSecretEnc);
}

function parseScopes(scope: unknown): string[] {
    if (typeof scope === 'string') return scope.split(/[ ,]+/).filter(Boolean);
    if (Array.isArray(scope)) return scope as string[];
    return [];
}

export async function exchangeCode(
    provider: ConnectorProvider, app: ConnectorAppRecord, code: string, redirectUri: string,
): Promise<TokenResult> {
    const cfg = getProviderConfig(provider);
    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: app.clientId,
        client_secret: clientSecret(app),
    });
    const res = await fetch(cfg.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body,
    });
    const json: any = await res.json();
    if (!res.ok || json.error || json.ok === false) {
        throw new Error(`Token exchange failed: ${json.error || json.error_description || res.status}`);
    }
    // Slack nests the user token under authed_user
    if (provider === 'slack' && json.authed_user?.access_token) {
        return { accessToken: json.authed_user.access_token, scopes: parseScopes(json.authed_user.scope) };
    }
    return {
        accessToken: json.access_token,
        refreshToken: json.refresh_token,
        expiresInSec: json.expires_in,
        scopes: parseScopes(json.scope),
    };
}

export async function refreshAccessToken(
    provider: ConnectorProvider, app: ConnectorAppRecord, refreshToken: string,
): Promise<TokenResult> {
    const cfg = getProviderConfig(provider);
    const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: app.clientId,
        client_secret: clientSecret(app),
    });
    const res = await fetch(cfg.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body,
    });
    const json: any = await res.json();
    if (!res.ok || json.error) throw new Error(`Token refresh failed: ${json.error || res.status}`);
    return {
        accessToken: json.access_token,
        refreshToken: json.refresh_token ?? refreshToken,
        expiresInSec: json.expires_in,
        scopes: parseScopes(json.scope),
    };
}

export interface SlackBotResult { botToken: string; teamName: string; teamId: string; botUserId: string; scopes: string[]; }

/** Exchanges a Slack workspace-install code for a bot token via oauth.v2.access. */
export async function exchangeSlackBot(app: ConnectorAppRecord, code: string, redirectUri: string): Promise<SlackBotResult> {
    const body = new URLSearchParams({
        grant_type: 'authorization_code', code, redirect_uri: redirectUri,
        client_id: app.clientId, client_secret: clientSecret(app),
    });
    const res = await fetch('https://slack.com/api/oauth.v2.access', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
    });
    const json: any = await res.json();
    if (!json.ok) throw new Error(`Slack bot install failed: ${json.error}`);
    return {
        botToken: json.access_token, teamName: json.team?.name ?? 'workspace', teamId: json.team?.id ?? '',
        botUserId: json.bot_user_id ?? '', scopes: parseScopes(json.scope),
    };
}

export async function fetchIdentity(provider: ConnectorProvider, accessToken: string): Promise<Identity> {
    if (provider === 'jira') {
        const res = await fetch('https://api.atlassian.com/oauth/token/accessible-resources', {
            headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
        });
        const sites: any[] = await res.json();
        const site = sites?.[0];
        if (!site) throw new Error('No accessible Jira sites for this grant');
        return {
            accountLabel: site.name || site.url,
            externalAccountId: site.id,
            metadata: { cloudId: site.id, siteUrl: site.url, apiBaseUrl: `https://api.atlassian.com/ex/jira/${site.id}` },
        };
    }
    if (provider === 'google') {
        const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
            headers: { Authorization: `Bearer ${accessToken}` },
        });
        const info: any = await res.json();
        return { accountLabel: info.email || info.sub, externalAccountId: info.sub, metadata: { email: info.email } };
    }
    // slack: auth.test returns team + user identity
    const res = await fetch('https://slack.com/api/auth.test', {
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    const info: any = await res.json();
    if (!info.ok) throw new Error(`Slack auth.test failed: ${info.error}`);
    return { accountLabel: `${info.team} / ${info.user}`, externalAccountId: info.user_id, metadata: { teamId: info.team_id, team: info.team } };
}
