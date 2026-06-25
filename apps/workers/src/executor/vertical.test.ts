import { describe, it, expect, vi } from 'vitest';
import { VerticalExecutor } from './vertical.js';

describe('VerticalExecutor', () => {
    it('calls registered handler with jobData', async () => {
        const executor = new VerticalExecutor();
        const handler = vi.fn().mockResolvedValue(undefined);
        executor.registerHandler('test-job', handler);
        await executor.execute('test-job', { foo: 'bar' });
        expect(handler).toHaveBeenCalledWith({ foo: 'bar' });
    });

    it('throws when no handler registered for jobName', async () => {
        const executor = new VerticalExecutor();
        await expect(executor.execute('unknown-job', {})).rejects.toThrow(
            'No handler registered for job: unknown-job'
        );
    });

    it('propagates handler errors without wrapping', async () => {
        const executor = new VerticalExecutor();
        executor.registerHandler('failing-job', async () => {
            throw new Error('handler error');
        });
        await expect(executor.execute('failing-job', {})).rejects.toThrow('handler error');
    });

    it('overwrites handler when registered twice for same jobName', async () => {
        const executor = new VerticalExecutor();
        const first = vi.fn().mockResolvedValue(undefined);
        const second = vi.fn().mockResolvedValue(undefined);
        executor.registerHandler('my-job', first);
        executor.registerHandler('my-job', second);
        await executor.execute('my-job', { x: 1 });
        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalledWith({ x: 1 });
    });
});
