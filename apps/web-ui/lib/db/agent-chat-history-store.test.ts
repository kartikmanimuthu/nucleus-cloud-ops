import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
    mockInsertOne, mockFindOne, mockToArray, mockSort, mockSkip, mockLimit, mockFind,
    mockUpdateOne, mockDeleteOne, mockCreateIndex, mockCollectionFn, mockGetDb,
} = vi.hoisted(() => {
    const mockInsertOne = vi.fn().mockResolvedValue({});
    const mockFindOne = vi.fn().mockResolvedValue(null);
    const mockToArray = vi.fn().mockResolvedValue([]);
    const mockSort = vi.fn();
    const mockSkip = vi.fn();
    const mockLimit = vi.fn();
    const mockUpdateOne = vi.fn().mockResolvedValue({});
    const mockDeleteOne = vi.fn().mockResolvedValue({ deletedCount: 0 });
    const mockCreateIndex = vi.fn().mockResolvedValue('idx');
    const mockFind = vi.fn();
    const mockCollectionFn = vi.fn();
    const mockGetDb = vi.fn();
    return {
        mockInsertOne, mockFindOne, mockToArray, mockSort, mockSkip, mockLimit, mockFind,
        mockUpdateOne, mockDeleteOne, mockCreateIndex, mockCollectionFn, mockGetDb,
    };
});

vi.mock('./mongo-client', () => ({ getDb: mockGetDb }));

const cursor = { sort: mockSort, skip: mockSkip, limit: mockLimit, toArray: mockToArray };
mockSort.mockReturnValue(cursor);
mockSkip.mockReturnValue(cursor);
mockLimit.mockReturnValue(cursor);
mockFind.mockReturnValue(cursor);

const mockCollection = {
    insertOne: mockInsertOne, findOne: mockFindOne, find: mockFind,
    updateOne: mockUpdateOne, deleteOne: mockDeleteOne, createIndex: mockCreateIndex,
};
mockCollectionFn.mockReturnValue(mockCollection);
mockGetDb.mockResolvedValue({ collection: mockCollectionFn });

import {
    createThread, getThread, listThreads, appendMessage, updateThread, deleteThread, replaceMessages,
} from './agent-chat-history-store';

beforeEach(() => {
    vi.clearAllMocks();
    mockToArray.mockResolvedValue([]);
    mockFindOne.mockResolvedValue(null);
    mockInsertOne.mockResolvedValue({});
    mockUpdateOne.mockResolvedValue({});
    mockDeleteOne.mockResolvedValue({ deletedCount: 0 });
    mockCreateIndex.mockResolvedValue('idx');
    mockSort.mockReturnValue(cursor);
    mockSkip.mockReturnValue(cursor);
    mockLimit.mockReturnValue(cursor);
    mockFind.mockReturnValue(cursor);
    mockCollectionFn.mockReturnValue(mockCollection);
    mockGetDb.mockResolvedValue({ collection: mockCollectionFn });
});

// Placed first: `indexesReady` is a module-scoped flag that only ever flips
// false -> true once per process. This is the only test allowed to observe it false.
describe('lazy index creation', () => {
    it('creates the threadId-unique and updatedAt indexes on the first call only, ever', async () => {
        await getThread('t1');
        expect(mockCreateIndex).toHaveBeenCalledWith({ threadId: 1 }, { unique: true });
        expect(mockCreateIndex).toHaveBeenCalledWith({ updatedAt: -1 });
        expect(mockCreateIndex).toHaveBeenCalledTimes(2);

        mockCreateIndex.mockClear();
        await getThread('t2');
        expect(mockCreateIndex).not.toHaveBeenCalled();
    });
});

describe('createThread', () => {
    it('inserts a thread with empty messages and matching created/updated timestamps', async () => {
        const thread = await createThread('t1', 'My Thread', 'claude-sonnet-5', 'plan');

        expect(mockInsertOne).toHaveBeenCalledWith(expect.objectContaining({
            threadId: 't1', title: 'My Thread', model: 'claude-sonnet-5', mode: 'plan', messages: [],
        }));
        expect(thread.threadId).toBe('t1');
        expect(thread.createdAt).toBe(thread.updatedAt);
    });

    it('leaves model and mode undefined when not supplied', async () => {
        const thread = await createThread('t1', 'My Thread');
        expect(thread.model).toBeUndefined();
        expect(thread.mode).toBeUndefined();
    });
});

