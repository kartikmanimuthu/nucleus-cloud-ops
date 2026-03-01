import { NextResponse } from 'next/server';

const useDynamo = !!process.env.DYNAMODB_AGENT_CONVERSATIONS_TABLE;

interface NormalizedThread {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    model?: string;
}

export async function GET() {
    try {
        if (useDynamo) {
            const { listThreads } = await import('@/lib/db/dynamodb-s3-chat-history-store');
            const mongoThreads = await listThreads(100, 0);
            // Normalize MongoDB threads to match expected format
            const normalized: NormalizedThread[] = mongoThreads.map((t: any) => ({
                id: t.threadId,
                title: t.title,
                createdAt: new Date(t.createdAt).getTime(),
                updatedAt: new Date(t.updatedAt).getTime(),
                model: t.model,
            }));
            return NextResponse.json(normalized);
        }

        const { threadStore } = await import('@/lib/store/thread-store');
        const threads = await threadStore.listThreads();
        return NextResponse.json(threads);
    } catch (error) {
        return NextResponse.json({ error: 'Failed to fetch threads' }, { status: 500 });
    }
}

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const { id, title, model } = body;

        if (!id) {
            return NextResponse.json({ error: 'Thread ID is required' }, { status: 400 });
        }

        if (useDynamo) {
            const { createThread } = await import('@/lib/db/dynamodb-s3-chat-history-store');
            const thread = await createThread(id, title || 'New Chat', model);
            // Normalize MongoDB thread to match expected format
            const normalized: NormalizedThread = {
                id: thread.threadId,
                title: thread.title,
                createdAt: new Date(thread.createdAt).getTime(),
                updatedAt: new Date(thread.updatedAt).getTime(),
                model: thread.model,
            };
            return NextResponse.json(normalized);
        }

        const { threadStore } = await import('@/lib/store/thread-store');
        const thread = await threadStore.createThread(id, title, model);
        return NextResponse.json(thread);
    } catch (error) {
        return NextResponse.json({ error: 'Failed to create thread' }, { status: 500 });
    }
}
