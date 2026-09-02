import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryRawMock = vi.hoisted(() => vi.fn());
const executeRawMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db/pg-config', () => ({
    getPrismaClient: () => ({ $queryRaw: queryRawMock, $executeRaw: executeRawMock }),
}));

import { acquireThreadLock, releaseThreadLock } from './thread-lock';

describe('acquireThreadLock', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns a holder token when the insert/reclaim returns a row', async () => {
        queryRawMock.mockResolvedValue([{ threadId: 'thread-1' }]);
        const token = await acquireThreadLock('thread-1');
        expect(token).toEqual(expect.any(String));
        expect(token!.length).toBeGreaterThan(0);
    });

    it('scopes the lock query to the given threadId', async () => {
        queryRawMock.mockResolvedValue([{ threadId: 'thread-1' }]);
        await acquireThreadLock('thread-1');
        const templateParts = queryRawMock.mock.calls[0];
        expect(templateParts).toContain('thread-1');
    });

    it('returns null when another live request already holds the lock', async () => {
        queryRawMock.mockResolvedValue([]);
        const token = await acquireThreadLock('thread-1');
        expect(token).toBeNull();
    });

    it('fails open (returns a token) and logs when the lock table is unavailable', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        queryRawMock.mockRejectedValue(new Error('relation does not exist'));

        const token = await acquireThreadLock('thread-1');

        expect(token).toEqual(expect.any(String));
        expect(errorSpy).toHaveBeenCalledWith('[thread-lock] acquire failed, proceeding without lock:', expect.any(Error));
        errorSpy.mockRestore();
    });
});

describe('releaseThreadLock', () => {
    beforeEach(() => vi.clearAllMocks());

    it('deletes the lock row scoped to threadId and holder token', async () => {
        executeRawMock.mockResolvedValue(1);
        await releaseThreadLock('thread-1', 'token-abc');
        const templateParts = executeRawMock.mock.calls[0];
        expect(templateParts).toContain('thread-1');
        expect(templateParts).toContain('token-abc');
    });

    it('logs but does not throw when the delete fails', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        executeRawMock.mockRejectedValue(new Error('connection lost'));

        await expect(releaseThreadLock('thread-1', 'token-abc')).resolves.toBeUndefined();
        expect(errorSpy).toHaveBeenCalledWith('[thread-lock] release failed (lock will expire via TTL):', expect.any(Error));
        errorSpy.mockRestore();
    });
});
