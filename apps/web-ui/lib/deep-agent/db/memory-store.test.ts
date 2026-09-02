import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCollection, mockGetDb } = vi.hoisted(() => ({
    mockCollection: {
        createIndex: vi.fn().mockResolvedValue(undefined),
        findOne: vi.fn(),
        updateOne: vi.fn(),
        deleteOne: vi.fn(),
        find: vi.fn(),
    },
    mockGetDb: vi.fn(),
}));

vi.mock('./mongo-client', () => ({ getDb: mockGetDb }));
vi.mock('../logger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { MongoStore, mongoStore } from './memory-store';

describe('MongoStore', () => {
    let store: MongoStore;

    beforeEach(() => {
        vi.clearAllMocks();
        mockCollection.createIndex.mockResolvedValue(undefined);
        mockGetDb.mockResolvedValue({ collection: vi.fn().mockReturnValue(mockCollection) });
        store = new MongoStore();
    });

    it('creates the unique index once, lazily, on first collection access', async () => {
        mockCollection.findOne.mockResolvedValue(null);
        await store.get(['ns'], 'k1');
        await store.get(['ns'], 'k2');
        expect(mockCollection.createIndex).toHaveBeenCalledTimes(1);
        expect(mockCollection.createIndex).toHaveBeenCalledWith({ namespace: 1, key: 1 }, { unique: true });
    });

    it('get returns null on a miss and the stored value on a hit', async () => {
        mockCollection.findOne.mockResolvedValueOnce(null);
        expect(await store.get(['a', 'b'], 'k')).toBeNull();

        mockCollection.findOne.mockResolvedValueOnce({ namespace: 'a::b', key: 'k', value: { x: 1 } });
        expect(await store.get(['a', 'b'], 'k')).toEqual({ x: 1 });
        expect(mockCollection.findOne).toHaveBeenLastCalledWith({ namespace: 'a::b', key: 'k' });
    });

    it('put upserts with $set/$setOnInsert and joins the namespace for storage', async () => {
        mockCollection.updateOne.mockResolvedValueOnce({ acknowledged: true });
        await store.put(['a', 'b'], 'k', { x: 1 });

        expect(mockCollection.updateOne).toHaveBeenCalledWith(
            { namespace: 'a::b', key: 'k' },
            expect.objectContaining({
                $set: expect.objectContaining({ value: { x: 1 } }),
                $setOnInsert: expect.objectContaining({ namespace: 'a::b', key: 'k' }),
            }),
            { upsert: true },
        );
    });

    it('put rethrows and logs when the underlying write fails', async () => {
        mockCollection.updateOne.mockRejectedValueOnce(new Error('duplicate key'));
        await expect(store.put(['a'], 'k', {})).rejects.toThrow('duplicate key');
    });

    it('delete removes the matching document', async () => {
        mockCollection.deleteOne.mockResolvedValueOnce({ deletedCount: 1 });
        await store.delete(['a'], 'k');
        expect(mockCollection.deleteOne).toHaveBeenCalledWith({ namespace: 'a', key: 'k' });
    });

    it('delete rethrows and logs when the underlying delete fails', async () => {
        mockCollection.deleteOne.mockRejectedValueOnce(new Error('conn lost'));
        await expect(store.delete(['a'], 'k')).rejects.toThrow('conn lost');
    });

    it('search returns key/value pairs for a namespace', async () => {
        mockCollection.find.mockReturnValueOnce({
            toArray: vi.fn().mockResolvedValue([
                { namespace: 'a', key: 'k1', value: { x: 1 } },
                { namespace: 'a', key: 'k2', value: { x: 2 } },
            ]),
        });
        const results = await store.search(['a']);
        expect(results).toEqual([{ key: 'k1', value: { x: 1 } }, { key: 'k2', value: { x: 2 } }]);
    });

    it('getMany fetches each key in parallel via get', async () => {
        mockCollection.findOne
            .mockResolvedValueOnce({ value: { x: 1 } })
            .mockResolvedValueOnce(null);
        const results = await store.getMany([
            { namespace: ['a'], key: 'k1' },
            { namespace: ['a'], key: 'k2' },
        ]);
        expect(results).toEqual([{ x: 1 }, null]);
    });

    it('putMany writes every item', async () => {
        mockCollection.updateOne.mockResolvedValue({ acknowledged: true });
        await store.putMany([
            { namespace: ['a'], key: 'k1', value: { x: 1 } },
            { namespace: ['a'], key: 'k2', value: { x: 2 } },
        ]);
        expect(mockCollection.updateOne).toHaveBeenCalledTimes(2);
    });

    it('deleteMany deletes every item', async () => {
        mockCollection.deleteOne.mockResolvedValue({ deletedCount: 1 });
        await store.deleteMany([{ namespace: ['a'], key: 'k1' }, { namespace: ['a'], key: 'k2' }]);
        expect(mockCollection.deleteOne).toHaveBeenCalledTimes(2);
    });

    it('list returns just the keys from search', async () => {
        mockCollection.find.mockReturnValueOnce({
            toArray: vi.fn().mockResolvedValue([{ namespace: 'a', key: 'k1', value: {} }]),
        });
        expect(await store.list(['a'])).toEqual(['k1']);
    });

    describe('batch', () => {
        it('dispatches a getOperation (key + namespace, no value)', async () => {
            mockCollection.findOne.mockResolvedValueOnce({ value: { x: 1 } });
            const [result] = await store.batch([{ namespace: ['a'], key: 'k1' }]);
            expect(result).toEqual({ x: 1 });
        });

        it('dispatches a searchOperation (namespacePrefix), shaping results with timestamps', async () => {
            mockCollection.find.mockReturnValueOnce({
                toArray: vi.fn().mockResolvedValue([{ namespace: 'a', key: 'k1', value: { x: 1 } }]),
            });
            const [results] = await store.batch([{ namespacePrefix: ['a'] }]);
            expect(results).toEqual([expect.objectContaining({ namespace: ['a'], key: 'k1', value: { x: 1 } })]);
        });

        it('dispatches a putOperation (value present) and returns null', async () => {
            mockCollection.updateOne.mockResolvedValueOnce({ acknowledged: true });
            const [result] = await store.batch([{ namespace: ['a'], key: 'k1', value: { x: 1 } }]);
            expect(result).toBeNull();
            expect(mockCollection.updateOne).toHaveBeenCalled();
        });

        it('dispatches a listNamespacesOperation (matchConditions)', async () => {
            const [result] = await store.batch([{ matchConditions: [{ match: ['a', 'b'] }] }]);
            expect(result).toEqual(['a:b']);
        });

        it('returns null for an unrecognized operation shape', async () => {
            const [result] = await store.batch([{ somethingElse: true }]);
            expect(result).toBeNull();
        });

        it('processes multiple mixed operations in order', async () => {
            mockCollection.findOne.mockResolvedValueOnce({ value: { x: 1 } });
            mockCollection.updateOne.mockResolvedValueOnce({ acknowledged: true });
            const results = await store.batch([
                { namespace: ['a'], key: 'k1' },
                { namespace: ['a'], key: 'k2', value: { y: 2 } },
            ]);
            expect(results).toEqual([{ x: 1 }, null]);
        });
    });

    it('exports a hot-reload-safe singleton instance', () => {
        expect(mongoStore).toBeInstanceOf(MongoStore);
    });
});
