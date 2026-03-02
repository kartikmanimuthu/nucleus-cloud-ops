// ============================================================================
// Deep Agent Module — Threads API
// GET  /api/deep-agent/threads  → list all threads
// POST /api/deep-agent/threads  → create a new thread
// ============================================================================

import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import {
    listThreads,
    createThread,
} from '../../../../lib/deep-agent/db/chat-history-store';

export async function GET(req: NextRequest) {
    try {
        const { searchParams } = new URL(req.url);
        const limit = Math.min(parseInt(searchParams.get('limit') ?? '50', 10), 100);
        const skip = parseInt(searchParams.get('skip') ?? '0', 10);
        const threads = await listThreads(limit, skip);
        return NextResponse.json({ threads });
    } catch (err: any) {
        console.error('[DeepAgent] List threads error:', err);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const threadId = body.threadId || uuidv4();
        const thread = await createThread(
            threadId,
            body.title || 'New conversation',
            body.model || 'default',
        );
        return NextResponse.json({ thread }, { status: 201 });
    } catch (err: any) {
        console.error('[DeepAgent] Create thread error:', err);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
