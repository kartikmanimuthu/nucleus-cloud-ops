import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { getSubagentRunRepository } from '@/lib/db/repository-factory';

export async function GET(
    _request: NextRequest,
    { params }: { params: Promise<{ threadId: string }> },
) {
    console.log('API - GET /api/chat/subagents/[threadId] - Fetching sub-agent runs');

    const authError = await authorize('read', 'Agent');
    if (authError) return authError;

    try {
        // getSessionTenantId throws on a missing session/tenant rather than returning
        // null, so catch it here — a signed-out caller must see 403, not 500.
        let tenantId: string | null = null;
        try {
            tenantId = await getSessionTenantId();
        } catch {
            tenantId = null;
        }
        if (!tenantId) {
            return NextResponse.json({ success: false, error: 'No tenant context' }, { status: 403 });
        }

        const { threadId } = await params;
        // listByThread goes through getTenantClient and AgentSubagentRun is in
        // TENANT_SCOPED_MODELS, so the query is tenant-scoped regardless of what
        // threadId the caller supplies.
        const runs = await getSubagentRunRepository().listByThread(tenantId, threadId);

        return NextResponse.json({ success: true, data: runs });
    } catch (error) {
        console.error('API - Error fetching sub-agent runs:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to fetch sub-agent runs' },
            { status: 500 },
        );
    }
}
