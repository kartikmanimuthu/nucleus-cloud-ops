import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCollection, mockGetDb } = vi.hoisted(() => ({
    mockCollection: {
        createIndex: vi.fn().mockResolvedValue(undefined),
        insertOne: vi.fn(),
        findOne: vi.fn(),
        find: vi.fn(),
        updateOne: vi.fn(),
        deleteOne: vi.fn(),
    },
    mockGetDb: vi.fn(),
}));

vi.mock('./mongo-client', () => ({ getDb: mockGetDb }));

import {
    createThread, getThread, listThreads, appendMessage, updateThread, upsertTodos, deleteThread,
} from './chat-history-store';

describe('deep-agent chat-history-store', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockCollection.createIndex.mockResolvedValue(undefined);
        mockGetDb.mockResolvedValue({ collection: vi.fn().mockReturnValue(mockCollection) });
    });

    // Module-level `indexesReady` is only asserted here, first — it's a
    // process-lifetime flag (by design, to avoid re-creating indexes on every
    // call), so later tests in this file run with indexes already "ready".
    it('creates a new thread, ensuring indexes are set up on first use', async () => {
        mockCollection.insertOne.mockResolvedValueOnce({ acknowledged: true });
        const thread = await createThread('t1', 'My Thread', 'bedrock:claude');

        expect(mockCollection.createIndex).toHaveBeenCalledWith({ threadId: 1 }, { unique: true });
        expect(mockCollection.createIndex).toHaveBeenCalledWith({ updatedAt: -1 });
        expect(thread).toEqual(expect.objectContaining({
            threadId: 't1', title: 'My Thread', model: 'bedrock:claude', messages: [], todos: [],
        }));
        expect(mockCollection.insertOne).toHaveBeenCalledWith(thread);
    });

    it('does not re-create indexes on a subsequent call', async () => {
        mockCollection.insertOne.mockResolvedValueOnce({ acknowledged: true });
        await createThread('t2', 'Another', 'bedrock:claude');
        expect(mockCollection.createIndex).not.toHaveBeenCalled();
    });

    it('getThread returns the thread without the Mongo _id, or null on a miss', async () => {
        mockCollection.findOne.mockResolvedValueOnce({ threadId: 't1', title: 'x' });
        expect(await getThread('t1')).toEqual({ threadId: 't1', title: 'x' });
        expect(mockCollection.findOne).toHaveBeenCalledWith({ threadId: 't1' }, { projection: { _id: 0 } });

        mockCollection.findOne.mockResolvedValueOnce(null);
        expect(await getThread('missing')).toBeNull();
    });

    it('listThreads sorts by updatedAt desc and applies skip/limit, defaulting to 50/0', async () => {
        const chain = {
            sort: vi.fn().mockReturnThis(),
            skip: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            toArray: vi.fn().mockResolvedValue([{ threadId: 't1' }]),
        };
        mockCollection.find.mockReturnValueOnce(chain);

        const result = await listThreads();
        expect(mockCollection.find).toHaveBeenCalledWith({}, { projection: { _id: 0, messages: 0 } });
        expect(chain.sort).toHaveBeenCalledWith({ updatedAt: -1 });
        expect(chain.skip).toHaveBeenCalledWith(0);
        expect(chain.limit).toHaveBeenCalledWith(50);
        expect(result).toEqual([{ threadId: 't1' }]);
    });

    it('listThreads forwards a custom limit/skip', async () => {
        const chain = {
            sort: vi.fn().mockReturnThis(), skip: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(), toArray: vi.fn().mockResolvedValue([]),
        };
        mockCollection.find.mockReturnValueOnce(chain);
        await listThreads(10, 20);
        expect(chain.skip).toHaveBeenCalledWith(20);
        expect(chain.limit).toHaveBeenCalledWith(10);
    });

    it('appendMessage pushes onto messages and bumps updatedAt', async () => {
        mockCollection.updateOne.mockResolvedValueOnce({ acknowledged: true });
        const message = { id: 'm1', role: 'user', content: 'hi', timestamp: 'now' } as any;
        await appendMessage('t1', message);

        expect(mockCollection.updateOne).toHaveBeenCalledWith(
            { threadId: 't1' },
            expect.objectContaining({ $push: { messages: message }, $set: expect.objectContaining({ updatedAt: expect.any(String) }) }),
        );
    });

    it('updateThread merges partial fields and bumps updatedAt', async () => {
        mockCollection.updateOne.mockResolvedValueOnce({ acknowledged: true });
        await updateThread('t1', { title: 'Renamed' });

        expect(mockCollection.updateOne).toHaveBeenCalledWith(
            { threadId: 't1' },
            { $set: expect.objectContaining({ title: 'Renamed', updatedAt: expect.any(String) }) },
        );
    });

    it('upsertTodos replaces the todos array and bumps updatedAt', async () => {
        mockCollection.updateOne.mockResolvedValueOnce({ acknowledged: true });
        const todos = [{ id: '1', title: 'x', status: 'pending', createdAt: 'a', updatedAt: 'b' }] as any;
        await upsertTodos('t1', todos);

        expect(mockCollection.updateOne).toHaveBeenCalledWith(
            { threadId: 't1' },
            { $set: expect.objectContaining({ todos, updatedAt: expect.any(String) }) },
        );
    });

    it('deleteThread returns true when a document was deleted, false otherwise', async () => {
        mockCollection.deleteOne.mockResolvedValueOnce({ deletedCount: 1 });
        expect(await deleteThread('t1')).toBe(true);

        mockCollection.deleteOne.mockResolvedValueOnce({ deletedCount: 0 });
        expect(await deleteThread('missing')).toBe(false);
    });
});
