import { NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { getAuditLogRepository } from '@/lib/db/repository-factory';

export async function GET() {
    const authError = await authorize('read', 'AuditLog');
    if (authError) return authError;

    try {
        const tenantId = await getSessionTenantId();
        const repo = getAuditLogRepository();

        if (!repo.getDistinctFilterValues) {
            return NextResponse.json({ success: false, error: 'Not supported' }, { status: 501 });
        }

        const filters = await repo.getDistinctFilterValues(tenantId);

        return NextResponse.json({ success: true, data: filters });
    } catch (error: unknown) {
        console.error('API - Error fetching audit filter values:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to fetch filter values' },
            { status: 500 }
        );
    }
}
