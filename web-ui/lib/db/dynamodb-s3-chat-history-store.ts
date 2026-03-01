// ============================================================================
// Agent Chat History Store (DynamoDB + S3)
// Stores conversation threads and messages for the planning and fast agents.
// Uses the existing `agent-conversations` DynamoDB table with S3 offloading
// for large message payloads (>100KB).
// ============================================================================

import {
    DynamoDBClient,
    PutItemCommand,
    GetItemCommand,
    DeleteItemCommand,
    QueryCommand,
    UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentMessage {
    id: string;
    role: 'user' | 'assistant' | 'tool';
    content: string;
    parts?: Array<{
        type: 'text' | 'tool-invocation';
        text?: string;
        toolCallId?: string;
        toolName?: string;
        args?: Record<string, unknown>;
        result?: string;
        state?: 'call' | 'result';
    }>;
    timestamp: string;
}

export interface AgentThread {
    threadId: string;
    title: string;
    model?: string;
    mode?: 'plan' | 'fast';
    messages: AgentMessage[];
    createdAt: string;
    updatedAt: string;
}

// ---------------------------------------------------------------------------
// Singleton clients (globalThis for Next.js hot-reload safety)
// ---------------------------------------------------------------------------

const globalForClients = globalThis as unknown as {
    _dynChatClient: DynamoDBClient | undefined;
    _s3ChatClient: S3Client | undefined;
};

function getRegion() {
    return process.env.AWS_REGION || process.env.NEXT_PUBLIC_AWS_REGION || 'us-east-1';
}

function getDynamoClient(): DynamoDBClient {
    if (!globalForClients._dynChatClient) {
        globalForClients._dynChatClient = new DynamoDBClient({ region: getRegion() });
    }
    return globalForClients._dynChatClient;
}

function getS3Client(): S3Client {
    if (!globalForClients._s3ChatClient) {
        globalForClients._s3ChatClient = new S3Client({ region: getRegion() });
    }
    return globalForClients._s3ChatClient;
}

function getTableName(): string {
    const table = process.env.DYNAMODB_AGENT_CONVERSATIONS_TABLE;
    if (!table) throw new Error('DYNAMODB_AGENT_CONVERSATIONS_TABLE is not set');
    return table;
}

function getS3Bucket(): string | undefined {
    return process.env.CHECKPOINT_S3_BUCKET;
}

// ---------------------------------------------------------------------------
// S3 offloading helpers
// ---------------------------------------------------------------------------

const S3_OFFLOAD_THRESHOLD = 100 * 1024; // 100KB

function isS3Ref(value: unknown): value is { __s3_ref__: { bucket: string; key: string } } {
    return value !== null && typeof value === 'object' && '__s3_ref__' in (value as object);
}

async function storeData(data: unknown, keySuffix: string): Promise<unknown> {
    const bucket = getS3Bucket();
    if (!bucket) return data;

    const jsonString = JSON.stringify(data);
    if (Buffer.byteLength(jsonString) > S3_OFFLOAD_THRESHOLD) {
        const key = `${keySuffix}.json`;
        await getS3Client().send(new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: jsonString,
            ContentType: 'application/json',
        }));
        return { __s3_ref__: { bucket, key } };
    }
    return data;
}

async function loadData(data: unknown): Promise<unknown> {
    if (isS3Ref(data)) {
        const { bucket, key } = data.__s3_ref__;
        const response = await getS3Client().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const bodyString = await response.Body?.transformToString();
        if (!bodyString) throw new Error(`Empty body from S3 for key: ${key}`);
        return JSON.parse(bodyString);
    }
    return data;
}

// ---------------------------------------------------------------------------
// CRUD Operations
// ---------------------------------------------------------------------------

export async function createThread(
    threadId: string,
    title: string,
    model?: string,
    mode?: 'plan' | 'fast',
): Promise<AgentThread> {
    const now = new Date().toISOString();
    const thread: AgentThread = { threadId, title, model, mode, messages: [], createdAt: now, updatedAt: now };

    await getDynamoClient().send(new PutItemCommand({
        TableName: getTableName(),
        Item: marshall({
            pk: `THREAD#${threadId}`,
            sk: 'META',
            gsi1pk: 'THREADS',
            gsi1sk: `${now}#${threadId}`,
            threadId,
            title,
            model,
            mode,
            messages: [],
            createdAt: now,
            updatedAt: now,
        }, { removeUndefinedValues: true }),
    }));

    return thread;
}

