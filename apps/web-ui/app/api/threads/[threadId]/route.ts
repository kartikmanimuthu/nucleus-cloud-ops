import { NextResponse } from 'next/server';
import { AuditService } from '@/lib/audit-service';
import { getSessionTenantId, getSessionUserId } from '@/lib/auth-session';

interface NormalizedThread {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    model?: string;
}

/**
 * Resolve the caller's tenant/user and reject a threadId whose embedded tenant
 * segment (tenantId:userId:ts) belongs to a different tenant. Returns the
 * resolved identity, or a NextResponse to return early (401/403).
 */
async function resolveOwnership(threadId: string):
    Promise<{ tenantId: string; userId: string } | NextResponse> {
    let tenantId: string;
    let userId: string;
    try {
        tenantId = await getSessionTenantId();
        userId = await getSessionUserId();
    } catch {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (threadId.includes(':')) {
        const [embeddedTenantId] = threadId.split(':');
        if (embeddedTenantId !== tenantId) {
            return NextResponse.json({ error: 'Forbidden: thread belongs to another tenant' }, { status: 403 });
        }
    }
    return { tenantId, userId };
}

export async function DELETE(
    _req: Request,
    { params }: { params: Promise<{ threadId: string }> }
) {
    try {
        const { threadId } = await params;

        const owner = await resolveOwnership(threadId);
        if (owner instanceof NextResponse) return owner;
        const { tenantId, userId } = owner;

        const { threadStore } = await import('@/lib/store/thread-store');
        const success = await threadStore.deleteThread(threadId, tenantId);
        if (!success) return NextResponse.json({ error: 'Thread not found' }, { status: 404 });

        AuditService.logUserAction({
            eventType: 'chat.thread.deleted',
            severity: 'medium',
            apiRoute: 'DELETE /api/threads/[threadId]',
            httpMethod: 'DELETE',
            action: 'Deleted Thread',
            resourceType: 'chat',
            resourceId: threadId,
            resourceName: threadId,
            user: userId,
            userType: 'user',
            status: 'success',
            details: `Deleted chat thread ${threadId}`,
            tenantId,
        }).catch(() => {});

        return NextResponse.json({ success: true });
    } catch (error) {
        return NextResponse.json({ error: 'Failed to delete thread' }, { status: 500 });
    }
}

export async function PATCH(
    req: Request,
    { params }: { params: Promise<{ threadId: string }> }
) {
    try {
        const { threadId } = await params;
        const { title } = await req.json();

        const owner = await resolveOwnership(threadId);
        if (owner instanceof NextResponse) return owner;
        const { tenantId, userId } = owner;

        const { threadStore } = await import('@/lib/store/thread-store');
        const updated = await threadStore.updateThread(threadId, tenantId, { title });
        if (!updated) return NextResponse.json({ error: 'Thread not found' }, { status: 404 });

        AuditService.logUserAction({
            eventType: 'chat.thread.updated',
            severity: 'low',
            apiRoute: 'PATCH /api/threads/[threadId]',
            httpMethod: 'PATCH',
            action: 'Updated Thread',
            resourceType: 'chat',
            resourceId: threadId,
            resourceName: title || threadId,
            user: userId,
            userType: 'user',
            status: 'success',
            details: `Updated chat thread ${threadId}`,
            tenantId,
        }).catch(() => {});

        return NextResponse.json(updated);
    } catch (error) {
        return NextResponse.json({ error: 'Failed to update thread' }, { status: 500 });
    }
}
