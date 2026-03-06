import { NextResponse } from 'next/server';
import { getSessionUserId } from '@/lib/auth-session';

interface NormalizedThread {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    model?: string;
    ownerUserId?: string;
}

export async function GET() {
    try {
        if (process.env.DYNAMODB_CHAT_HISTORY_TABLE) {
            try { await getSessionUserId(); } catch {
                return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
            }
            // Scan all users' session metadata to enable shared history across users
            const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
            const { DynamoDBDocument } = await import('@aws-sdk/lib-dynamodb');
            const region = process.env.AWS_REGION || process.env.NEXT_PUBLIC_AWS_REGION || 'us-east-1';
            const ddbDoc = DynamoDBDocument.from(new DynamoDBClient({ region }));
            // DynamoDB scan returns at most 1MB per call. The table may hold thousands of
            // message items so recent metadata records can fall beyond the first page.
            // We must paginate through ALL pages to guarantee every session is returned.
            const allItems: any[] = [];
            let lastEvaluatedKey: Record<string, any> | undefined = undefined;
            do {
                const page: any = await ddbDoc.scan({
                    TableName: process.env.DYNAMODB_CHAT_HISTORY_TABLE,
                    // attribute_exists(title) matches only session metadata rows.
                    // Message items stored by LangChain's DynamoDBChatMessageHistory
                    // do not carry a 'title' field, so they are excluded automatically.
                    FilterExpression: 'attribute_exists(title)',
                    ...(lastEvaluatedKey ? { ExclusiveStartKey: lastEvaluatedKey } : {}),
                });
                allItems.push(...(page.Items ?? []));
                lastEvaluatedKey = page.LastEvaluatedKey;
            } while (lastEvaluatedKey);

            const normalized: NormalizedThread[] = allItems
                .filter((item) => item.sessionId && item.userId)
                .map((item) => ({
                    id: item.sessionId,
                    title: item.title ?? 'Untitled',
                    createdAt: item.createdAt ?? 0,
                    updatedAt: item.updatedAt ?? 0,
                    ownerUserId: item.userId,
                }))
                .sort((a, b) => b.updatedAt - a.updatedAt)
                .slice(0, 20);
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
                UpdateExpression: 'SET title = if_not_exists(title, :t), createdAt = if_not_exists(createdAt, :c), updatedAt = :u, itemType = if_not_exists(itemType, :it), messageCount = if_not_exists(messageCount, :zero)',
                ExpressionAttributeValues: { ':t': title || 'New Chat', ':c': now, ':u': now, ':it': 'metadata', ':zero': 0 },
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
