/**
 * connection-service.ts
 *
 * Runtime accessor the gateway adapters use to get a usable OAuth token for the
 * tenant's active connection — transparently refreshing + persisting an expired
 * access token when a refresh token is available. Also exposes the Slack
 * workspace-bot token.
 */
import { getConnectorRepository } from '@/lib/db/repository-factory';
import { refreshAccessToken } from './token-exchange';
import { resolveAppCredentials } from './app-credentials';
import { encryptJson, decryptJson } from '@/lib/crypto/provider-credentials';
import type { ConnectorProvider } from '@/lib/db/repositories/connectors/interface';

const EXPIRY_SKEW_MS = 60_000;

export async function getUsableAccessToken(
    provider: ConnectorProvider, tenantId: string,
): Promise<{ accessToken: string; metadata: Record<string, unknown> } | null> {
    const repo = getConnectorRepository();
    const conn = await repo.getActiveConnection(provider, tenantId);
    if (!conn) return null;
    const metadata = (conn.metadata ?? {}) as Record<string, unknown>;
    const expired = conn.expiresAt ? conn.expiresAt.getTime() - EXPIRY_SKEW_MS < Date.now() : false;

    if (expired && conn.refreshTokenEnc) {
        const creds = await resolveAppCredentials(provider, tenantId);
        if (creds) {
            const refreshed = await refreshAccessToken(provider, creds, decryptJson<string>(conn.refreshTokenEnc));
            await repo.updateConnectionTokens(conn.id, tenantId, {
                accessTokenEnc: encryptJson(refreshed.accessToken),
                refreshTokenEnc: refreshed.refreshToken ? encryptJson(refreshed.refreshToken) : undefined,
                expiresAt: refreshed.expiresInSec ? new Date(Date.now() + refreshed.expiresInSec * 1000) : null,
                status: 'active',
            });
            return { accessToken: refreshed.accessToken, metadata };
        }
    }
    return { accessToken: decryptJson<string>(conn.accessTokenEnc), metadata };
}

export async function getBotToken(tenantId: string): Promise<string | null> {
    const app = await getConnectorRepository().getApp('slack', tenantId);
    if (!app?.botTokenEnc) return null;
    try { return decryptJson<string>(app.botTokenEnc); } catch { return null; }
}
