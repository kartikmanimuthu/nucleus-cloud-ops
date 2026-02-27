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

export async function GET(
    _req: NextRequest,
    { params }: { params: { threadId: string } },
) {
    try {
        const thread = await getThread(params.threadId);
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
    { params }: { params: { threadId: string } },
) {
    try {
        const deleted = await deleteThread(params.threadId);
        if (!deleted) {
            return NextResponse.json({ error: 'Thread not found' }, { status: 404 });
        }
        return NextResponse.json({ success: true });
    } catch (err: any) {
        console.error('[DeepAgent] Delete thread error:', err);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
