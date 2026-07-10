/**
 * app-credentials.ts
 *
 * Resolves the effective OAuth app credentials for a provider:
 *   1. the tenant's own ConnectorApp (bring-your-own), if fully configured;
 *   2. otherwise the platform-level OAuth app from env (one-click default).
 *
 * This is what makes Connect "one-click": with platform env creds set, a tenant
 * connects without registering their own OAuth app. A tenant that saves its own
 * ConnectorApp transparently overrides the platform app.
 */
import { env } from '@/env';
import { getConnectorRepository } from '@/lib/db/repository-factory';
import { decryptJson } from '@/lib/crypto/provider-credentials';
import type { ConnectorProvider } from '@/lib/db/repositories/connectors/interface';

export interface ResolvedAppCreds {
    clientId: string;
    clientSecret: string;
    signingSecret?: string;
    source: 'tenant' | 'platform';
}

const PLATFORM_ENV: Record<ConnectorProvider, { id: keyof typeof env; secret: keyof typeof env; signing?: keyof typeof env }> = {
    jira: { id: 'JIRA_OAUTH_CLIENT_ID', secret: 'JIRA_OAUTH_CLIENT_SECRET' },
    slack: { id: 'SLACK_OAUTH_CLIENT_ID', secret: 'SLACK_OAUTH_CLIENT_SECRET', signing: 'SLACK_SIGNING_SECRET' },
    google: { id: 'GOOGLE_OAUTH_CLIENT_ID', secret: 'GOOGLE_OAUTH_CLIENT_SECRET' },
};

/** True when platform-level OAuth app credentials are configured for a provider. */
export function hasPlatformApp(provider: ConnectorProvider): boolean {
    const map = PLATFORM_ENV[provider];
    return !!(env[map.id] && env[map.secret]);
}

function platformCreds(provider: ConnectorProvider): ResolvedAppCreds | null {
    const map = PLATFORM_ENV[provider];
    const clientId = env[map.id] as string | undefined;
    const clientSecret = env[map.secret] as string | undefined;
    if (!clientId || !clientSecret) return null;
    const signingSecret = map.signing ? (env[map.signing] as string | undefined) : undefined;
    return { clientId, clientSecret, signingSecret, source: 'platform' };
}

/**
 * Resolve the effective app credentials for (provider, tenant): tenant BYO app
 * first, else the platform app. Returns null when neither is configured.
 */
export async function resolveAppCredentials(provider: ConnectorProvider, tenantId: string): Promise<ResolvedAppCreds | null> {
    const app = await getConnectorRepository().getApp(provider, tenantId);
    if (app?.clientId && app.clientSecretEnc) {
        let clientSecret: string | null = null;
        try { clientSecret = decryptJson<string>(app.clientSecretEnc); } catch { clientSecret = null; }
        if (clientSecret) {
            let signingSecret: string | undefined;
            if (app.signingSecretEnc) {
                try { signingSecret = decryptJson<string>(app.signingSecretEnc); } catch { /* ignore */ }
            }
            // fall back to platform signing secret (env) when the tenant didn't set one
            if (!signingSecret) signingSecret = platformCreds(provider)?.signingSecret;
            return { clientId: app.clientId, clientSecret, signingSecret, source: 'tenant' };
        }
    }
    return platformCreds(provider);
}
