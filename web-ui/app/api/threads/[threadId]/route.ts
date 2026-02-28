import { NextResponse } from 'next/server';

const useMongo = !!process.env.MONGODB_URI;

interface NormalizedThread {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    model?: string;
}

export async function DELETE(
    req: Request,
    { params }: { params: Promise<{ threadId: string }> }
) {
    try {
        const { threadId } = await params;

        if (useMongo) {
            const { deleteThread } = await import('@/lib/db/agent-chat-history-store');
            const success = await deleteThread(threadId);
            if (!success) {
                return NextResponse.json({ error: 'Thread not found' }, { status: 404 });
            }
            return NextResponse.json({ success: true });
        }

        const { threadStore } = await import('@/lib/store/thread-store');
        const success = await threadStore.deleteThread(threadId);
        if (!success) {
            return NextResponse.json({ error: 'Thread not found' }, { status: 404 });
        }
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
        const body = await req.json();
        const { title } = body;

        if (useMongo) {
            const { updateThread, getThread } = await import('@/lib/db/agent-chat-history-store');
            await updateThread(threadId, { title });
            const updated = await getThread(threadId);
            if (!updated) {
                return NextResponse.json({ error: 'Thread not found' }, { status: 404 });
            }
            // Normalize MongoDB thread to match expected format
            const normalized: NormalizedThread = {
                id: updated.threadId,
                title: updated.title,
                createdAt: new Date(updated.createdAt).getTime(),
                updatedAt: new Date(updated.updatedAt).getTime(),
                model: updated.model,
            };
            return NextResponse.json(normalized);
        }

        const { threadStore } = await import('@/lib/store/thread-store');
        const updated = await threadStore.updateThread(threadId, { title });
        if (!updated) {
            return NextResponse.json({ error: 'Thread not found' }, { status: 404 });
        }
        return NextResponse.json(updated);
    } catch (error) {
        return NextResponse.json({ error: 'Failed to update thread' }, { status: 500 });
    }
}
