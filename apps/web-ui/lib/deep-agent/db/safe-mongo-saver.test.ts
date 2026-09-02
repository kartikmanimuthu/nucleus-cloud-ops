import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetTuple, mockPut, mockPutWrites, listItems } = vi.hoisted(() => ({
    mockGetTuple: vi.fn(),
    mockPut: vi.fn(),
    mockPutWrites: vi.fn(),
    listItems: { value: [] as any[] },
}));

// Real MongoDBSaver requires a live MongoClient — stub the base class with a
// controllable prototype so SafeMongoDBSaver's `super.x()` delegation and its
// own putWrites guard can both be exercised hermetically.
vi.mock('@langchain/langgraph-checkpoint-mongodb', () => {
    class MongoDBSaver {
        options: any;
        constructor(options: any) { this.options = options; }
        async getTuple(config: any) { return mockGetTuple(config); }
        async *list(config: any, options?: any) {
            for (const item of listItems.value) yield item;
        }
        async put(config: any, checkpoint: any, metadata: any) { return mockPut(config, checkpoint, metadata); }
        async putWrites(config: any, writes: any, taskId: any) { return mockPutWrites(config, writes, taskId); }
    }
    return { MongoDBSaver };
});

import { SafeMongoDBSaver } from './safe-mongo-saver';

const CONFIG = { configurable: { thread_id: 't1' } };

describe('SafeMongoDBSaver', () => {
    let saver: SafeMongoDBSaver;

    beforeEach(() => {
        vi.clearAllMocks();
        listItems.value = [];
        saver = new SafeMongoDBSaver({ client: {} as any, dbName: 'nucleus' });
    });

    it('constructs, passing options through to the base class', () => {
        expect((saver as any).options).toEqual({ client: {}, dbName: 'nucleus' });
    });

    it('getTuple delegates to the base class and returns its result', async () => {
        mockGetTuple.mockResolvedValueOnce({ checkpoint: { id: 'c1' } });
        const result = await saver.getTuple(CONFIG as any);
        expect(mockGetTuple).toHaveBeenCalledWith(CONFIG);
        expect(result).toEqual({ checkpoint: { id: 'c1' } });
    });

    it('getTuple handles a miss (undefined) without throwing', async () => {
        mockGetTuple.mockResolvedValueOnce(undefined);
        expect(await saver.getTuple(CONFIG as any)).toBeUndefined();
    });

    it('list re-yields every checkpoint tuple from the base class', async () => {
        listItems.value = [{ checkpoint: { id: 'c1' } }, { checkpoint: { id: 'c2' } }];
        const results = [];
        for await (const cp of saver.list(CONFIG as any)) results.push(cp);
        expect(results).toEqual([{ checkpoint: { id: 'c1' } }, { checkpoint: { id: 'c2' } }]);
    });

    it('list yields nothing for an empty checkpoint history', async () => {
        const results = [];
        for await (const cp of saver.list(CONFIG as any)) results.push(cp);
        expect(results).toEqual([]);
    });

    it('put delegates to the base class and returns its result', async () => {
        mockPut.mockResolvedValueOnce({ configurable: { thread_id: 't1', checkpoint_id: 'c1' } });
        const checkpoint = { id: 'c1', ts: 'now' } as any;
        const metadata = { step: 1 } as any;
        const result = await saver.put(CONFIG as any, checkpoint, metadata);

        expect(mockPut).toHaveBeenCalledWith(CONFIG, checkpoint, metadata);
        expect(result).toEqual({ configurable: { thread_id: 't1', checkpoint_id: 'c1' } });
    });

    it('putWrites skips the base call entirely when writes is empty', async () => {
        await saver.putWrites(CONFIG as any, [], 'task-1');
        expect(mockPutWrites).not.toHaveBeenCalled();
    });

    it('putWrites skips the base call when writes is undefined/null', async () => {
        await saver.putWrites(CONFIG as any, undefined as any, 'task-1');
        expect(mockPutWrites).not.toHaveBeenCalled();
    });

    it('putWrites delegates to the base class when writes is non-empty', async () => {
        const writes = [['channel', { x: 1 }]] as any;
        mockPutWrites.mockResolvedValueOnce(undefined);
        await saver.putWrites(CONFIG as any, writes, 'task-1');
        expect(mockPutWrites).toHaveBeenCalledWith(CONFIG, writes, 'task-1');
    });

    it('putWrites propagates an error from the base class', async () => {
        const writes = [['channel', { x: 1 }]] as any;
        mockPutWrites.mockRejectedValueOnce(new Error('bulkWrite failed'));
        await expect(saver.putWrites(CONFIG as any, writes, 'task-1')).rejects.toThrow('bulkWrite failed');
    });
});
