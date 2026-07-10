/**
 * Connector App Credentials API
 *
 * GET    /api/connections/[provider]/app — masked app-credential status
 * PUT    /api/connections/[provider]/app — save encrypted client_id/secret (+ Slack signing)
 * DELETE /api/connections/[provider]/app — remove app credentials
 *
 * Bring-your-own OAuth app: the tenant enters its own provider OAuth app.
 * Secrets are AES-256-GCM encrypted at rest and never returned.
 */
import { NextResponse } from 'next/server';
import { getConnectorRepository } from '@/lib/db/repository-factory';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import { authorize } from '@/lib/rbac/authorize';
import { AuditService } from '@/lib/audit-service';
import { encryptJson, decryptJson } from '@/lib/crypto/provider-credentials';
import { isConnectorProvider } from '@/lib/connectors/providers';
import type { ConnectorProvider } from '@/lib/db/repositories/connectors/interface';

type Ctx = { params: Promise<{ provider: string }> };

function hint(enc: string | null): string | null {
    if (!enc) return null;
    try { const s = decryptJson<string>(enc); return s.length <= 8 ? '••••' : `${s.slice(0, 3)}…${s.slice(-4)}`; }
    catch { return '••••'; }
}

export async function GET(req: Request, { params }: Ctx) {
    const { provider } = await params;
    if (!isConnectorProvider(provider)) return NextResponse.json({ success: false, error: 'Unknown provider' }, { status: 400 });
    const forbidden = await authorize('read', 'Agent'); if (forbidden) return forbidden;
    const tenantId = await getSessionTenantId();
    const app = await getConnectorRepository().getApp(provider as ConnectorProvider, tenantId);
    const origin = new URL(req.url).origin;
    return NextResponse.json({
        success: true,
        provider,
        configured: !!app,
        status: app ? 'configured' : 'not_set',
        clientId: app?.clientId ?? '',
        clientSecretHint: hint(app?.clientSecretEnc ?? null),
        signingSecretConfigured: !!app?.signingSecretEnc,
        botConfigured: !!app?.botTokenEnc,
        botAccountLabel: app?.botAccountLabel ?? null,
        callbackUrl: `${origin}/api/connections/${provider}/callback`,
        slackInstallCallbackUrl: provider === 'slack' ? `${origin}/api/slack/install/callback` : undefined,
    });
}

export async function PUT(req: Request, { params }: Ctx) {
    const { provider } = await params;
    if (!isConnectorProvider(provider)) return NextResponse.json({ success: false, error: 'Unknown provider' }, { status: 400 });
    const forbidden = await authorize('update', 'Agent'); if (forbidden) return forbidden;
    const tenantId = await getSessionTenantId();
    const body = await req.json().catch(() => ({})) as { clientId?: string; clientSecret?: string; signingSecret?: string };
    if (!body.clientId?.trim()) return NextResponse.json({ success: false, error: 'clientId is required' }, { status: 400 });

    await getConnectorRepository().upsertApp({
        provider: provider as ConnectorProvider,
        clientId: body.clientId.trim(),
        clientSecretEnc: body.clientSecret?.trim() ? encryptJson(body.clientSecret.trim()) : undefined,
        signingSecretEnc: body.signingSecret?.trim() ? encryptJson(body.signingSecret.trim()) : undefined,
    }, tenantId, 'user');

    const session = await getAuthSession();
    AuditService.logUserAction({
        eventType: 'connector.app_updated', severity: 'medium',
        apiRoute: `PUT /api/connections/${provider}/app`, httpMethod: 'PUT',
        action: 'Updated Connector App Credentials', resourceType: 'agent',
        resourceId: `${provider}-app`, resourceName: `${provider} OAuth app`,
        user: session?.user?.email || 'unknown', userType: 'user', status: 'success',
        details: `Updated ${provider} OAuth app credentials`, metadata: { tenantId },
    }).catch(() => {});

    return NextResponse.json({ success: true, configured: true });
}

export async function DELETE(_req: Request, { params }: Ctx) {
    const { provider } = await params;
    if (!isConnectorProvider(provider)) return NextResponse.json({ success: false, error: 'Unknown provider' }, { status: 400 });
    const forbidden = await authorize('update', 'Agent'); if (forbidden) return forbidden;
    const tenantId = await getSessionTenantId();
    await getConnectorRepository().deleteApp(provider as ConnectorProvider, tenantId);
    return NextResponse.json({ success: true });
}
