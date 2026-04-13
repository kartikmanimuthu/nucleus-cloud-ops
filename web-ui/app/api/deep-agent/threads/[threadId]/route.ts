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

        AuditService.logUserAction({
            action: 'Deleted Thread',
            resourceType: 'chat',
            resourceId: threadId,
            resourceName: threadId,
            user: 'unknown',
            userType: 'user',
            status: 'success',
            details: `Deleted deep agent thread ${threadId}`,
        }).catch(() => {});

        return NextResponse.json({ success: true });
    } catch (err: any) {
        console.error('[DeepAgent] Delete thread error:', err);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
