import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withCloudTrailRetry } from './cloudtrail-retry.js';

describe('withCloudTrailRetry', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('returns the result on the first try when nothing throws', async () => {
        const fn = vi.fn().mockResolvedValue('ok');
        await expect(withCloudTrailRetry(fn)).resolves.toBe('ok');
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('retries on CloudTrail\'s own throttling message ("Rate exceeded") and succeeds once it clears', async () => {
        const fn = vi.fn().mockRejectedValueOnce(new Error('Rate exceeded')).mockResolvedValueOnce('ok');
        const promise = withCloudTrailRetry(fn);
        await vi.runAllTimersAsync();
        await expect(promise).resolves.toBe('ok');
        expect(fn).toHaveBeenCalledTimes(2);
    });

    it('also retries the AWS SDK\'s generic throttling markers', async () => {
        const fn = vi.fn().mockRejectedValueOnce(new Error('ThrottlingException: slow down')).mockResolvedValueOnce('ok');
        const promise = withCloudTrailRetry(fn);
        await vi.runAllTimersAsync();
        await expect(promise).resolves.toBe('ok');
        expect(fn).toHaveBeenCalledTimes(2);
    });

    it('rethrows immediately on a non-throttling error — no retry, no delay', async () => {
        const fn = vi.fn().mockRejectedValue(new Error('AccessDenied: not authorized'));
        await expect(withCloudTrailRetry(fn)).rejects.toThrow('AccessDenied');
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('gives up and rethrows after maxRetries consecutive throttles', async () => {
        const fn = vi.fn().mockRejectedValue(new Error('Rate exceeded'));
        const promise = withCloudTrailRetry(fn, { maxRetries: 3, baseDelayMs: 10 });
        // Attach a rejection handler up front so the eventual rejection is
        // never "unhandled" while fake timers advance the retry loop.
        const assertion = expect(promise).rejects.toThrow('Rate exceeded');
        await vi.runAllTimersAsync();
        await assertion;
        expect(fn).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
    });

    it('honors a custom maxRetries of 0 — no retry at all', async () => {
        const fn = vi.fn().mockRejectedValue(new Error('Rate exceeded'));
        await expect(withCloudTrailRetry(fn, { maxRetries: 0 })).rejects.toThrow('Rate exceeded');
        expect(fn).toHaveBeenCalledTimes(1);
    });
});
