import { describe, it, expect } from 'vitest';
import { Semaphore } from './concurrency';

const defer = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(r => { resolve = r; });
    return { promise, resolve };
};

describe('Semaphore', () => {
    it('never runs more than `limit` tasks at once', async () => {
        const sem = new Semaphore(2);
        let active = 0;
        let peak = 0;

        const task = async () => sem.run(async () => {
            active++;
            peak = Math.max(peak, active);
            await new Promise(r => setTimeout(r, 5));
            active--;
        });

        await Promise.all(Array.from({ length: 10 }, task));

        expect(peak).toBe(2);
        expect(active).toBe(0);
    });

    it('releases the slot when a task throws', async () => {
        const sem = new Semaphore(1);

        await expect(sem.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');

        // If the slot leaked, this would hang rather than resolve.
        await expect(sem.run(async () => 'ok')).resolves.toBe('ok');
    });

    it('queues callers beyond the limit and runs them as slots free', async () => {
        const sem = new Semaphore(1);
        const first = defer();
        const order: string[] = [];

        const a = sem.run(async () => { order.push('a-start'); await first.promise; order.push('a-end'); });
        const b = sem.run(async () => { order.push('b-start'); });

        expect(order).toEqual(['a-start']);
        first.resolve();
        await Promise.all([a, b]);
        expect(order).toEqual(['a-start', 'a-end', 'b-start']);
    });

    it('treats a limit below 1 as 1', async () => {
        const sem = new Semaphore(0);
        await expect(sem.run(async () => 'ok')).resolves.toBe('ok');
    });
});
