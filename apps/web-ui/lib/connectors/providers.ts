/**
 * providers.ts
 *
 * Static registry describing each OAuth connector provider: consent + token
 * endpoints, requested scopes, and provider-specific authorize params. The
 * per-tenant client_id/secret come from ConnectorApp, not from here.
 */
import type { ConnectorProvider } from '@/lib/db/repositories/connectors/interface';

export interface ProviderConfig {
    id: ConnectorProvider;
    displayName: string;
    authorizeUrl: string;
    tokenUrl: string;
    scopes: string[];
    extraAuthorizeParams?: Record<string, string>;
}

export const PROVIDERS: Record<ConnectorProvider, ProviderConfig> = {
    jira: {
        id: 'jira',
        displayName: 'Jira',
        authorizeUrl: 'https://auth.atlassian.com/authorize',
        tokenUrl: 'https://auth.atlassian.com/oauth/token',
        scopes: ['read:jira-work', 'write:jira-work', 'read:jira-user', 'offline_access'],
        extraAuthorizeParams: { audience: 'api.atlassian.com', prompt: 'consent' },
    },
    slack: {
        id: 'slack',
        displayName: 'Slack',
        authorizeUrl: 'https://slack.com/oauth/v2/authorize',
        tokenUrl: 'https://slack.com/api/oauth.v2.access',
        // user-token scopes for "connect as you"; bot scopes handled by the install route
        scopes: ['channels:read', 'chat:write', 'users:read'],
    },
    google: {
        id: 'google',
        displayName: 'Google',
        authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        scopes: [
            'openid', 'email', 'profile',
            'https://www.googleapis.com/auth/gmail.readonly',
            'https://www.googleapis.com/auth/gmail.send',
            'https://www.googleapis.com/auth/calendar',
        ],
        extraAuthorizeParams: { access_type: 'offline', prompt: 'consent' },
    },
};

export function getProviderConfig(provider: string): ProviderConfig {
    const cfg = PROVIDERS[provider as ConnectorProvider];
    if (!cfg) throw new Error(`Unknown connector provider: ${provider}`);
    return cfg;
}

export function isConnectorProvider(p: string): p is ConnectorProvider {
    return p === 'jira' || p === 'slack' || p === 'google';
}
