import { NextResponse } from 'next/server';
import { getChatHistory } from '@/lib/agent/persistence';
import { getSessionUserId } from '@/lib/auth-session';

interface NormalizedThread {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    model?: string;
}

export async function GET() {
    try {
        if (process.env.DYNAMODB_CHAT_HISTORY_TABLE) {
            let userId: string;
            try { userId = await getSessionUserId(); } catch {
                return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
            }
            const chatHistory = await getChatHistory();
            const sessions = await chatHistory.listSessions(userId, 100);
            const normalized: NormalizedThread[] = sessions.map((s) => ({
                id: s.sessionId,
                title: s.title,
                createdAt: s.createdAt,
                updatedAt: s.updatedAt,
            }));
            return NextResponse.json(normalized);
        }

        const { threadStore } = await import('@/lib/store/thread-store');
        return NextResponse.json(await threadStore.listThreads());
    } catch (error) {
        return NextResponse.json({ error: 'Failed to fetch threads' }, { status: 500 });
    }
}

export async function POST(req: Request) {
    try {
        const { id, title, model } = await req.json();
        if (!id) return NextResponse.json({ error: 'Thread ID is required' }, { status: 400 });

        if (process.env.DYNAMODB_CHAT_HISTORY_TABLE) {
            let userId: string;
            try { userId = await getSessionUserId(); } catch {
                return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
            }
            // Seed metadata only — no empty HumanMessage
            const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
            const { DynamoDBDocument } = await import('@aws-sdk/lib-dynamodb');
            const region = process.env.AWS_REGION || process.env.NEXT_PUBLIC_AWS_REGION || 'us-east-1';
            const ddbDoc = DynamoDBDocument.from(new DynamoDBClient({ region }));
            const now = Date.now();
            await ddbDoc.update({
                TableName: process.env.DYNAMODB_CHAT_HISTORY_TABLE,
                Key: { userId, sessionId: id },
                UpdateExpression: 'SET title = if_not_exists(title, :t), createdAt = if_not_exists(createdAt, :c), updatedAt = :u, messageCount = if_not_exists(messageCount, :zero)',
                ExpressionAttributeValues: { ':t': title || 'New Chat', ':c': now, ':u': now, ':zero': 0 },
            });
            const normalized: NormalizedThread = {
                id,
                title: title || 'New Chat',
                createdAt: now,
                updatedAt: now,
                model,
            };
            return NextResponse.json(normalized);
        }

        const { threadStore } = await import('@/lib/store/thread-store');
        return NextResponse.json(await threadStore.createThread(id, title, model));
    } catch (error) {
        return NextResponse.json({ error: 'Failed to create thread' }, { status: 500 });
    }
}
