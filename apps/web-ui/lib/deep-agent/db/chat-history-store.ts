// ============================================================================
// Deep Agent Module — Chat History Store (MongoDB)
// ============================================================================

import { Collection, ObjectId } from 'mongodb';
import { getDb } from './mongo-client';
import { DeepAgentThread, DeepAgentMessage, TodoItem } from '../types';

const COLLECTION = 'threads';

async function getCollection(): Promise<Collection<DeepAgentThread>> {
    const db = await getDb();
    return db.collection<DeepAgentThread>(COLLECTION);
}

async function ensureIndexes(): Promise<void> {
    const col = await getCollection();
    await col.createIndex({ threadId: 1 }, { unique: true });
    await col.createIndex({ updatedAt: -1 });
}

// Run index setup once
let indexesReady = false;
async function withIndexes<T>(fn: () => Promise<T>): Promise<T> {
    if (!indexesReady) {
        await ensureIndexes();
        indexesReady = true;
    }
    return fn();
}

export async function createThread(
    threadId: string,
    title: string,
    model: string,
): Promise<DeepAgentThread> {
    return withIndexes(async () => {
        const col = await getCollection();
        const now = new Date().toISOString();
        const thread: DeepAgentThread = {
            threadId,
            title,
            model,
            messages: [],
            todos: [],
            createdAt: now,
            updatedAt: now,
        };
        await col.insertOne(thread);
        return thread;
    });
}

export async function getThread(threadId: string): Promise<DeepAgentThread | null> {
    return withIndexes(async () => {
        const col = await getCollection();
        const doc = await col.findOne({ threadId }, { projection: { _id: 0 } });
        return doc ?? null;
    });
}

export async function listThreads(
    limit = 50,
    skip = 0,
): Promise<Omit<DeepAgentThread, 'messages'>[]> {
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
    message: DeepAgentMessage,
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
    updates: Partial<Pick<DeepAgentThread, 'title' | 'todos' | 'updatedAt'>>,
): Promise<void> {
    return withIndexes(async () => {
        const col = await getCollection();
        await col.updateOne(
            { threadId },
            { $set: { ...updates, updatedAt: new Date().toISOString() } },
        );
    });
}

export async function upsertTodos(
    threadId: string,
    todos: TodoItem[],
): Promise<void> {
    return withIndexes(async () => {
        const col = await getCollection();
        await col.updateOne(
            { threadId },
            { $set: { todos, updatedAt: new Date().toISOString() } },
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