export async function getThread(threadId: string): Promise<AgentThread | null> {
    const result = await getDynamoClient().send(new GetItemCommand({
        TableName: getTableName(),
        Key: marshall({ pk: `THREAD#${threadId}`, sk: 'META' }),
    }));

    if (!result.Item) return null;

    const item = unmarshall(result.Item);
    const messages = await loadData(item.messages) as AgentMessage[];
    return { ...item, messages } as AgentThread;
}

export async function listThreads(limit = 50, _skip = 0): Promise<Omit<AgentThread, 'messages'>[]> {
    const result = await getDynamoClient().send(new QueryCommand({
        TableName: getTableName(),
        IndexName: 'ThreadIdIndex',
        KeyConditionExpression: 'gsi1pk = :pk',
        ExpressionAttributeValues: marshall({ ':pk': 'THREADS' }),
        ScanIndexForward: false,
        Limit: limit,
        ProjectionExpression: 'threadId, title, model, #m, createdAt, updatedAt',
        ExpressionAttributeNames: { '#m': 'mode' },
    }));

    return (result.Items || []).map(item => {
        const { messages: _messages, ...rest } = unmarshall(item);
        return rest as Omit<AgentThread, 'messages'>;
    });
}

export async function appendMessage(threadId: string, message: AgentMessage): Promise<void> {
    const thread = await getThread(threadId);
    if (!thread) throw new Error(`Thread not found: ${threadId}`);

    const messages = [...thread.messages, message];
    const now = new Date().toISOString();
    const storedMessages = await storeData(messages, `chat-history/${threadId}/messages`);

    await getDynamoClient().send(new UpdateItemCommand({
        TableName: getTableName(),
        Key: marshall({ pk: `THREAD#${threadId}`, sk: 'META' }),
        UpdateExpression: 'SET messages = :msgs, updatedAt = :now, gsi1sk = :gsi1sk',
        ExpressionAttributeValues: marshall({
            ':msgs': storedMessages,
            ':now': now,
            ':gsi1sk': `${now}#${threadId}`,
        }),
    }));
}

export async function updateThread(
    threadId: string,
    updates: Partial<Pick<AgentThread, 'title' | 'model' | 'updatedAt'>>,
): Promise<void> {
    const now = new Date().toISOString();
    await getDynamoClient().send(new UpdateItemCommand({
        TableName: getTableName(),
        Key: marshall({ pk: `THREAD#${threadId}`, sk: 'META' }),
        UpdateExpression: 'SET title = :title, updatedAt = :now, gsi1sk = :gsi1sk',
        ExpressionAttributeValues: marshall({
            ':title': updates.title ?? '',
            ':now': now,
            ':gsi1sk': `${now}#${threadId}`,
        }),
    }));
}

export async function deleteThread(threadId: string): Promise<boolean> {
    const existing = await getDynamoClient().send(new GetItemCommand({
        TableName: getTableName(),
        Key: marshall({ pk: `THREAD#${threadId}`, sk: 'META' }),
    }));

    if (!existing.Item) return false;

    const item = unmarshall(existing.Item);
    if (isS3Ref(item.messages)) {
        const { bucket, key } = item.messages.__s3_ref__;
        await getS3Client().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    }

    await getDynamoClient().send(new DeleteItemCommand({
        TableName: getTableName(),
        Key: marshall({ pk: `THREAD#${threadId}`, sk: 'META' }),
    }));

    return true;
}

export async function replaceMessages(threadId: string, messages: AgentMessage[]): Promise<void> {
    const now = new Date().toISOString();
    const storedMessages = await storeData(messages, `chat-history/${threadId}/messages`);

    await getDynamoClient().send(new UpdateItemCommand({
        TableName: getTableName(),
        Key: marshall({ pk: `THREAD#${threadId}`, sk: 'META' }),
        UpdateExpression: 'SET messages = :msgs, updatedAt = :now, gsi1sk = :gsi1sk',
        ExpressionAttributeValues: marshall({
            ':msgs': storedMessages,
            ':now': now,
            ':gsi1sk': `${now}#${threadId}`,
        }),
    }));
}
