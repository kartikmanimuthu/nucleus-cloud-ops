// ============================================================================
// Deep Agent Module — Thread Detail API
// GET    /api/deep-agent/threads/[threadId]  → get full thread
// DELETE /api/deep-agent/threads/[threadId]  → delete thread
// ============================================================================

import { NextRequest, NextResponse } from 'next/server';
import {
    getThread,
    deleteThread,
} from '../../../../../lib/deep-agent/db/chat-history-store';
import { AuditService } from '@/lib/audit-service';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import type { RouteAuthz } from '@nucleus/rbac';

/** Layer 1 permission declaration — see lib/rbac/rbac-allowlist.ts for the public set. */
export const authz: RouteAuthz = {
    GET: { action: 'read', subject: 'Agent' },
    DELETE: { action: 'delete', subject: 'Agent' },
};

export async function GET(
    _req: NextRequest,
    context: { params: Promise<{ threadId: string }> },
) {
    try {
        const { threadId } = await context.params;
        const thread = await getThread(threadId);
        if (!thread) {
            return NextResponse.json({ error: 'Thread not found' }, { status: 404 });
        }
        return NextResponse.json({ thread });
    } catch (err: any) {
        console.error('[DeepAgent] Get thread error:', err);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

export async function DELETE(
    _req: NextRequest,
    context: { params: Promise<{ threadId: string }> },
) {
    try {
        const { threadId } = await context.params;
        const deleted = await deleteThread(threadId);
        if (!deleted) {
            return NextResponse.json({ error: 'Thread not found' }, { status: 404 });
        }

        let tenantId = 'unknown';
        let userEmail = 'unknown';
        try {
            tenantId = await getSessionTenantId();
            const session = await getAuthSession();
            userEmail = session?.user?.email || 'unknown';
        } catch {}

        AuditService.logUserAction({
            action: 'chat.thread.deleted',
            eventType: 'chat.thread.deleted',
            severity: 'medium',
            apiRoute: 'DELETE /api/deep-agent/threads/[threadId]',
            httpMethod: 'DELETE',
            resourceType: 'Thread',
            resourceId: threadId,
            resourceName: threadId,
            user: userEmail,
            userType: 'user',
            status: 'success',
            details: `Deleted deep agent thread ${threadId}`,
            tenantId,
            metadata: { tenantId },
        }).catch(() => {});

        return NextResponse.json({ success: true });
    } catch (err: any) {
        console.error('[DeepAgent] Delete thread error:', err);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
