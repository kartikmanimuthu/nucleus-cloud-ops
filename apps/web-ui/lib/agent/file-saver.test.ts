/**
 * FileSaver persists LangGraph checkpoints/writes to real JSON files on disk (on
 * top of the in-memory MemorySaver base) so a dev-mode hot reload doesn't lose
 * in-flight threads. Uses a real temp DATA_DIR rather than mocking fs — the class
 * IS the filesystem-persistence layer, so exercising the real filesystem is the
 * simplest correct test.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import * as fsp from 'fs/promises';
import fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { emptyCheckpoint } from '@langchain/langgraph-checkpoint';

let DATA_DIR: string;
vi.mock('@/env', () => ({ env: new Proxy({}, { get: (_t, prop) => (prop === 'DATA_DIR' ? DATA_DIR : undefined) }) }));

let FileSaver: typeof import('./file-saver').FileSaver;

beforeAll(async () => {
    DATA_DIR = await fsp.mkdtemp(path.join(os.tmpdir(), 'file-saver-test-'));
    ({ FileSaver } = await import('./file-saver'));
});

afterAll(async () => {
    await fsp.rm(DATA_DIR, { recursive: true, force: true });
});

const checkpointPath = (threadId: string) => path.join(DATA_DIR, `checkpoint_${threadId}.json`);
const writesPath = (threadId: string) => path.join(DATA_DIR, `writes_${threadId}.json`);

const metadata = () => ({ source: 'update' as const, step: 1, parents: {} });

describe('FileSaver', () => {
    beforeEach(() => vi.restoreAllMocks());

    it('creates DATA_DIR on module load if it does not already exist', () => {
        expect(fs.existsSync(DATA_DIR)).toBe(true);
    });

    it('put() persists the checkpoint to a per-thread JSON file and still returns the base result', async () => {
        const saver = new FileSaver();
        const cp = { ...emptyCheckpoint(), id: 'cp-1' };
        const config = { configurable: { thread_id: 'thread-a' } };

        const result = await saver.put(config as any, cp as any, metadata());

        expect(result.configurable?.thread_id).toBe('thread-a');
        const onDisk = JSON.parse(fs.readFileSync(checkpointPath('thread-a'), 'utf-8'));
        expect(onDisk['cp-1'].checkpoint.id).toBe('cp-1');
    });

    it('put() merges into an existing checkpoint file rather than overwriting other entries', async () => {
        const saver = new FileSaver();
        const config = { configurable: { thread_id: 'thread-merge' } };
        await saver.put(config as any, { ...emptyCheckpoint(), id: 'cp-1' } as any, metadata());
        await saver.put(config as any, { ...emptyCheckpoint(), id: 'cp-2' } as any, metadata());

        const onDisk = JSON.parse(fs.readFileSync(checkpointPath('thread-merge'), 'utf-8'));
        expect(Object.keys(onDisk).sort()).toEqual(['cp-1', 'cp-2']);
    });

    it('put() tolerates a corrupted existing checkpoint file by starting fresh', async () => {
        fs.writeFileSync(checkpointPath('thread-corrupt'), '{not valid json');
        const saver = new FileSaver();
        const config = { configurable: { thread_id: 'thread-corrupt' } };

        await saver.put(config as any, { ...emptyCheckpoint(), id: 'cp-1' } as any, metadata());

        const onDisk = JSON.parse(fs.readFileSync(checkpointPath('thread-corrupt'), 'utf-8'));
        expect(Object.keys(onDisk)).toEqual(['cp-1']);
    });

    // FileSaver's own "no thread_id"/"no checkpoint_id" skip-persistence guards are
    // defense-in-depth only: MemorySaver.put()/putWrites() (called first, and now
    // stricter than when this class was written) already throw for the exact same
    // missing fields, so those branches are unreachable through the public API.

    it('putWrites() persists writes to a per-thread file when both thread_id and checkpoint_id are present', async () => {
        const saver = new FileSaver();
        const config = { configurable: { thread_id: 'thread-writes', checkpoint_ns: '', checkpoint_id: 'cp-1' } };

        await saver.putWrites(config as any, [['channel', 'value']], 'task-1');

        const onDisk = JSON.parse(fs.readFileSync(writesPath('thread-writes'), 'utf-8'));
        expect(onDisk).toEqual([{ checkpointId: 'cp-1', writes: [['channel', 'value']], taskId: 'task-1' }]);
    });

    it('putWrites() appends to an existing writes file', async () => {
        const saver = new FileSaver();
        const config = { configurable: { thread_id: 'thread-writes-append', checkpoint_ns: '', checkpoint_id: 'cp-1' } };
        await saver.putWrites(config as any, [['a', 1]], 'task-1');
        await saver.putWrites(config as any, [['b', 2]], 'task-2');

        const onDisk = JSON.parse(fs.readFileSync(writesPath('thread-writes-append'), 'utf-8'));
        expect(onDisk).toHaveLength(2);
    });

    it('putWrites() tolerates a corrupted existing writes file by starting fresh', async () => {
        fs.writeFileSync(writesPath('thread-writes-corrupt'), 'not json[[');
        const saver = new FileSaver();
        const config = { configurable: { thread_id: 'thread-writes-corrupt', checkpoint_ns: '', checkpoint_id: 'cp-1' } };

        await saver.putWrites(config as any, [['a', 1]], 'task-1');

        const onDisk = JSON.parse(fs.readFileSync(writesPath('thread-writes-corrupt'), 'utf-8'));
        expect(onDisk).toHaveLength(1);
    });

    it('getTuple() hydrates a persisted checkpoint from disk into the in-memory base on first call', async () => {
        const threadId = 'thread-hydrate';
        const config = { configurable: { thread_id: threadId } };
        const cp = { ...emptyCheckpoint(), id: 'cp-1' };

        // Persist via one saver instance...
        const writer = new FileSaver();
        await writer.put(config as any, cp as any, metadata());

        // ...then read it back via a FRESH instance with an empty in-memory base, proving hydration.
        const reader = new FileSaver();
        const tuple = await reader.getTuple(config as any);

        expect(tuple?.checkpoint.id).toBe('cp-1');
    });

    // BUG (found, not fixed — flagged for the report): hydrate()'s write-restoration
    // path calls `super.putWrites({ configurable: { thread_id, checkpoint_id } }, ...)`
    // without `checkpoint_ns`. The installed @langchain/langgraph-checkpoint's
    // MemorySaver.putWrites() now requires checkpoint_ns to be an explicit string
    // (throws "expected a string identifier (got undefined)" otherwise). hydrate()'s
    // own try/catch swallows that throw and only logs it, so persisted writes for a
    // thread are SILENTLY dropped on every hydration — never restored, never surfaced.
    it('hydrate() silently drops persisted writes on restore (documents a real defect, not fixed here)', async () => {
        const threadId = 'thread-hydrate-writes-bug';
        const config = { configurable: { thread_id: threadId } };
        const writer = new FileSaver();
        await writer.put(config as any, { ...emptyCheckpoint(), id: 'cp-1' } as any, metadata());
        await writer.putWrites({ configurable: { thread_id: threadId, checkpoint_ns: '', checkpoint_id: 'cp-1' } } as any, [['x', 1]], 'task-1');
        // The writes file IS on disk...
        expect(fs.existsSync(writesPath(threadId))).toBe(true);

        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const reader = new FileSaver();
        const tuple = await reader.getTuple(config as any);

        // ...but a fresh instance hydrating from it ends up with NO pending writes, and
        // the failure is only logged, never thrown or otherwise surfaced.
        expect(tuple?.checkpoint.id).toBe('cp-1');
        expect(tuple?.pendingWrites ?? []).toEqual([]);
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to hydrate writes'), expect.anything());
    });

    it('getTuple() only hydrates once per thread — a second call does not re-read a since-corrupted file', async () => {
        const threadId = 'thread-hydrate-once';
        const config = { configurable: { thread_id: threadId } };
        const saver = new FileSaver();
        await saver.put(config as any, { ...emptyCheckpoint(), id: 'cp-1' } as any, metadata());

        await saver.getTuple(config as any); // first call hydrates
        fs.writeFileSync(checkpointPath(threadId), 'corrupted after hydration');

        // A second getTuple must not attempt to re-parse the now-corrupted file.
        const errorSpy = vi.spyOn(console, 'error');
        const tuple = await saver.getTuple(config as any);
        expect(tuple?.checkpoint.id).toBe('cp-1');
        expect(errorSpy).not.toHaveBeenCalled();
    });

    it('getTuple() skips hydration and delegates straight through when the config has no thread_id', async () => {
        const saver = new FileSaver();
        const tuple = await saver.getTuple({ configurable: {} } as any);
        expect(tuple).toBeUndefined();
    });

    it('hydrate() logs and continues instead of throwing when the checkpoint file is corrupted', async () => {
        const threadId = 'thread-bad-checkpoint';
        fs.writeFileSync(checkpointPath(threadId), '{ not valid json');
        const saver = new FileSaver();
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const tuple = await saver.getTuple({ configurable: { thread_id: threadId } } as any);

        expect(tuple).toBeUndefined();
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to hydrate checkpoints'), expect.anything());
    });

    it('hydrate() logs and continues instead of throwing when the writes file is corrupted', async () => {
        const threadId = 'thread-bad-writes';
        const config = { configurable: { thread_id: threadId } };
        const saver = new FileSaver();
        await saver.put(config as any, { ...emptyCheckpoint(), id: 'cp-1' } as any, metadata());
        fs.writeFileSync(writesPath(threadId), '{ not valid json');

        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const fresh = new FileSaver();
        const tuple = await fresh.getTuple(config as any);

        expect(tuple?.checkpoint.id).toBe('cp-1');
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to hydrate writes'), expect.anything());
    });

    it('list() hydrates from disk and yields the persisted checkpoint', async () => {
        const threadId = 'thread-list';
        const config = { configurable: { thread_id: threadId } };
        const writer = new FileSaver();
        await writer.put(config as any, { ...emptyCheckpoint(), id: 'cp-1' } as any, metadata());

        const reader = new FileSaver();
        const results = [];
        for await (const tuple of reader.list(config as any)) results.push(tuple);

        expect(results.some(t => t.checkpoint.id === 'cp-1')).toBe(true);
    });

    it('list() skips hydration when the config has no thread_id', async () => {
        const saver = new FileSaver();
        const results = [];
        for await (const tuple of saver.list({ configurable: {} } as any)) results.push(tuple);
        expect(results).toEqual([]);
    });
});
