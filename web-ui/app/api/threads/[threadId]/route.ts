import { NextResponse } from 'next/server';
import { getChatHistory } from '@/lib/agent/persistence';
import { getSessionUserId } from '@/lib/auth-session';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';

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

        if (process.env.DYNAMODB_CHAT_HISTORY_TABLE) {
            let userId: string;
            try { userId = await getSessionUserId(); } catch {
                return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
            }
            const chatHistory = await getChatHistory();
            await chatHistory.clear(userId, threadId);
            return NextResponse.json({ success: true });
        }

        const { threadStore } = await import('@/lib/store/thread-store');
        const success = await threadStore.deleteThread(threadId);
        if (!success) return NextResponse.json({ error: 'Thread not found' }, { status: 404 });
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

        if (process.env.DYNAMODB_CHAT_HISTORY_TABLE) {
            let userId: string;
            try { userId = await getSessionUserId(); } catch {
                return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
            }
            const region = process.env.AWS_REGION || 'us-east-1';
            const client = DynamoDBDocument.from(new DynamoDBClient({ region }));
            await client.update({
                TableName: process.env.DYNAMODB_CHAT_HISTORY_TABLE,
                Key: { userId, sessionId: threadId },
                UpdateExpression: 'SET #t = :t, updatedAt = :u',
                ExpressionAttributeNames: { '#t': 'title' },
                ExpressionAttributeValues: { ':t': title, ':u': Date.now() },
            });
            const normalized: NormalizedThread = {
                id: threadId,
                title,
                createdAt: Date.now(),
                updatedAt: Date.now(),
            };
            return NextResponse.json(normalized);
        }

        const { threadStore } = await import('@/lib/store/thread-store');
        const updated = await threadStore.updateThread(threadId, { title });
        if (!updated) return NextResponse.json({ error: 'Thread not found' }, { status: 404 });
        return NextResponse.json(updated);
    } catch (error) {
        return NextResponse.json({ error: 'Failed to update thread' }, { status: 500 });
    }
}