describe('getThread', () => {
    it('excludes the Mongo _id field via projection', async () => {
        await getThread('t1');
        expect(mockFindOne).toHaveBeenCalledWith({ threadId: 't1' }, { projection: { _id: 0 } });
    });

    it('returns null when no thread matches', async () => {
        mockFindOne.mockResolvedValue(null);
        expect(await getThread('missing')).toBeNull();
    });

    it('returns the thread document when found', async () => {
        const doc = { threadId: 't1', title: 'x', messages: [], createdAt: 'a', updatedAt: 'b' };
        mockFindOne.mockResolvedValue(doc);
        expect(await getThread('t1')).toEqual(doc);
    });
});

describe('listThreads', () => {
    it('excludes _id and messages, sorted newest-first', async () => {
        await listThreads();
        expect(mockFind).toHaveBeenCalledWith({}, { projection: { _id: 0, messages: 0 } });
        expect(mockSort).toHaveBeenCalledWith({ updatedAt: -1 });
    });

    it('defaults to limit 50, skip 0', async () => {
        await listThreads();
        expect(mockSkip).toHaveBeenCalledWith(0);
        expect(mockLimit).toHaveBeenCalledWith(50);
    });

    it('honors explicit limit and skip', async () => {
        await listThreads(10, 20);
        expect(mockSkip).toHaveBeenCalledWith(20);
        expect(mockLimit).toHaveBeenCalledWith(10);
    });

    it('returns the array of thread summaries', async () => {
        mockToArray.mockResolvedValue([{ threadId: 't1' }]);
        expect(await listThreads()).toEqual([{ threadId: 't1' }]);
    });
});

describe('appendMessage', () => {
    it('pushes the message and bumps updatedAt, scoped by threadId', async () => {
        const message = { id: 'm1', role: 'user' as const, content: 'hi', timestamp: '2026-01-01T00:00:00Z' };
        await appendMessage('t1', message);

        expect(mockUpdateOne).toHaveBeenCalledWith(
            { threadId: 't1' },
            { $push: { messages: message }, $set: { updatedAt: expect.any(String) } },
        );
    });
});

describe('updateThread', () => {
    it('merges the given updates and always refreshes updatedAt', async () => {
        await updateThread('t1', { title: 'Renamed' });
        const call = mockUpdateOne.mock.calls[0];
        expect(call[0]).toEqual({ threadId: 't1' });
        expect(call[1].$set).toMatchObject({ title: 'Renamed' });
        expect(call[1].$set.updatedAt).toEqual(expect.any(String));
    });

    it('lets an explicit updatedAt in updates be overwritten by the fresh timestamp', async () => {
        await updateThread('t1', { updatedAt: 'stale-value' });
        const { updatedAt } = mockUpdateOne.mock.calls[0][1].$set;
        expect(updatedAt).not.toBe('stale-value');
    });
});

describe('deleteThread', () => {
    it('returns true when a row was actually deleted', async () => {
        mockDeleteOne.mockResolvedValue({ deletedCount: 1 });
        expect(await deleteThread('t1')).toBe(true);
        expect(mockDeleteOne).toHaveBeenCalledWith({ threadId: 't1' });
    });

    it('returns false when nothing matched', async () => {
        mockDeleteOne.mockResolvedValue({ deletedCount: 0 });
        expect(await deleteThread('missing')).toBe(false);
    });
});

describe('replaceMessages', () => {
    it('overwrites the full messages array and bumps updatedAt', async () => {
        const messages = [{ id: 'm1', role: 'user' as const, content: 'hi', timestamp: '2026-01-01T00:00:00Z' }];
        await replaceMessages('t1', messages);

        expect(mockUpdateOne).toHaveBeenCalledWith(
            { threadId: 't1' },
            { $set: { messages, updatedAt: expect.any(String) } },
        );
    });
});
