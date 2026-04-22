import { NextResponse } from 'next/server';
import { AuditService } from '@/lib/audit-service';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';

interface NormalizedThread {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    model?: string;
}

export async function DELETE(
    _req: Request,
    { params }: { params: Promise<{ threadId: string }> }
) {
    try {
        const { threadId } = await params;

        const { threadStore } = await import('@/lib/store/thread-store');
        const success = await threadStore.deleteThread(threadId);
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
            user: 'unknown',
            userType: 'user',
            status: 'success',
            details: `Deleted chat thread ${threadId}`,
            tenantId: await getSessionTenantId().catch(() => 'unknown'),
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

        const { threadStore } = await import('@/lib/store/thread-store');
        const updated = await threadStore.updateThread(threadId, { title });
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
            user: 'unknown',
            userType: 'user',
            status: 'success',
            details: `Updated chat thread ${threadId}`,
            tenantId: await getSessionTenantId().catch(() => 'unknown'),
        }).catch(() => {});

        return NextResponse.json(updated);
    } catch (error) {
        return NextResponse.json({ error: 'Failed to update thread' }, { status: 500 });
    }
}
