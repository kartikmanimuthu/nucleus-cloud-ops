import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import { ProviderModelService } from '@/lib/provider-model-service';
import { AuditService } from '@/lib/audit-service';

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    console.log(`API - PUT /api/settings/providers/${id} - Updating provider`);
    const authError = await authorize('update', 'Settings');
    if (authError) return authError;

    try {
        const tenantId = await getSessionTenantId();
        const session = await getAuthSession();
        const callerEmail = session?.user?.email ?? 'unknown';
        const body = await request.json();
        const updated = await ProviderModelService.updateProvider(id, tenantId, body);

        AuditService.logUserAction({
            eventType: 'integration.provider.updated',
            severity: 'high',
            apiRoute: 'PUT /api/settings/providers/[id]',
            httpMethod: 'PUT',
            action: 'Updated Provider',
            resourceType: 'integration',
            resourceId: id,
            resourceName: updated.name ?? id,
            user: callerEmail,
            userType: 'user',
            status: 'success',
            details: `Updated provider "${updated.name ?? id}"`,
            metadata: { tenantId },
        }).catch(() => {});

        return NextResponse.json({ success: true, data: updated });
    } catch (error) {
        console.error('API - Error updating provider:', error);

        AuditService.logUserAction({
            eventType: 'integration.provider.updated',
            severity: 'high',
            apiRoute: 'PUT /api/settings/providers/[id]',
            httpMethod: 'PUT',
            action: 'Updated Provider',
            resourceType: 'integration',
            resourceId: id,
            resourceName: id,
            user: 'unknown',
            userType: 'user',
            status: 'error',
            details: `Failed to update provider: ${error instanceof Error ? error.message : 'Unknown error'}`,
            metadata: {},
        }).catch(() => {});

        const message = error instanceof Error ? error.message : 'Failed to update provider';
        return NextResponse.json({ success: false, error: message }, { status: message.includes('not found') ? 404 : 500 });
    }
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    console.log(`API - DELETE /api/settings/providers/${id} - Deleting provider`);
    const authError = await authorize('update', 'Settings');
    if (authError) return authError;

    try {
        const tenantId = await getSessionTenantId();
        const session = await getAuthSession();
        const callerEmail = session?.user?.email ?? 'unknown';

        await ProviderModelService.deleteProvider(id, tenantId);

        AuditService.logUserAction({
            eventType: 'integration.provider.deleted',
            severity: 'high',
            apiRoute: 'DELETE /api/settings/providers/[id]',
            httpMethod: 'DELETE',
            action: 'Deleted Provider',
            resourceType: 'integration',
            resourceId: id,
            resourceName: id,
            user: callerEmail,
            userType: 'user',
            status: 'success',
            details: `Deleted provider "${id}"`,
            metadata: { tenantId },
        }).catch(() => {});

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('API - Error deleting provider:', error);

        AuditService.logUserAction({
            eventType: 'integration.provider.deleted',
            severity: 'high',
            apiRoute: 'DELETE /api/settings/providers/[id]',
            httpMethod: 'DELETE',
            action: 'Deleted Provider',
            resourceType: 'integration',
            resourceId: id,
            resourceName: id,
            user: 'unknown',
            userType: 'user',
            status: 'error',
            details: `Failed to delete provider: ${error instanceof Error ? error.message : 'Unknown error'}`,
            metadata: {},
        }).catch(() => {});

        const message = error instanceof Error ? error.message : 'Failed to delete provider';
        return NextResponse.json({ success: false, error: message }, { status: message.includes('not found') ? 404 : 500 });
    }
}
