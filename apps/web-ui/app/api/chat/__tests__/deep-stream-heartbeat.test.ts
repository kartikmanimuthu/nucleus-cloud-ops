import { describe, it, expect, vi, afterEach } from 'vitest';
import { processDeepStream } from '../deep-stream';

/**
 * The bug: deep mode emitted nothing while a sub-agent worked, CloudFront closed
 * the idle origin connection at 60s (originReadTimeout), and the run died with
 * "This operation was aborted". These assert the keep-alive that prevents it.
 */

const never = <T>(): Promise<T> => new Promise<T>(() => { });
async function* empty() { /* yields nothing */ }

/** A run whose projections never produce anything — the silence CloudFront kills. */
const silentRun = () => ({
    messages: empty(),
    toolCalls: empty(),
    subagents: empty(),
    values: empty(),
    interrupted: false,
    [Symbol.asyncIterator]: empty,
});

function collect(stream: ReadableStream, chunks: unknown[]) {
    const reader = stream.getReader();
    void (async () => {
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) return;
                chunks.push(value);
            }
        } catch { /* cancelled */ }
    })();
}

afterEach(() => vi.useRealTimers());

describe('deep-stream keep-alive', () => {
    it('emits keep-alive chunks while the run is silent, so CloudFront cannot time out', async () => {
        vi.useFakeTimers();
        const chunks: any[] = [];
        const stream = processDeepStream({
            run: silentRun() as never,
            threadId: 't1',
            releaseLock: () => { },
            getInterruptState: () => never(),   // hold the run open, like a working sub-agent
        });
        collect(stream, chunks);

        await vi.advanceTimersByTimeAsync(46_000);   // three 15s ticks, still under 60s
        const keepalives = chunks.filter(c => c?.type === 'data-keepalive');
        expect(keepalives.length).toBeGreaterThanOrEqual(3);
    });

    it('marks keep-alives transient so they never reach message.parts or the run rail', async () => {
        vi.useFakeTimers();
        const chunks: any[] = [];
        const stream = processDeepStream({
            run: silentRun() as never,
            threadId: 't2',
            releaseLock: () => { },
            getInterruptState: () => never(),
        });
        collect(stream, chunks);

        await vi.advanceTimersByTimeAsync(16_000);
        const keepalive = chunks.find(c => c?.type === 'data-keepalive');
        expect(keepalive).toBeDefined();
        expect(keepalive.transient).toBe(true);
    });

    it('stops ticking once the run finishes — no interval leaks past the stream', async () => {
        vi.useFakeTimers();
        const chunks: any[] = [];
        const stream = processDeepStream({
            run: silentRun() as never,
            threadId: 't3',
            releaseLock: () => { },
            getInterruptState: async () => ({ tasks: [] }),   // resolves: the run completes
        });
        collect(stream, chunks);

        await vi.advanceTimersByTimeAsync(100);              // let the run finish
        const afterFinish = chunks.filter(c => c?.type === 'data-keepalive').length;
        await vi.advanceTimersByTimeAsync(60_000);           // four more ticks would have fired
        expect(chunks.filter(c => c?.type === 'data-keepalive').length).toBe(afterFinish);
    });
});
