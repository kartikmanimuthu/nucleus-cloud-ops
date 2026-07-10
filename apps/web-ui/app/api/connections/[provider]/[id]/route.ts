/**
 * Connector Connections — disconnect
 *
 * DELETE /api/connections/[provider]/[id] — remove a single OAuth connection.
 */
import { NextResponse } from 'next/server';
import { getConnectorRepository } from '@/lib/db/repository-factory';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import { authorize } from '@/lib/rbac/authorize';
import { AuditService } from '@/lib/audit-service';
import { isConnectorProvider } from '@/lib/connectors/providers';

type Ctx = { params: Promise<{ provider: string; id: string }> };

export async function DELETE(_req: Request, { params }: Ctx) {
    const { provider, id } = await params;
    if (!isConnectorProvider(provider)) return NextResponse.json({ success: false, error: 'Unknown provider' }, { status: 400 });
    const forbidden = await authorize('update', 'Agent'); if (forbidden) return forbidden;
    const tenantId = await getSessionTenantId();
    await getConnectorRepository().deleteConnection(id, tenantId);
    const session = await getAuthSession();
    AuditService.logUserAction({
        eventType: 'connector.disconnected', severity: 'medium',
        apiRoute: `DELETE /api/connections/${provider}/${id}`, httpMethod: 'DELETE',
        action: 'Disconnected Connector', resourceType: 'agent',
        resourceId: `${provider}-connection`, resourceName: `${provider} connection`,
        user: session?.user?.email || 'unknown', userType: 'user', status: 'success',
        details: `Disconnected ${provider} connection ${id}`, metadata: { tenantId },
    }).catch(() => {});
    return NextResponse.json({ success: true });
}
