import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { ProviderModelService } from '@/lib/provider-model-service';

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    console.log(`API - PUT /api/settings/providers/${id} - Updating provider`);
    const authError = await authorize('update', 'Settings');
    if (authError) return authError;

    try {
        const tenantId = await getSessionTenantId();
        const body = await request.json();
        const updated = await ProviderModelService.updateProvider(id, tenantId, body);
        return NextResponse.json({ success: true, data: updated });
    } catch (error) {
        console.error('API - Error updating provider:', error);
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
        await ProviderModelService.deleteProvider(id, tenantId);
        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('API - Error deleting provider:', error);
        const message = error instanceof Error ? error.message : 'Failed to delete provider';
        return NextResponse.json({ success: false, error: message }, { status: message.includes('not found') ? 404 : 500 });
    }
}
