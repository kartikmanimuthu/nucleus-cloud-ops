/**
 * Channel secret reveal — the "eye toggle" behind every channel settings form.
 *
 * ── WHY THIS IS ITS OWN ENDPOINT ────────────────────────────────────────────
 * It used to be a `?reveal=1` branch inside each channel's GET, guarded by an
 * in-handler `authorize('update', …)` while the rest of GET needed only `read`.
 * Two different permissions behind one method is exactly what rbac-sync refuses
 * to accept: it reads the first `authorize()` call in a handler as *the*
 * requirement for that method, so the reveal gate leaked outward and made simply
 * loading the Channels page demand write access — a read-only user saw every
 * channel as "Not configured" because all five status fetches 403'd.
 *
 * Declaring GET as `read` while the body still called `authorize('update', …)`
 * would trade that bug for a `rbac:sync --check` mismatch, and rightly so: a
 * declaration that disagrees with the guard beside it is a lie waiting to be
 * believed. So the two permissions get two endpoints. GET is `read` and always
 * masks; this route is `update` and never does anything else. Both are declared,
 * neither infers, and the checker has nothing to reconcile.
 *
 * One dynamic route serves all five channels rather than five near-identical
 * files. `:channel` is validated against REVEALABLE_CHANNELS below — an unknown
 * slug 404s and never reaches TenantConfigService.
 */

import { NextResponse } from 'next/server';

import { getAuthSession, getSessionTenantId } from '@/lib/auth-session';
import { AuditService } from '@/lib/audit-service';
import { TenantConfigService } from '@/lib/tenant-config-service';

interface RevealableChannel {
    /** TenantConfig key the credentials are stored under. */
    configKey: string;
    /** Display name, for the audit record. */
    name: string;
    /** Stable audit resource id, unchanged from the per-channel GET handlers. */
    resourceId: string;
    /**
     * Which stored fields are secret. Only these are returned — a config may hold
     * non-secret values (Jira's baseUrl, Discord's applicationId) that the GET
     * already returns in clear and that have no business widening this response.
     */
    secretFields: readonly string[];
}

export const REVEALABLE_CHANNELS: Record<string, RevealableChannel> = {
    slack: {
        configKey: 'agent-ops-slack',
        name: 'Slack',
        resourceId: 'slack-integration',
        secretFields: ['signingSecret', 'botToken'],
    },
    telegram: {
        configKey: 'agent-ops-telegram',
        name: 'Telegram',
        resourceId: 'telegram-integration',
        secretFields: ['botToken', 'secretToken'],
    },
    discord: {
        configKey: 'agent-ops-discord',
        name: 'Discord',
        resourceId: 'discord-integration',
        secretFields: ['publicKey', 'botToken'],
    },
    jira: {
        configKey: 'agent-ops-jira',
        name: 'Jira',
        resourceId: 'jira-integration',
        secretFields: ['webhookSecret', 'apiToken'],
    },
    webhook: {
        configKey: 'agent-ops-webhook',
        name: 'Webhook',
        resourceId: 'webhook-integration',
        secretFields: ['webhookSecret'],
    },
};

/**
 * Returns the channel's plaintext secrets and writes the high-severity audit
 * record. The caller is responsible for the permission check — see the route.
 */
export async function revealChannelSecrets(channel: string): Promise<NextResponse> {
    const spec = REVEALABLE_CHANNELS[channel];
    if (!spec) {
        return NextResponse.json({ error: 'Unknown channel' }, { status: 404 });
    }

    const tenantId = await getSessionTenantId();
    const config = await TenantConfigService.getConfig<Record<string, unknown>>(spec.configKey, tenantId);

    if (!config) {
        return NextResponse.json({ configured: false }, { status: 404 });
    }

    const secrets: Record<string, string> = {};
    for (const field of spec.secretFields) {
        const value = config[field];
        secrets[field] = typeof value === 'string' ? value : '';
    }

    const session = await getAuthSession();
    AuditService.logUserAction({
        eventType: `agent.settings.${channel}_secret_reveal`,
        severity: 'high',
        apiRoute: `GET /api/agent-ops/settings/${channel}/reveal`,
        httpMethod: 'GET',
        action: 'channel_secret_reveal',
        resourceType: 'agent',
        resourceId: spec.resourceId,
        resourceName: `${spec.name} Integration`,
        user: session?.user?.email || 'unknown',
        userType: 'user',
        status: 'success',
        details: `Revealed plaintext ${spec.name} integration secrets`,
        metadata: { tenantId },
    }).catch(() => {});

    return NextResponse.json({ configured: true, ...secrets });
}
