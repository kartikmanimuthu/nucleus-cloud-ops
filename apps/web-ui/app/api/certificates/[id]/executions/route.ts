import { NextRequest, NextResponse } from 'next/server';
import { getCertificateRepository } from '@/lib/db/repository-factory';
import { getSessionTenantId } from '@/lib/auth-session';
import { authorize } from '@/lib/rbac/authorize';

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const tenantId = await getSessionTenantId();
        const authError = await authorize('read', 'Certificate');
        if (authError) return authError;

        const { id } = await params;
        const { searchParams } = new URL(request.url);
        const limit = parseInt(searchParams.get('limit') || '50', 10);

        const repo = getCertificateRepository();
        const cert = await repo.getCertificate(tenantId, id);
        if (!cert) {
            return NextResponse.json({ success: false, error: 'Certificate not found' }, { status: 404 });
        }

        const executions = await repo.listExecutions(tenantId, id, limit);
        return NextResponse.json({ success: true, data: executions });
    } catch (error: unknown) {
        console.error('Error listing certificate executions:', error);
        const message = error instanceof Error ? error.message : 'Failed to list executions';
        return NextResponse.json({ success: false, error: message }, { status: 500 });
    }
}
