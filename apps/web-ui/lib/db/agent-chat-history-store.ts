// ============================================================================
// Agent Chat History Store (MongoDB)
// Stores conversation threads and messages for the planning and fast agents.
// Uses collection "agent_threads" (separate from deep agent's "threads").
// ============================================================================

import { Collection } from 'mongodb';
import { getDb } from './mongo-client';

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
// Collection access
// ---------------------------------------------------------------------------

const COLLECTION = 'agent_threads';

async function getCollection(): Promise<Collection<AgentThread>> {
    const db = await getDb();
    return db.collection<AgentThread>(COLLECTION);
}

// ---------------------------------------------------------------------------
// Index management (lazy, one-time)
// ---------------------------------------------------------------------------

let indexesReady = false;

async function ensureIndexes(): Promise<void> {
    const col = await getCollection();
    await col.createIndex({ threadId: 1 }, { unique: true });
    await col.createIndex({ updatedAt: -1 });
}

async function withIndexes<T>(fn: () => Promise<T>): Promise<T> {
    if (!indexesReady) {
        await ensureIndexes();
        indexesReady = true;
    }
    return fn();
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
    return withIndexes(async () => {
        const col = await getCollection();
        const now = new Date().toISOString();
        const thread: AgentThread = {
            threadId,
            title,
            model,
            mode,
            messages: [],
            createdAt: now,
            updatedAt: now,
        };
        await col.insertOne(thread);
        return thread;
    });
}

export async function getThread(threadId: string): Promise<AgentThread | null> {
    return withIndexes(async () => {
        const col = await getCollection();
        const doc = await col.findOne({ threadId }, { projection: { _id: 0 } });
        return doc ?? null;
    });
}

export async function listThreads(
    limit = 50,
    skip = 0,
): Promise<Omit<AgentThread, 'messages'>[]> {
    return withIndexes(async () => {
        const col = await getCollection();
        const docs = await col
            .find({}, { projection: { _id: 0, messages: 0 } })
            .sort({ updatedAt: -1 })
            .skip(skip)
            .limit(limit)
            .toArray();
        return docs;
    });
}

export async function appendMessage(
    threadId: string,
    message: AgentMessage,
): Promise<void> {
    return withIndexes(async () => {
        const col = await getCollection();
        await col.updateOne(
            { threadId },
            {
                $push: { messages: message } as any,
                $set: { updatedAt: new Date().toISOString() },
            },
        );
    });
}

export async function updateThread(
    threadId: string,
    updates: Partial<Pick<AgentThread, 'title' | 'model' | 'updatedAt'>>,
): Promise<void> {
    return withIndexes(async () => {
        const col = await getCollection();
        await col.updateOne(
            { threadId },
            { $set: { ...updates, updatedAt: new Date().toISOString() } },
        );
    });
}

export async function deleteThread(threadId: string): Promise<boolean> {
    return withIndexes(async () => {
        const col = await getCollection();
        const result = await col.deleteOne({ threadId });
        return result.deletedCount > 0;
    });
}

export async function replaceMessages(
    threadId: string,
    messages: AgentMessage[],
): Promise<void> {
    return withIndexes(async () => {
        const col = await getCollection();
        await col.updateOne(
            { threadId },
            {
                $set: {
                    messages,
                    updatedAt: new Date().toISOString(),
                },
            },
        );
    });
}
