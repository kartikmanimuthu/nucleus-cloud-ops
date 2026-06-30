import { NextRequest, NextResponse } from 'next/server';
import { getAgentMemoryRepository } from '@/lib/db/repository-factory';
import { getSessionTenantId } from '@/lib/auth-session';
import { authorize } from '@/lib/rbac/authorize';
import { AuditService } from '@/lib/audit-service';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const tenantId = await getSessionTenantId();
        const authError = await authorize('read', 'Memory');
        if (authError) return authError;

        const { id } = await params;
        const repo = getAgentMemoryRepository();
        const memory = await repo.getById(tenantId, id);
        if (!memory) {
            return NextResponse.json({ success: false, error: 'Memory not found' }, { status: 404 });
        }
        return NextResponse.json({ success: true, data: memory });
    } catch (error: unknown) {
        console.error('API - Error fetching agent memory:', error);
        const message = error instanceof Error ? error.message : 'Failed to fetch memory';
        return NextResponse.json({ success: false, error: message }, { status: 500 });
    }
}

export async function DELETE(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const tenantId = await getSessionTenantId();
        const authError = await authorize('delete', 'Memory');
        if (authError) return authError;

        const { id } = await params;
        const repo = getAgentMemoryRepository();
        const memory = await repo.getById(tenantId, id);
        if (!memory) {
            return NextResponse.json({ success: false, error: 'Memory not found' }, { status: 404 });
        }

        const session = await getServerSession(authOptions);
        const deletedBy = session?.user?.email || 'unknown';

        await repo.deleteById(tenantId, id);

        await AuditService.logUserAction({
            action: 'delete',
            resourceType: 'agent_memory',
            resourceId: id,
            resourceName: memory.key,
            user: deletedBy,
            userType: 'user',
            status: 'success',
            details: `Agent memory "${memory.key}" (${memory.namespace}) deleted`,
            tenantId,
        });

        return NextResponse.json({ success: true });
    } catch (error: unknown) {
        console.error('API - Error deleting agent memory:', error);
        const message = error instanceof Error ? error.message : 'Failed to delete memory';
        return NextResponse.json({ success: false, error: message }, { status: 500 });
    }
}
