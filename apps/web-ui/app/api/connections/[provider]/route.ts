/**
 * Connector Connections — list
 *
 * GET /api/connections/[provider] — list the tenant's OAuth connections for a
 * provider. Tokens are never included in the response.
 */
import { NextResponse } from 'next/server';
import { getConnectorRepository } from '@/lib/db/repository-factory';
import { getSessionTenantId } from '@/lib/auth-session';
import { authorize } from '@/lib/rbac/authorize';
import { isConnectorProvider } from '@/lib/connectors/providers';
import type { ConnectorProvider } from '@/lib/db/repositories/connectors/interface';

type Ctx = { params: Promise<{ provider: string }> };

export async function GET(_req: Request, { params }: Ctx) {
    const { provider } = await params;
    if (!isConnectorProvider(provider)) return NextResponse.json({ success: false, error: 'Unknown provider' }, { status: 400 });
    const forbidden = await authorize('read', 'Agent'); if (forbidden) return forbidden;
    const tenantId = await getSessionTenantId();
    const rows = await getConnectorRepository().listConnections(provider as ConnectorProvider, tenantId);
    return NextResponse.json({
        success: true,
        connections: rows.map(r => ({
            id: r.id, accountLabel: r.accountLabel, scopes: r.scopes, status: r.status,
            tokenType: r.tokenType, expiresAt: r.expiresAt, createdAt: r.createdAt,
        })),
    });
}
